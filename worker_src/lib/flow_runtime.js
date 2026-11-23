// worker_src/lib/flow_runtime.js
// 已發布 flow 的執行器：純函式、同步，不碰 KV / LINE API / 網路（由 flow_dispatch 負責）。
//
// 已發布格式（由 flow_compiler.js 產生）：
//   { version, flowId, triggers: [{nodeId, keyword, matchType}],
//     nodes: { [id]: {type, data} }, edges: { [sourceId]: [{handle, target}] } }
//
// 執行規則：
//   - 觸發（關鍵字 / 按鈕）→ 從該節點的下游開始，沿連線依序收集訊息
//   - 訊息節點加入回覆；Flex / Imagemap 是互動節點，收集後停止（後續由按鈕觸發）
//   - 條件節點依 ctx 選 true / false 分支（ctx 為 null = 檢查模式，兩條都走）
//   - 延遲節點不往下走，記成 deferred（外層排程，時間到再用 push 繼續）
//   - API 節點記成 apiCalls（外層執行並把結果變成 (@api.xxx) 變數），不能用結果做分支
//   - 標籤節點收集標籤動作；結束節點停止
//   - LINE 一次回覆最多 5 則，超過的截斷並標記 truncated

import { LINE_MAX_MESSAGES } from '../../js/shared/message_core.js';

export const MAX_REPLY_MESSAGES = LINE_MAX_MESSAGES;
export const MAX_STEPS = 50;
export const POSTBACK_PREFIX = 'flow:';
export const MAX_DELAY_SECONDS = 24 * 60 * 60;

/** 這些節點會產生回覆訊息 */
const MESSAGE_TYPES = new Set(['message_text', 'message_image', 'message_flex', 'message_imagemap', 'message_sequence']);
/** 互動節點：按鈕由使用者點選才會繼續 */
const INTERACTIVE_TYPES = new Set(['message_flex', 'message_imagemap']);

export function buttonPostbackData(flowId, nodeId, handle) {
    return `${POSTBACK_PREFIX}${flowId}:${nodeId}:${handle}`;
}

/** @returns {{flowId, nodeId, handle}|null} 不是 flow postback 或格式不對回 null */
export function parseFlowPostback(data) {
    if (typeof data !== 'string' || !data.startsWith(POSTBACK_PREFIX)) return null;
    const parts = data.slice(POSTBACK_PREFIX.length).split(':');
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    return { flowId: parts[0], nodeId: parts[1], handle: parts[2] };
}

/** 文字比對：exact（逗號可分隔多個關鍵字，不分大小寫）與 contains；regex 不支援 */
export function findTrigger(published, text) {
    const msg = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!msg || !published || !Array.isArray(published.triggers)) return null;

    for (const trigger of published.triggers) {
        const keywords = String(trigger.keyword || '').split(/[,，]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
        const hit = trigger.matchType === 'contains'
            ? keywords.some((k) => msg.includes(k))
            : keywords.includes(msg);
        if (hit) return trigger;
    }
    return null;
}

function targetsOf(published, nodeId, handle = null) {
    const list = (published.edges && published.edges[nodeId]) || [];
    return list.filter((e) => handle === null || e.handle === handle).map((e) => e.target);
}

/** 條件節點：所有條件都成立才是 true（AND）。欄位：text / userId / tag；比對：equals / contains */
export function evaluateConditions(conditions, ctx) {
    if (!Array.isArray(conditions) || !conditions.length) return false;
    const norm = (v) => String(v ?? '').trim().toLowerCase();

    return conditions.every((c) => {
        const expected = norm(c && c.value);
        if (!expected) return false;
        const test = (actual) => (c.operator === 'contains' ? norm(actual).includes(expected)
            : c.operator === 'equals' ? norm(actual) === expected
                : false); // regex 等其他比對不支援（發布時就會被擋）

        switch (c.field) {
            case 'text': return test(ctx.text);
            case 'userId': return test(ctx.userId);
            case 'tag': return (ctx.tags || []).some((t) => test(t));
            default: return false;
        }
    });
}

function imageMessage(url, previewUrl) {
    return url ? { type: 'image', originalContentUrl: url, previewImageUrl: previewUrl || url } : null;
}

/** 節點 → LINE 訊息（Flex 的按鈕在這裡改寫成 flow postback）；不能轉換回空陣列 */
export function nodeToMessages(published, nodeId) {
    const node = published.nodes[nodeId];
    if (!node) return [];
    const d = node.data || {};

    switch (node.type) {
        case 'message_text':
            return d.text ? [{ type: 'text', text: d.text }] : [];

        case 'message_image': {
            const m = imageMessage(d.url, d.previewUrl);
            return m ? [m] : [];
        }

        case 'message_sequence':
            return (Array.isArray(d.messages) ? d.messages : [])
                .map((m) => {
                    if (!m) return null;
                    if (m.type === 'text' && m.text) return { type: 'text', text: m.text };
                    if (m.type === 'image') return imageMessage(m.url, m.previewUrl);
                    return null;
                })
                .filter(Boolean);

        case 'message_flex': {
            if (!d.contents) return [];
            const contents = JSON.parse(JSON.stringify(d.contents));
            rewriteButtons(published, nodeId, contents, 'button');
            return [{ type: 'flex', altText: d.altText || d.title || '您收到了一則訊息', contents }];
        }

        case 'message_imagemap': {
            if (!d.baseUrl || !Array.isArray(d.actions)) return [];
            return [{
                type: 'imagemap',
                baseUrl: d.baseUrl,
                altText: d.altText || d.title || '您收到了一則訊息',
                baseSize: d.baseSize,
                // Imagemap 只支援 message / uri，沒辦法改寫成 postback，維持原樣
                actions: d.actions,
            }];
        }

        default:
            return [];
    }
}

