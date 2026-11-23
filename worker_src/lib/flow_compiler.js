// worker_src/lib/flow_compiler.js
// 發布前檢查 + 編譯：把設計器的 flow（nodes/edges）轉成執行器要的精簡格式。純函式。
//
// 錯誤格式 { nodeId, message }，讓設計器能指出是哪個節點有問題。

import { validateFlow } from '../../js/shared/flow_schema.js';
import { runFrom, MAX_REPLY_MESSAGES, MAX_DELAY_SECONDS } from './flow_runtime.js';
import { validateApiNode, MAX_API_CALLS } from './flow_api.js';

const SUPPORTED = new Set([
    'keyword', 'richmenu',
    'message_text', 'message_image', 'message_flex', 'message_imagemap', 'message_sequence',
    'action_tag', 'action_condition', 'action_delay', 'action_api', 'url', 'postback', 'end',
]);

const UNSUPPORTED_LABEL = {
    webhook: 'Webhook',
};

const isHttps = (u) => /^https:\/\//i.test(String(u || ''));
const CONDITION_FIELDS = ['text', 'userId', 'tag'];

/** 只留執行需要的欄位，避免把整份設計器資料（含預覽圖等）塞進 KV */
function pickData(type, d = {}) {
    switch (type) {
        case 'keyword': return { keyword: d.keyword, matchType: d.matchType };
        case 'message_text': return { text: d.text, quickReplyId: d.quickReplyId };
        case 'message_image': return { url: d.url, previewUrl: d.previewUrl, quickReplyId: d.quickReplyId };
        case 'message_sequence': return { messages: d.messages, quickReplyId: d.quickReplyId };
        case 'message_flex': return { contents: d.contents, altText: d.altText, title: d.title, quickReplyId: d.quickReplyId };
        case 'message_imagemap': return { baseUrl: d.baseUrl, baseSize: d.baseSize, actions: d.actions, altText: d.altText, title: d.title, quickReplyId: d.quickReplyId };
        case 'action_condition': return { conditions: d.conditions };
        case 'action_delay': return { seconds: d.seconds };
        case 'action_api': return { url: d.url, method: d.method, headers: d.headers, body: d.body };
        case 'action_tag': return { operation: d.operation, tags: d.tags };
        case 'url': return { url: d.url };
        case 'postback': return { data: d.data };
        default: return {};
    }
}

function nodeProblem(node) {
    const d = node.data || {};
    switch (node.type) {
        case 'keyword':
            if (!String(d.keyword || '').trim()) return '關鍵字是空的';
            if (d.matchType && !['exact', 'contains'].includes(d.matchType)) return '比對方式只支援「完全符合」與「包含」';
            return null;
        case 'message_text':
            return String(d.text || '').trim() ? null : '文字訊息是空的';
        case 'message_image':
            if (!isHttps(d.url)) return '圖片網址必須以 https:// 開頭';
            if (d.previewUrl && !isHttps(d.previewUrl)) return '預覽圖網址必須以 https:// 開頭';
            return null;
        case 'message_sequence': {
            const msgs = Array.isArray(d.messages) ? d.messages : [];
            if (!msgs.some((m) => m && ((m.type === 'text' && m.text) || (m.type === 'image' && m.url)))) return '訊息序列沒有可發送的訊息';
            if (msgs.some((m) => m && m.type === 'image' && !isHttps(m.url))) return '序列裡的圖片網址必須以 https:// 開頭';
            return null;
        }
        case 'action_condition': {
            const list = Array.isArray(d.conditions) ? d.conditions : [];
            if (!list.length) return '條件判斷沒有設定條件';
            for (const c of list) {
                if (!c || !CONDITION_FIELDS.includes(c.field)) return '條件的欄位只支援：文字內容、使用者 ID、標籤';
                if (c.operator === 'regex') return '條件不支援「正則匹配」，請改用「等於」或「包含」';
                if (!['equals', 'contains'].includes(c.operator)) return '條件的比對方式只支援「等於」與「包含」';
                if (!String(c.value || '').trim()) return '條件的值是空的';
            }
            return null;
        }
        case 'action_delay': {
            const sec = Number(d.seconds);
            return Number.isInteger(sec) && sec >= 1 && sec <= MAX_DELAY_SECONDS ? null : `延遲秒數必須是 1 到 ${MAX_DELAY_SECONDS} 之間的整數`;
        }
        case 'action_api':
            return validateApiNode(d);
        case 'message_flex':
            return d.contents ? null : '尚未選擇 Flex 訊息';
        case 'message_imagemap':
            return (d.baseUrl && Array.isArray(d.actions)) ? null : '尚未選擇 Imagemap';
        case 'action_tag':
            return (Array.isArray(d.tags) && d.tags.some((t) => String(t).trim())) ? null : '標籤節點沒有設定標籤';
        case 'url':
            return /^https?:\/\//i.test(String(d.url || '')) ? null : '網址必須以 http:// 或 https:// 開頭';
        default:
            return null;
    }
}

/**
 * @param {{id?: string, name?: string, nodes: object[], edges: object[]}} flow
 * @returns {{ok: true, published: object, warnings: string[]} | {ok: false, errors: {nodeId: string|null, message: string}[]}}
 */
