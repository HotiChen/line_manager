import { jsonResponse } from "../lib/utils.js";
import { withPermission } from "../middleware/permission.js";
import { BotKeys } from "../lib/kv_schema.js";
import { compileFlow } from "../lib/flow_compiler.js";
import {
    validateFlow,
    normalizeFlowName,
    FLOW_ID_PATTERN,
} from "../../js/shared/flow_schema.js";

// KV key 命名：flow_{userId}_{botId}_{flowId} / flow_list_{userId}_{botId}
// botId 一律由 withPermission 注入（已驗證呼叫者對該 bot 有權限），不讀請求內容。
//
// 舊資料：以前 botId 取自從未被寫入的 token_${userId}，所以實際上全部存在 "default" 底下。
// 這裡讀得到它們（list 標 legacy、get fallback），存檔時搬到目前的 bot，刪除時一併清掉。
const LEGACY_BOT = "default";
const MAX_BODY_BYTES = 1024 * 512;
const VERSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const flowKey = (userId, botId, flowId) => `flow_${userId}_${botId}_${flowId}`;
const listKey = (userId, botId) => `flow_list_${userId}_${botId}`;
const versionPrefix = (userId, botId, flowId) => `flow_version_${userId}_${botId}_${flowId}_`;

function newFlowId() {
    return `flow_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function isValidFlowId(flowId) {
    return typeof flowId === "string" && FLOW_ID_PATTERN.test(flowId);
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

async function readList(env, userId, botId) {
    const list = parseJson(await env.KV_LINE_STORAGE.get(listKey(userId, botId)), []);
    return Array.isArray(list) ? list : [];
}

async function writeList(env, userId, botId, list) {
    await env.KV_LINE_STORAGE.put(listKey(userId, botId), JSON.stringify(list));
}

async function removeFromList(env, userId, botId, flowId) {
    const list = await readList(env, userId, botId);
    if (list.includes(flowId)) {
        await writeList(env, userId, botId, list.filter((id) => id !== flowId));
    }
}

/** 先找目前 bot，再找舊 default 命名空間 */
async function readFlow(env, userId, botId, flowId) {
    const current = parseJson(await env.KV_LINE_STORAGE.get(flowKey(userId, botId, flowId)), null);
    if (current) return { flow: current, legacy: false };
    if (botId === LEGACY_BOT) return null;
    const legacy = parseJson(await env.KV_LINE_STORAGE.get(flowKey(userId, LEGACY_BOT, flowId)), null);
    return legacy ? { flow: legacy, legacy: true } : null;
}

/**
 * POST /flow/save
 * Body: { id?, name, nodes, edges }
 */
export async function handleSaveFlow(request, env, userId, botId) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
        return jsonResponse({ error: "Flow data too large (max 512KB)" }, 400);
    }

    const body = parseJson(text, null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (body.id !== undefined && body.id !== null && !isValidFlowId(body.id)) {
        return jsonResponse({ error: "Invalid flow id" }, 400);
    }

    const { ok, errors } = validateFlow(body);
    if (!ok) {
        return jsonResponse({ error: "Invalid flow data", details: errors.slice(0, 10) }, 400);
    }

    const flowId = body.id || newFlowId();
    const existing = body.id ? await readFlow(env, userId, botId, flowId) : null;
    const now = new Date().toISOString();
    const flowData = {
        id: flowId,
        name: normalizeFlowName(body.name),
        botId,
        nodes: body.nodes || [],
        edges: body.edges || [],
        updatedAt: now,
        createdAt: existing?.flow?.createdAt || now,
    };
    const serialized = JSON.stringify(flowData);

    await env.KV_LINE_STORAGE.put(flowKey(userId, botId, flowId), serialized);
    await env.KV_LINE_STORAGE.put(
        `${versionPrefix(userId, botId, flowId)}${Date.now()}`,
        serialized,
        { expirationTtl: VERSION_TTL_SECONDS },
    );

    const list = await readList(env, userId, botId);
    if (!list.includes(flowId)) {
        list.push(flowId);
        await writeList(env, userId, botId, list);
    }

    // 舊資料搬家：新位置寫好之後才刪舊的
    if (existing?.legacy) {
        await env.KV_LINE_STORAGE.delete(flowKey(userId, LEGACY_BOT, flowId));
        await removeFromList(env, userId, LEGACY_BOT, flowId);
    }

    return jsonResponse({ success: true, flowId, updatedAt: now });
}

async function summarize(env, userId, botId, ids, legacy) {
    const flows = await Promise.all(ids.map(async (id) => {
        const flow = parseJson(await env.KV_LINE_STORAGE.get(flowKey(userId, botId, id)), null);
        if (!flow) return null;
        const summary = {
            id: flow.id || id,
            name: flow.name,
            updatedAt: flow.updatedAt,
            createdAt: flow.createdAt,
            nodeCount: (flow.nodes || []).length,
            edgeCount: (flow.edges || []).length,
        };
        if (legacy) summary.legacy = true;
        return summary;
    }));
    const valid = flows.filter(Boolean);

    // 自動清理孤兒 ID
    if (valid.length !== ids.length) {
        await writeList(env, userId, botId, valid.map((f) => f.id));
    }
    return valid;
}

/**
 * GET /flow/list
 */
export async function handleListFlows(request, env, userId, botId) {
    const flows = await summarize(env, userId, botId, await readList(env, userId, botId), false);
    if (botId !== LEGACY_BOT) {
        const seen = new Set(flows.map((f) => f.id));
        const legacyIds = (await readList(env, userId, LEGACY_BOT)).filter((id) => !seen.has(id));
        if (legacyIds.length) flows.push(...await summarize(env, userId, LEGACY_BOT, legacyIds, true));
    }
    return jsonResponse({ success: true, flows });
}

/**
 * GET /flow/get/:flowId
 */
export async function handleGetFlow(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return jsonResponse({ error: "Invalid flow id" }, 400);
    const found = await readFlow(env, userId, botId, flowId);
    if (!found) return jsonResponse({ error: "Flow not found" }, 404);
    return jsonResponse({ success: true, flow: found.flow });
}

/**
 * DELETE /flow/delete/:flowId
 */
export async function handleDeleteFlow(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return jsonResponse({ error: "Invalid flow id" }, 400);

    const namespaces = botId === LEGACY_BOT ? [botId] : [botId, LEGACY_BOT];
    for (const ns of namespaces) {
        await env.KV_LINE_STORAGE.delete(flowKey(userId, ns, flowId));
        await removeFromList(env, userId, ns, flowId);
    }
    return jsonResponse({ success: true, flowId });
}

/**
 * GET /flow/versions/:flowId — 新到舊
 */
export async function handleListVersions(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return jsonResponse({ error: "Invalid flow id" }, 400);

    const prefix = versionPrefix(userId, botId, flowId);
    const list = await env.KV_LINE_STORAGE.list({ prefix });

    const versions = await Promise.all(list.keys.map(async ({ name }) => {
        const timestamp = name.slice(prefix.length);
        // 前綴會吃到 id 以本 id 開頭的其他 flow（例如 a 與 a_b），只收純數字時間戳
        if (!/^\d+$/.test(timestamp)) return null;
        const data = parseJson(await env.KV_LINE_STORAGE.get(name), null);
        if (!data) return null;
        return {
            timestamp,
            name: data.name,
            nodeCount: (data.nodes || []).length,
            updatedAt: data.updatedAt,
        };
    }));

    const sorted = versions.filter(Boolean).sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    return jsonResponse({ success: true, versions: sorted });
}

function publishedSummary(p) {
    return {
        flowId: p.flowId,
        name: p.name,
        publishedAt: p.publishedAt,
        triggerCount: (p.triggers || []).length,
        keywords: (p.triggers || []).map((t) => t.keyword),
    };
}

/**
 * POST /flow/publish/:flowId（僅 owner：會改變 bot 的實際回覆）
 * 以「已儲存」的版本為準：先檢查、編譯，通過才取代目前已發布的 flow（每個 bot 同時只有一份）。
 */
export async function handlePublishFlow(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return jsonResponse({ error: "Invalid flow id" }, 400);
    const found = await readFlow(env, userId, botId, flowId);
    if (!found) return jsonResponse({ error: "Flow not found" }, 404);

    const result = compileFlow({ ...found.flow, id: flowId }, { botId });
    if (!result.ok) {
        return jsonResponse({ error: "Flow cannot be published", errors: result.errors.slice(0, 20) }, 400);
    }

    await env.KV_LINE_STORAGE.put(BotKeys.flowPublished(botId), JSON.stringify(result.published));
    return jsonResponse({ success: true, published: publishedSummary(result.published), warnings: result.warnings });
}

/** DELETE /flow/unpublish（僅 owner）— bot 回到只用「關鍵字回覆」 */
export async function handleUnpublishFlow(request, env, userId, botId) {
    await env.KV_LINE_STORAGE.delete(BotKeys.flowPublished(botId));
    return jsonResponse({ success: true });
}

/** GET /flow/published — 目前已發布的 flow（沒有則 published: null） */
export async function handleGetPublished(request, env, userId, botId) {
    const p = parseJson(await env.KV_LINE_STORAGE.get(BotKeys.flowPublished(botId)), null);
    return jsonResponse({ success: true, published: p && p.version === 1 ? publishedSummary(p) : null });
}

/**
 * Router — 每條路由都經 withPermission（botId 由它注入）
 */
export function route(request, env, userId, pathname) {
    const guarded = (handler, ...args) => withPermission(handler)(request, env, userId, ...args);
    const ownerOnly = (handler, ...args) => withPermission(handler, "owner")(request, env, userId, ...args);

    if (pathname === "/flow/published" && request.method === "GET") return guarded(handleGetPublished);
    if (pathname === "/flow/unpublish" && request.method === "DELETE") return ownerOnly(handleUnpublishFlow);

    if (pathname === "/flow/list" && request.method === "GET") return guarded(handleListFlows);
    if (pathname === "/flow/save" && request.method === "POST") return guarded(handleSaveFlow);

    const publish = pathname.match(/^\/flow\/publish\/(.+)$/);
    if (publish && request.method === "POST") return ownerOnly(handlePublishFlow, publish[1]);

    const match = pathname.match(/^\/flow\/(get|delete|versions)\/(.+)$/);
    if (match) {
        const [, action, flowId] = match;
        if (action === "get" && request.method === "GET") return guarded(handleGetFlow, flowId);
        if (action === "delete" && request.method === "DELETE") return guarded(handleDeleteFlow, flowId);
        if (action === "versions" && request.method === "GET") return guarded(handleListVersions, flowId);
    }

    return jsonResponse({ error: "Invalid flow route" }, 404);
}
