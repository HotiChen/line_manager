// js/shared/flow_schema.js
// Flow 資料格式（前後端共用）：純函式、不碰 DOM、不碰 KV。
//
// 後端 handler/flow.js 存檔前一律驗證；前端之後（Phase 1 的 flow_store）也用同一份。
// 格式：{ name, nodes: [{ id, type, position: {x, y}, data? }], edges: [{ id?, source, target, sourceHandle?, targetHandle? }] }

/** 所有合法的節點類型（與 js/flow_designer.js 的 NodeTypes 對齊） */
export const FLOW_NODE_TYPES = Object.freeze([
    'richmenu', 'keyword', 'webhook',
    'message_text', 'message_flex', 'message_imagemap', 'message_image', 'message_sequence',
    'action_delay', 'action_condition', 'action_api', 'action_tag',
    'url', 'postback', 'end',
]);

export const FLOW_LIMITS = Object.freeze({
    maxNodes: 200,
    maxEdges: 1000,
    maxNameLength: 100,
});

/** flowId / nodeId 只允許安全字元：它們會進 KV key 與 DOM id */
export const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const NODE_TYPE_SET = new Set(FLOW_NODE_TYPES);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isOptionalHandle(v) {
    return v === undefined || v === null || typeof v === 'string';
}

/**
 * 驗證 flow 的 nodes / edges。
 *
 * @param {{nodes?: unknown, edges?: unknown}} flow
 * @returns {{ok: boolean, errors: string[]}} 只回報，不修改輸入
 */
export function validateFlow(flow) {
    const errors = [];
    if (!isPlainObject(flow)) return { ok: false, errors: ['flow must be an object'] };

    const nodes = flow.nodes ?? [];
    const edges = flow.edges ?? [];

    if (!Array.isArray(nodes)) errors.push('nodes must be an array');
    if (!Array.isArray(edges)) errors.push('edges must be an array');
    if (errors.length) return { ok: false, errors };

    if (nodes.length > FLOW_LIMITS.maxNodes) errors.push(`Too many nodes (max ${FLOW_LIMITS.maxNodes})`);
    if (edges.length > FLOW_LIMITS.maxEdges) errors.push(`Too many edges (max ${FLOW_LIMITS.maxEdges})`);
    if (errors.length) return { ok: false, errors };

    const ids = new Set();
    nodes.forEach((node, i) => {
        if (!isPlainObject(node)) {
            errors.push(`nodes[${i}] must be an object`);
            return;
        }
        if (typeof node.id !== 'string' || !FLOW_ID_PATTERN.test(node.id)) {
            errors.push(`nodes[${i}].id is invalid`);
        } else if (ids.has(node.id)) {
            errors.push(`nodes[${i}].id is duplicated`);
        } else {
            ids.add(node.id);
        }
        if (!NODE_TYPE_SET.has(node.type)) errors.push(`nodes[${i}].type is unknown`);
        const p = node.position;
        if (!isPlainObject(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            errors.push(`nodes[${i}].position must be {x, y} numbers`);
        }
        if (node.data !== undefined && !isPlainObject(node.data)) {
            errors.push(`nodes[${i}].data must be an object`);
        }
    });

    edges.forEach((edge, i) => {
        if (!isPlainObject(edge)) {
            errors.push(`edges[${i}] must be an object`);
            return;
        }
        if (!ids.has(edge.source)) errors.push(`edges[${i}].source does not match a node`);
        if (!ids.has(edge.target)) errors.push(`edges[${i}].target does not match a node`);
        if (edge.source === edge.target) errors.push(`edges[${i}] connects a node to itself`);
        if (!isOptionalHandle(edge.sourceHandle) || !isOptionalHandle(edge.targetHandle)) {
            errors.push(`edges[${i}] handles must be strings`);
        }
    });

    return { ok: errors.length === 0, errors };
}

/** 存檔前清掉指向不存在節點的連線（舊資料可能殘留），回傳新陣列 */
export function pruneDanglingEdges(nodes, edges) {
    const ids = new Set((nodes || []).map((n) => n && n.id));
    return (edges || []).filter((e) => e && ids.has(e.source) && ids.has(e.target));
}

/** 名稱：去 HTML 標籤、去頭尾空白、截長；空的給預設值 */
export function normalizeFlowName(name) {
    const clean = (typeof name === 'string' ? name : '').replace(/<[^>]*>/g, '').trim();
    return clean.slice(0, FLOW_LIMITS.maxNameLength) || '未命名流程';
}