export function compileFlow(flow, { botId = null, now = new Date().toISOString() } = {}) {
    const schema = validateFlow(flow);
    if (!schema.ok) return { ok: false, errors: schema.errors.map((message) => ({ nodeId: null, message })) };

    const errors = [];
    const warnings = [];
    const nodes = {};
    for (const n of flow.nodes) nodes[n.id] = { type: n.type, data: pickData(n.type, n.data) };

    const edges = {};
    for (const e of flow.edges) {
        (edges[e.source] = edges[e.source] || []).push({ handle: e.sourceHandle || 'default', target: e.target });
    }

    const triggers = flow.nodes
        .filter((n) => n.type === 'keyword')
        .map((n) => ({
            nodeId: n.id,
            keyword: String((n.data || {}).keyword || '').trim(),
            matchType: (n.data || {}).matchType === 'contains' ? 'contains' : 'exact',
        }));

    if (!triggers.length) errors.push({ nodeId: null, message: '至少需要一個「關鍵字觸發」節點' });

    // 只檢查從觸發點走得到的節點；沒接上的節點不影響執行，只提醒
    const reachable = new Set();
    const walk = (id, trail) => {
        if (trail.has(id)) { errors.push({ nodeId: id, message: '流程有循環' }); return; }
        if (reachable.has(id)) return;
        reachable.add(id);
        const next = new Set(trail).add(id);
        for (const e of edges[id] || []) walk(e.target, next);
    };
    triggers.forEach((t) => walk(t.nodeId, new Set()));

    const seen = new Map();
    for (const t of triggers) {
        for (const kw of t.keyword.split(/[,，]/).map((k) => k.trim().toLowerCase()).filter(Boolean)) {
            if (seen.has(kw)) errors.push({ nodeId: t.nodeId, message: `關鍵字「${kw}」重複` });
            seen.set(kw, t.nodeId);
        }
    }

    for (const n of flow.nodes) {
        if (!reachable.has(n.id)) {
            if (!['richmenu'].includes(n.type)) warnings.push(`節點「${(n.data && n.data.label) || n.type}」沒有接到任何觸發，不會執行`);
            continue;
        }
        if (UNSUPPORTED_LABEL[n.type]) {
            errors.push({ nodeId: n.id, message: `「${UNSUPPORTED_LABEL[n.type]}」節點目前還不能執行，請移除` });
        } else if (!SUPPORTED.has(n.type)) {
            errors.push({ nodeId: n.id, message: `不支援的節點類型 ${n.type}` });
        } else {
            const problem = nodeProblem(n);
            if (problem) errors.push({ nodeId: n.id, message: problem });
        }
    }

    if (errors.length) return { ok: false, errors };

    const published = {
        version: 1,
        flowId: flow.id || null,
        name: flow.name || '未命名流程',
        botId,
        publishedAt: now,
        triggers,
        nodes,
        edges,
    };

    // 單次回覆最多 5 則：每個觸發與每個按鈕的結果都試跑一次
    // 條件節點的連線必須從「是 / 否」輸出口出發，否則執行時不會被選中
    for (const n of flow.nodes) {
        if (n.type !== 'action_condition' || !reachable.has(n.id)) continue;
        if ((edges[n.id] || []).some((e) => e.handle !== 'true' && e.handle !== 'false')) {
            errors.push({ nodeId: n.id, message: '條件判斷的連線請從「是」或「否」輸出口拉出' });
        }
    }
    if (errors.length) return { ok: false, errors };

    // 單次回覆最多 5 則、API 呼叫有上限：每個觸發、按鈕、延遲之後的內容都試跑一次
    // （條件節點在檢查模式兩條分支都走，所以最壞情況都會被檢查到）
    const starts = [
        ...triggers.map((t) => ({ nodeId: t.nodeId, label: `關鍵字「${t.keyword}」`, ids: (edges[t.nodeId] || []).map((e) => e.target), isTrigger: true })),
        ...flow.edges
            .filter((e) => e.sourceHandle && /^(button|action)_\d+$/.test(e.sourceHandle) && reachable.has(e.source))
            .map((e) => ({ nodeId: e.source, label: '按鈕', ids: [e.target] })),
        ...flow.nodes
            .filter((n) => n.type === 'action_delay' && reachable.has(n.id))
            .map((n) => ({ nodeId: n.id, label: '延遲之後', ids: (edges[n.id] || []).map((e) => e.target) })),
    ];
    for (const s of starts) {
        const r = runFrom(published, s.ids, null);
        if (r.loop) errors.push({ nodeId: s.nodeId, message: `${s.label}的流程太長或有循環` });
        else if (r.truncated) errors.push({ nodeId: s.nodeId, message: `${s.label}一次會回覆超過 ${MAX_REPLY_MESSAGES} 則訊息（LINE 上限）` });
        else if (r.apiCalls.length > MAX_API_CALLS) errors.push({ nodeId: s.nodeId, message: `${s.label}一次最多只能呼叫 ${MAX_API_CALLS} 次 API` });
        else if (s.isTrigger && !r.messages.length && !r.tags.add.length && !r.tags.remove.length && !r.deferred.length) {
            warnings.push(`${s.label}沒有接任何回覆`);
        }
    }

    const has = (type) => flow.nodes.some((n) => n.type === type && reachable.has(n.id));
    if (has('action_delay')) {
        warnings.push('延遲之後的訊息會用「推播」送出，計入 LINE 官方帳號的每月訊息額度；實際送出時間可能比設定晚約 1 分鐘');
    }
    if (has('action_api')) {
        warnings.push('API 節點的網址與標頭會存在流程中，有權限的團隊成員看得到，請不要放長期有效的重要金鑰');
    }

    return errors.length ? { ok: false, errors } : { ok: true, published, warnings };
}
