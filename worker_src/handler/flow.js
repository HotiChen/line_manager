import { jsonResponse } from "../lib/utils.js";

// KV Key helpers
// Naming pattern: flow_{userId}_{botId}_{flowId}
//                 flow_list_{userId}_{botId}
function flowKey(userId, botId, flowId) {
    return `flow_${userId}_${botId}_${flowId}`;
}
function listKey(userId, botId) {
    return `flow_list_${userId}_${botId}`;
}

// Get currently active botId from the session token key
async function getActiveBotId(request, env, userId) {
    // Allow frontend to pass X-Bot-Id header explicitly
    const headerBot = request.headers.get("X-Bot-Id");
    if (headerBot) {
        // Header may be percent-encoded (e.g. Chinese chars from test script)
        try { return decodeURIComponent(headerBot); } catch { return headerBot; }
    }

    // Fallback: read the user's currently selected project from KV
    const tokenData = await env.KV_LINE_STORAGE.get(`token_${userId}`);
    if (tokenData) {
        try {
            const parsed = JSON.parse(tokenData);
            return parsed.currentProject || parsed.project || "default";
        } catch {
            return "default";
        }
    }
    return "default";
}

/**
 * POST /flow/save
 * Body: { id?, name, nodes, edges }
 * Creates or updates a flow in KV.
 */
export async function handleSaveFlow(request, env, userId) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { name, nodes, edges } = body;
    const botId = await getActiveBotId(request, env, userId);

    // Generate a new ID if none provided
    const flowId =
        body.id ||
        `flow_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const now = new Date().toISOString();
    const flowData = {
        id: flowId,
        name: (name || "未命名流程").replace(/<[^>]*>/g, ''),
        botId,
        nodes: nodes || [],
        edges: edges || [],
        updatedAt: now,
        createdAt: body.createdAt || now,
    };

    // 加入基本驗證 (防負載攻擊)
    if (JSON.stringify(body).length > 1024 * 512) {
        return jsonResponse({ error: "Flow data too large (max 512KB)" }, 400);
    }
    if ((nodes || []).length > 200) {
        return jsonResponse({ error: "Too many nodes (max 200)" }, 400);
    }

    // Save the flow data
    await env.KV_LINE_STORAGE.put(
        flowKey(userId, botId, flowId),
        JSON.stringify(flowData)
    );

    // ✅ 保存版本歷史 (保留 30 天)
    const versionKey = `flow_version_${userId}_${botId}_${flowId}_${Date.now()}`;
    await env.KV_LINE_STORAGE.put(versionKey, JSON.stringify(flowData), {
        expirationTtl: 60 * 60 * 24 * 30
    });

    // Update the list index
    const listRaw = await env.KV_LINE_STORAGE.get(listKey(userId, botId));
    const list = listRaw ? JSON.parse(listRaw) : [];
    if (!list.includes(flowId)) {
        list.push(flowId);
        await env.KV_LINE_STORAGE.put(listKey(userId, botId), JSON.stringify(list));
    }

    return jsonResponse({ success: true, flowId, updatedAt: now });
}

/**
 * GET /flow/list
 * Returns all flows (id + name + updatedAt) for the active bot.
 */
export async function handleListFlows(request, env, userId) {
    const botId = await getActiveBotId(request, env, userId);
    const listRaw = await env.KV_LINE_STORAGE.get(listKey(userId, botId));
    const ids = listRaw ? JSON.parse(listRaw) : [];

    // Fetch summary metadata for each flow
    const flows = await Promise.all(
        ids.map(async (id) => {
            const raw = await env.KV_LINE_STORAGE.get(flowKey(userId, botId, id));
            if (!raw) return null;
            const { id: fid, name, updatedAt, createdAt, nodes, edges } =
                JSON.parse(raw);
            return {
                id: fid,
                name,
                updatedAt,
                createdAt,
                nodeCount: (nodes || []).length,
                edgeCount: (edges || []).length,
            };
        })
    );

    return jsonResponse({
        success: true,
        flows: flows.filter(Boolean),
    });
}

/**
 * GET /flow/get/:flowId
 * Returns full flow data (nodes + edges).
 */
export async function handleGetFlow(request, env, userId, flowId) {
    const botId = await getActiveBotId(request, env, userId);
    const raw = await env.KV_LINE_STORAGE.get(flowKey(userId, botId, flowId));

    if (!raw) {
        return jsonResponse({ error: "Flow not found" }, 404);
    }

    return jsonResponse({ success: true, flow: JSON.parse(raw) });
}

/**
 * DELETE /flow/delete/:flowId
 * Removes the flow and its entry from the list index.
 */
export async function handleDeleteFlow(request, env, userId, flowId) {
    const botId = await getActiveBotId(request, env, userId);

    await env.KV_LINE_STORAGE.delete(flowKey(userId, botId, flowId));

    // Remove from list index
    const listRaw = await env.KV_LINE_STORAGE.get(listKey(userId, botId));
    if (listRaw) {
        const list = JSON.parse(listRaw).filter((id) => id !== flowId);
        await env.KV_LINE_STORAGE.put(listKey(userId, botId), JSON.stringify(list));
    }

    return jsonResponse({ success: true, flowId });
}

/**
 * GET /flow/versions/:flowId
 * Returns version history for a flow
 */
export async function handleListVersions(request, env, userId, flowId) {
    const botId = await getActiveBotId(request, env, userId);
    const prefix = `flow_version_${userId}_${botId}_${flowId}_`;
    const list = await env.KV_LINE_STORAGE.list({ prefix });
    
    const versions = await Promise.all(
        list.keys.map(async (key) => {
            const raw = await env.KV_LINE_STORAGE.get(key.name);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return {
                timestamp: key.name.replace(prefix, ''),
                name: data.name,
                nodeCount: (data.nodes || []).length,
                updatedAt: data.updatedAt
            };
        })
    );
    
    return jsonResponse({ success: true, versions: versions.filter(Boolean) });
}

/**
 * Router
 */
export function route(request, env, userId, pathname) {
    // GET /flow/list
    if (pathname === "/flow/list" && request.method === "GET") {
        return handleListFlows(request, env, userId);
    }

    // POST /flow/save
    if (pathname === "/flow/save" && request.method === "POST") {
        return handleSaveFlow(request, env, userId);
    }

    // GET /flow/get/:id
    const getMatch = pathname.match(/^\/flow\/get\/(.+)$/);
    if (getMatch && request.method === "GET") {
        return handleGetFlow(request, env, userId, getMatch[1]);
    }

    // DELETE /flow/delete/:id
    const deleteMatch = pathname.match(/^\/flow\/delete\/(.+)$/);
    if (deleteMatch && request.method === "DELETE") {
        return handleDeleteFlow(request, env, userId, deleteMatch[1]);
    }

    // GET /flow/versions/:id
    const versionsMatch = pathname.match(/^\/flow\/versions\/(.+)$/);
    if (versionsMatch && request.method === "GET") {
        return handleListVersions(request, env, userId, versionsMatch[1]);
    }

    return jsonResponse({ error: "Invalid flow route" }, 404);
}
