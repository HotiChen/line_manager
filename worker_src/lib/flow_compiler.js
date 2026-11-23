// worker_src/lib/flow_compiler.js
// 發布前檢查 + 編譯：把設計器的 flow（nodes/edges）轉成執行器要的精簡格式。純函式。
//
// 錯誤格式 { nodeId, message }，讓設計器能指出是哪個節點有問題。

import { validateFlow } from '../../js/shared/flow_schema.js';
import { runFrom, MAX_REPLY_MESSAGES } from './flow_runtime.js';

const SUPPORTED = new Set([
    'keyword', 'richmenu',
    'message_text', 'message_flex', 'message_imagemap', 'message_sequence',
    'action_tag', 'url', 'postback', 'end',
]);

const UNSUPPORTED_LABEL = {
    action_delay: '延遲',
    action_condition: '條件判斷',
    action_api: '呼叫 API',
    message_image: '圖片訊息',
    webhook: 'Webhook',
};

/** 只留執行需要的欄位，避免把整份設計器資料（含預覽圖等）塞進 KV */
function pickData(type, d = {}) {
    switch (type) {
        case 'keyword': return { keyword: d.keyword, matchType: d.matchType };
        case 'message_text': return { text: d.text };
        case 'message_sequence': return { messages: d.messages };
        case 'message_flex': return { contents: d.contents, altText: d.altText, title: d.title };
        case 'message_imagemap': return { baseUrl: d.baseUrl, baseSize: d.baseSize, actions: d.actions, altText: d.altText, title: d.title };
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
        case 'message_sequence':
            return (Array.isArray(d.messages) && d.messages.some((m) => m && m.type === 'text' && m.text))
                ? null : '訊息序列沒有可發送的文字訊息';
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
    const starts = [
        ...triggers.map((t) => ({ nodeId: t.nodeId, label: `關鍵字「${t.keyword}」`, ids: (edges[t.nodeId] || []).map((e) => e.target) })),
        ...flow.edges
            .filter((e) => e.sourceHandle && /^(button|action)_\d+$/.test(e.sourceHandle) && reachable.has(e.source))
            .map((e) => ({ nodeId: e.source, label: '按鈕', ids: [e.target] })),
    ];
    for (const s of starts) {
        const r = runFrom(published, s.ids);
        if (r.loop) errors.push({ nodeId: s.nodeId, message: `${s.label}的流程太長或有循環` });
        else if (r.truncated) errors.push({ nodeId: s.nodeId, message: `${s.label}一次會回覆超過 ${MAX_REPLY_MESSAGES} 則訊息（LINE 上限）` });
        else if (!r.messages.length && !r.tags.add.length && !r.tags.remove.length && s.label.startsWith('關鍵字')) {
            warnings.push(`${s.label}沒有接任何回覆`);
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true, published, warnings };
}
