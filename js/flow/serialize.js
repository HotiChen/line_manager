// js/flow/serialize.js
// 記憶體中的 flow ↔ 存檔 / 匯出 / 草稿 格式。純函式；storage 由呼叫端注入（localStorage 或測試替身）。

import { validateFlow, pruneDanglingEdges, normalizeFlowName } from '../shared/flow_schema.js';

/** 舊版只有一份草稿，所有 bot 共用 */
export const LEGACY_DRAFT_KEY = 'flow_designer_draft';

export function draftKey(bot) {
    return `${LEGACY_DRAFT_KEY}:${bot || 'default'}`;
}

/** 去掉執行期欄位：node.config（由類型推得）與任何 `_` 開頭的欄位（例如 edge._abortController） */
function stripRuntime(obj, extra = []) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (k.startsWith('_') || extra.includes(k)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * 存檔 / 匯出 / 快照用：深拷貝、去執行期欄位、清掉懸空連線
 * @returns {{nodes: object[], edges: object[]}}
 */
export function toPersisted({ nodes = [], edges = [] } = {}) {
    const cleanNodes = nodes.map((n) => stripRuntime(n, ['config']));
    const cleanEdges = pruneDanglingEdges(cleanNodes, edges).map((e) => stripRuntime(e));
    return JSON.parse(JSON.stringify({ nodes: cleanNodes, edges: cleanEdges }));
}

/** 載入後把 node.config 補回來（renderNode 需要）；未知類型保留原 config */
export function hydrateNodes(nodes = [], typeConfig = {}) {
    return nodes.map((n) => ({ ...n, config: typeConfig[n.type] || n.config }));
}

/**
 * 解析匯入的 JSON 文字
 * @returns {{ok: true, flow: {name, nodes, edges}} | {ok: false, errors: string[]}}
 */
export function parseImport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return { ok: false, errors: ['不是有效的 JSON'] };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, errors: ['格式錯誤：最外層必須是物件'] };
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const flow = {
        name: normalizeFlowName(data.name),
        nodes,
        edges: pruneDanglingEdges(nodes, Array.isArray(data.edges) ? data.edges : []),
    };
    const { ok, errors } = validateFlow(flow);
    return ok ? { ok: true, flow } : { ok: false, errors };
}

// ── 草稿（每個 bot 一份） ─────────────────────────

function safeGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
}

/**
 * 讀草稿；新 key 沒有時讀一次舊的共用 key（讀到後搬過來並刪掉，避免被別的 bot 再讀到）
 * @returns {{nodes, edges, flowId, flowName} | null}
 */
export function readDraft(storage, bot) {
    const key = draftKey(bot);
    let raw = safeGet(storage, key);
    if (!raw) {
        raw = safeGet(storage, LEGACY_DRAFT_KEY);
        if (raw) {
            try {
                storage.setItem(key, raw);
                storage.removeItem(LEGACY_DRAFT_KEY);
            } catch { /* storage 不可用時只讀不搬 */ }
        }
    }
    if (!raw) return null;
    try {
        const d = JSON.parse(raw);
        return {
            nodes: Array.isArray(d.nodes) ? d.nodes : [],
            edges: Array.isArray(d.edges) ? d.edges : [],
            flowId: d.flowId || null,
            flowName: d.flowName || '未命名流程',
        };
    } catch {
        return null;
    }
}

export function writeDraft(storage, bot, { nodes, edges, flowId, flowName }) {
    try {
        storage.setItem(draftKey(bot), JSON.stringify({ ...toPersisted({ nodes, edges }), flowId, flowName }));
        return true;
    } catch {
        return false; // 配額滿或私密模式：草稿只是便利，不影響操作
    }
}

export function clearDraft(storage, bot) {
    try { storage.removeItem(draftKey(bot)); } catch { /* ignore */ }
}