/**
 * 依 extractFlexButtons 的順序（遞迴走訪、遇到 button 就編號）把「有連線」的按鈕改寫：
 *   目標是 URL 節點 → uri 動作；目標是其他節點 → postback（帶 flow 資訊）
 *   沒連線或目標是 postback 節點 → 維持原動作
 */
function rewriteButtons(published, nodeId, contents, prefix) {
    let index = 0;
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.type === 'button' && obj.action) {
            const handle = `${prefix}_${index++}`;
            const targetId = targetsOf(published, nodeId, handle)[0];
            const target = targetId && published.nodes[targetId];
            if (target) {
                const label = obj.action.label;
                if (target.type === 'url' && target.data && target.data.url) {
                    obj.action = { type: 'uri', label, uri: target.data.url };
                } else if (target.type !== 'postback') {
                    obj.action = {
                        type: 'postback',
                        label,
                        data: buttonPostbackData(published.flowId, nodeId, handle),
                    };
                }
            }
        }
        for (const key of Object.keys(obj)) {
            if (Array.isArray(obj[key])) obj[key].forEach(walk);
            else if (obj[key] && typeof obj[key] === 'object') walk(obj[key]);
        }
    };
    walk(contents);
}

/**
 * 從 startIds 開始執行
 * @param {object|null} ctx { text, userId, tags } 條件判斷用；null = 檢查模式（條件兩條分支都走）
 * @returns {{messages: object[], tags: {add: string[], remove: string[]}, quickReplyId: string|null,
 *            deferred: {seconds: number, startIds: string[]}[], apiCalls: {nodeId: string, data: object}[],
 *            truncated: boolean, loop: boolean}}
 */
export function runFrom(published, startIds, ctx = null) {
    const messages = [];
    const tags = { add: [], remove: [] };
    const deferred = [];
    const apiCalls = [];
    let quickReplyId = null;
    let truncated = false;
    let loop = false;
    let steps = 0;

    // trail = 目前這條路徑上的節點，只有「回到自己走過的路」才算循環（菱形匯流不算）
    const visit = (nodeId, trail) => {
        if (truncated || loop) return;
        if (trail.has(nodeId) || ++steps > MAX_STEPS) { loop = true; return; }

        const node = published.nodes[nodeId];
        if (!node) return;
        const nextTrail = new Set(trail).add(nodeId);
        const d = node.data || {};

        if (MESSAGE_TYPES.has(node.type)) {
            for (const m of nodeToMessages(published, nodeId)) {
                if (messages.length >= MAX_REPLY_MESSAGES) { truncated = true; return; }
                messages.push(m);
            }
            if (d.quickReplyId) quickReplyId = d.quickReplyId;
            if (INTERACTIVE_TYPES.has(node.type)) return; // 後續由按鈕觸發
        } else if (node.type === 'action_tag') {
            const clean = (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).trim()).filter(Boolean);
            (d.operation === 'remove' ? tags.remove : tags.add).push(...clean);
        } else if (node.type === 'action_api') {
            apiCalls.push({ nodeId, data: d });
        } else if (node.type === 'action_delay') {
            const seconds = Math.min(Math.max(Math.floor(Number(d.seconds) || 0), 0), MAX_DELAY_SECONDS);
            const startIds = targetsOf(published, nodeId);
            if (startIds.length) deferred.push({ seconds, startIds });
            return; // 延遲之後的內容由排程繼續
        } else if (node.type === 'action_condition') {
            if (ctx) {
                const handle = evaluateConditions(d.conditions, ctx) ? 'true' : 'false';
                for (const next of targetsOf(published, nodeId, handle)) visit(next, nextTrail);
            } else {
                for (const next of targetsOf(published, nodeId)) visit(next, nextTrail);
            }
            return;
        } else if (node.type === 'end') {
            return;
        }
        // keyword / richmenu 等觸發節點被當成跳轉點：繼續走下游

        for (const next of targetsOf(published, nodeId)) visit(next, nextTrail);
    };

    for (const id of startIds) visit(id, new Set());
    return { messages, tags, quickReplyId, deferred, apiCalls, truncated, loop };
}

/** 關鍵字觸發 → 執行結果 */
export function runTrigger(published, trigger, ctx = null) {
    return runFrom(published, targetsOf(published, trigger.nodeId), ctx);
}

/** 按鈕 postback → 執行結果；找不到對應連線回 null */
export function runButton(published, parsed, ctx = null) {
    if (!published || parsed.flowId !== published.flowId) return null;
    const targets = targetsOf(published, parsed.nodeId, parsed.handle);
    if (!targets.length) return null;
    return runFrom(published, targets, ctx);
}
