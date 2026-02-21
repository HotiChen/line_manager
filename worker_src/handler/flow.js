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
        name: name || "未命名流程",
        botId,
        nodes: nodes || [],
        edges: edges || [],
        updatedAt: now,
        createdAt: body.createdAt || now,
    };

    // Save the flow data
    await env.KV_LINE_STORAGE.put(
        flowKey(userId, botId, flowId),
        JSON.stringify(flowData)
    );

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

    return jsonResponse({ error: "Invalid flow route" }, 404);
}
