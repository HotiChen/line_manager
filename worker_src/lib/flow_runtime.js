// worker_src/lib/flow_runtime.js
// 已發布 flow 的執行器：純函式，不碰 KV / LINE API（由 event_handler 負責收發）。
//
// 已發布格式（由 flow_compiler.js 產生）：
//   { version, flowId, triggers: [{nodeId, keyword, matchType}],
//     nodes: { [id]: {type, data} }, edges: { [sourceId]: [{handle, target}] } }
//
// 執行規則：
//   - 觸發（關鍵字 / 按鈕）→ 從該節點的下游開始，沿 default 連線依序收集訊息
//   - 訊息節點加入回覆；Flex / Imagemap 是互動節點，收集後停止（後續由按鈕觸發）
//   - 標籤節點收集標籤動作；結束節點停止
//   - LINE 一次回覆最多 5 則，超過的截斷並標記 truncated

export const MAX_REPLY_MESSAGES = 5;
export const MAX_STEPS = 50;
export const POSTBACK_PREFIX = 'flow:';

/** 這些節點會產生一則回覆訊息 */
const MESSAGE_TYPES = new Set(['message_text', 'message_flex', 'message_imagemap', 'message_sequence']);
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

/** 節點 → LINE 訊息（Flex 的按鈕在這裡改寫成 flow postback）；不能轉換回 null */
export function nodeToMessages(published, nodeId) {
    const node = published.nodes[nodeId];
    if (!node) return [];
    const d = node.data || {};

    switch (node.type) {
        case 'message_text':
            return d.text ? [{ type: 'text', text: d.text }] : [];

        case 'message_sequence':
            return (Array.isArray(d.messages) ? d.messages : [])
                .filter((m) => m && m.type === 'text' && m.text)
                .map((m) => ({ type: 'text', text: m.text }));

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
 *   目標是 URL 節點 → uri 動作；目標是會回覆的節點 → postback（帶 flow 資訊）
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
 * @returns {{messages: object[], tags: {add: string[], remove: string[]}, truncated: boolean, loop: boolean}}
 */
export function runFrom(published, startIds) {
    const messages = [];
    const tags = { add: [], remove: [] };
    let truncated = false;
    let loop = false;
    let steps = 0;
    const visited = new Set();

    const visit = (nodeId) => {
        if (truncated || loop) return;
        if (visited.has(nodeId) || ++steps > MAX_STEPS) { loop = true; return; }
        visited.add(nodeId);

        const node = published.nodes[nodeId];
        if (!node) return;

        if (MESSAGE_TYPES.has(node.type)) {
            for (const m of nodeToMessages(published, nodeId)) {
                if (messages.length >= MAX_REPLY_MESSAGES) { truncated = true; return; }
                messages.push(m);
            }
            if (INTERACTIVE_TYPES.has(node.type)) return; // 後續由按鈕觸發
        } else if (node.type === 'action_tag') {
            const list = Array.isArray(node.data && node.data.tags) ? node.data.tags : [];
            const clean = list.map((t) => String(t).trim()).filter(Boolean);
            (node.data.operation === 'remove' ? tags.remove : tags.add).push(...clean);
        } else if (node.type === 'end') {
            return;
        }
        // keyword / richmenu 等觸發節點被當成跳轉點：繼續走下游

        for (const next of targetsOf(published, nodeId)) visit(next);
    };

    for (const id of startIds) visit(id);
    return { messages, tags, truncated, loop };
}

/** 關鍵字觸發 → 執行結果 */
export function runTrigger(published, trigger) {
    return runFrom(published, targetsOf(published, trigger.nodeId));
}

/** 按鈕 postback → 執行結果；找不到對應連線回 null */
export function runButton(published, parsed) {
    if (!published || parsed.flowId !== published.flowId) return null;
    const targets = targetsOf(published, parsed.nodeId, parsed.handle);
    if (!targets.length) return null;
    return runFrom(published, targets);
}
