import { jsonResponse } from "../lib/utils.js";
import { BotKeys, UserKeys, V1Keys } from "../lib/kv_schema.js";
import { withPermission } from "../middleware/permission.js";

/**
 * Flow 儲存（草圖）
 *
 * ## 命名空間
 *
 * 流程存在 `bot:${botId}:flow:*` / `bot:${botId}:flow_list`（BotKeys），botId 由
 * withPermission 解析並驗證 —— X-Bot-Id 標頭或使用者目前選定的 bot，而且呼叫者必須
 * 在 `bot:${botId}:permissions` 裡。於是：
 *
 *   - 兩個 bot 的流程互相看不到（key 不同）
 *   - 同一個 bot 的團隊成員共用同一份流程（owner 建立的，被邀請的 admin 看得到也能編輯）
 *   - 不在權限清單裡的人一律 403
 *
 * body 裡自報的 userId / botId 一律不信任。
 *
 * ## 舊資料（flow_${userId}_${botId}_${flowId}）
 *
 * 舊版 botId 來自一個沒有任何程式寫入的 `token_${userId}`，所以正式環境的舊資料
 * 幾乎都在 `flow_${userId}_default_*`。這裡不做一次性的破壞式搬移，而是在使用者第一次
 * 操作某個 bot 時 copy-forward（見 importLegacyFlows）：舊 key 只讀、不刪、不改。
 *
 * 不走 bot_store 的雙讀雙寫：舊 key 的形狀是 (userId, botId, flowId)，不是 (userId, id)，
 * 而且雙寫會把每個 bot 的流程都寫回同一組 `_default_` key，反而破壞隔離。
 * 取捨：切換後新寫入的流程不會出現在舊 key，若要回退部署，回退前的新流程需要另外處理。
 */

const LEGACY_DEFAULT_BOT = "default";
const MAX_FLOW_ID_LENGTH = 128;

/**
 * flowId 會被拼進 KV key。含 ':'（kv_schema 的分隔符）就能跨出命名空間，
 * 所以在這裡擋掉，而不是等 BotKeys 丟 TypeError 變成 500。
 */
function isValidFlowId(id) {
    return typeof id === "string" && id !== "" && id.length <= MAX_FLOW_ID_LENGTH && !id.includes(":");
}

function parseJson(raw) {
    if (raw === null || raw === undefined) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function parseIdList(raw) {
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : [];
}

function invalidFlowId() {
    return jsonResponse({ error: "Invalid flow id" }, 400);
}

/**
 * 把使用者這個人的舊 flow_* 資料 copy-forward 進 botId 的命名空間（只做一次）。
 *
 * - 舊資料綁的是「作者本人」，所以只匯入呼叫者自己的舊 key。ADMIN 先開啟 bot 不會
 *   把 owner 的舊流程標成已處理 —— 標記是 (bot, 使用者) 為單位。
 * - 舊的 "default" 沒有 bot 維度，一份舊資料只能歸屬一個 bot：第一個匯入它的 bot
 *   用 UserKeys.flowLegacyClaim 登記，其他 bot 之後不會再看到。
 * - 舊 key 明確帶著這個 botId（flow_<userId>_<botId>_*）的，只屬於那個 bot。
 * - 有標記後不再讀舊 key，所以刪除不會讓舊資料復活。
 * - 已存在於新命名空間的流程優先，不會被舊資料覆蓋。
 * - 全程冪等：中途失敗沒有寫入標記，下次會重做，不會重複也不會漏。
 */
async function importLegacyFlows(env, userId, botId) {
    const kv = env.KV_LINE_STORAGE;

    let markerKey;
    let claimKey;
    try {
        markerKey = BotKeys.flowLegacyImported(botId, userId);
        claimKey = UserKeys.flowLegacyClaim(userId);
    } catch {
        // userId 含分隔符：不可能有對應的舊 key
        return;
    }

    if ((await kv.get(markerKey)) !== null) return;

    const claim = await kv.get(claimKey);
    const sources = [botId];
    if (botId !== LEGACY_DEFAULT_BOT && (claim === null || claim === botId)) {
        sources.push(LEGACY_DEFAULT_BOT);
    }

    const listed = [];
    let tookDefault = false;

    for (const source of sources) {
        for (const id of parseIdList(await kv.get(V1Keys.flowList(userId, source)))) {
            if (!isValidFlowId(id) || listed.includes(id)) continue;

            const newKey = BotKeys.flow(botId, id);
            if ((await kv.get(newKey)) !== null) {
                listed.push(id);
                continue;
            }

            const legacy = parseJson(await kv.get(V1Keys.flow(userId, source, id)));
            if (!legacy || typeof legacy !== "object") continue;

            await kv.put(newKey, JSON.stringify({ ...legacy, id, botId }));
            listed.push(id);
            if (source === LEGACY_DEFAULT_BOT) tookDefault = true;
        }
    }

    if (listed.length > 0) {
        const current = parseIdList(await kv.get(BotKeys.flowList(botId)));
        const merged = [...current];
        for (const id of listed) if (!merged.includes(id)) merged.push(id);
        if (merged.length !== current.length) {
            await kv.put(BotKeys.flowList(botId), JSON.stringify(merged));
        }
    }

    if (tookDefault && claim === null) await kv.put(claimKey, botId);
    await kv.put(markerKey, new Date().toISOString());
}

/**
 * POST /flow/save
 * Body: { id?, name, nodes, edges }
 * Creates or updates a flow in the active bot's namespace.
 *
 * 由 withPermission 注入 (request, env, userId, botId, role)。
 */
export async function handleSaveFlow(request, env, userId, botId) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object") {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { name, nodes, edges } = body;

    // 加入基本驗證 (防負載攻擊)
    if (JSON.stringify(body).length > 1024 * 512) {
        return jsonResponse({ error: "Flow data too large (max 512KB)" }, 400);
    }
    if (nodes !== undefined && !Array.isArray(nodes)) {
        return jsonResponse({ error: "nodes must be an array" }, 400);
    }
    if (edges !== undefined && !Array.isArray(edges)) {
        return jsonResponse({ error: "edges must be an array" }, 400);
    }
    if ((nodes || []).length > 200) {
        return jsonResponse({ error: "Too many nodes (max 200)" }, 400);
    }

    // 新流程的 id 不含 LINE userId（id 會出現在網址與 log）
    const flowId = body.id === undefined || body.id === null || body.id === ""
        ? `flow_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        : body.id;
    if (!isValidFlowId(flowId)) return invalidFlowId();

    await importLegacyFlows(env, userId, botId);

    const flowKey = BotKeys.flow(botId, flowId);
    const existing = parseJson(await env.KV_LINE_STORAGE.get(flowKey));

    const now = new Date().toISOString();
    const flowData = {
        id: flowId,
        name: (typeof name === "string" && name ? name : "未命名流程").replace(/<[^>]*>/g, ""),
        botId,
        nodes: nodes || [],
        edges: edges || [],
        updatedAt: now,
        // 更新時保留原本的 createdAt；用戶端送來的值一律忽略
        createdAt: existing && typeof existing.createdAt === "string" ? existing.createdAt : now,
    };

    await env.KV_LINE_STORAGE.put(flowKey, JSON.stringify(flowData));

    // ✅ 保存版本歷史 (保留 30 天)
    await env.KV_LINE_STORAGE.put(
        BotKeys.flowVersion(botId, flowId, Date.now()),
        JSON.stringify(flowData),
        { expirationTtl: 60 * 60 * 24 * 30 }
    );

    // Update the list index
    const list = parseIdList(await env.KV_LINE_STORAGE.get(BotKeys.flowList(botId)));
    if (!list.includes(flowId)) {
        list.push(flowId);
        await env.KV_LINE_STORAGE.put(BotKeys.flowList(botId), JSON.stringify(list));
    }

    return jsonResponse({ success: true, flowId, createdAt: flowData.createdAt, updatedAt: now });
}

/**
 * GET /flow/list
 * Returns all flows (id + name + updatedAt) for the active bot.
 */
export async function handleListFlows(request, env, userId, botId) {
    await importLegacyFlows(env, userId, botId);

    const ids = parseIdList(await env.KV_LINE_STORAGE.get(BotKeys.flowList(botId)));

    // Fetch summary metadata for each flow
    const flows = await Promise.all(
        ids.map(async (id) => {
            if (!isValidFlowId(id)) return null;
            const flow = parseJson(await env.KV_LINE_STORAGE.get(BotKeys.flow(botId, id)));
            if (!flow) return null;
            const { id: fid, name, updatedAt, createdAt, nodes, edges } = flow;
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

    const validFlows = flows.filter(Boolean);

    // 自動清理孤兒 ID：若有 flowId 在 index 但 KV 已不存在，順帶更新 index
    if (validFlows.length !== ids.length) {
        const validIds = validFlows.map(f => f.id);
        await env.KV_LINE_STORAGE.put(BotKeys.flowList(botId), JSON.stringify(validIds));
    }

    return jsonResponse({
        success: true,
        flows: validFlows,
    });
}

/**
 * GET /flow/get/:flowId
 * Returns full flow data (nodes + edges).
 */
export async function handleGetFlow(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return invalidFlowId();

    await importLegacyFlows(env, userId, botId);
    const raw = await env.KV_LINE_STORAGE.get(BotKeys.flow(botId, flowId));

    if (!raw) {
        return jsonResponse({ error: "Flow not found" }, 404);
    }

    return jsonResponse({ success: true, flow: JSON.parse(raw) });
}

/**
 * DELETE /flow/delete/:flowId
 * Removes the flow and its entry from the list index.
 * 舊 key 不刪（見檔頭）；importLegacyFlows 的標記保證刪掉的流程不會從舊 key 復活。
 */
export async function handleDeleteFlow(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return invalidFlowId();

    await importLegacyFlows(env, userId, botId);
    await env.KV_LINE_STORAGE.delete(BotKeys.flow(botId, flowId));

    // Remove from list index
    const listRaw = await env.KV_LINE_STORAGE.get(BotKeys.flowList(botId));
    if (listRaw) {
        const list = parseIdList(listRaw).filter((id) => id !== flowId);
        await env.KV_LINE_STORAGE.put(BotKeys.flowList(botId), JSON.stringify(list));
    }

    return jsonResponse({ success: true, flowId });
}

/**
 * GET /flow/versions/:flowId
 * Returns version history for a flow
 * （只含新命名空間的版本；舊版本快照有 30 天 TTL，不 copy-forward）
 */
export async function handleListVersions(request, env, userId, botId, role, flowId) {
    if (!isValidFlowId(flowId)) return invalidFlowId();

    const prefix = BotKeys.flowVersion(botId, flowId, "x").slice(0, -1);
    const list = await env.KV_LINE_STORAGE.list({ prefix });

    const versions = await Promise.all(
        list.keys.map(async (key) => {
            const data = parseJson(await env.KV_LINE_STORAGE.get(key.name));
            if (!data) return null;
            return {
                timestamp: key.name.slice(prefix.length),
                name: data.name,
                nodeCount: (data.nodes || []).length,
                updatedAt: data.updatedAt
            };
        })
    );

    return jsonResponse({ success: true, versions: versions.filter(Boolean) });
}

/**
 * 權限檢查 + 把 key 組件的 TypeError（例如 X-Bot-Id 含 ':'）轉成 400，
 * 而不是讓一個壞標頭變成 500。
 */
function guarded(handler) {
    const wrapped = withPermission(handler);
    return async (request, env, userId, ...args) => {
        try {
            return await wrapped(request, env, userId, ...args);
        } catch (err) {
            if (err instanceof TypeError && /invalid key component/.test(err.message)) return jsonResponse({ error: "Invalid bot id" }, 400);
            throw err;
        }
    };
}

function decodeParam(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Router
 *
 * 認證由 index.js 的 authenticate 完成並傳入 userId；缺少時 fail-closed。
 * 授權由 withPermission 完成（bot 成員才能存取該 bot 的流程）。
 */
export function route(request, env, userId, pathname) {
    if (!userId || typeof userId !== "string") {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // GET /flow/list
    if (pathname === "/flow/list" && request.method === "GET") {
        return guarded(handleListFlows)(request, env, userId);
    }

    // POST /flow/save
    if (pathname === "/flow/save" && request.method === "POST") {
        return guarded(handleSaveFlow)(request, env, userId);
    }

    // GET /flow/get/:id
    const getMatch = pathname.match(/^\/flow\/get\/([^/]+)$/);
    if (getMatch && request.method === "GET") {
        return guarded(handleGetFlow)(request, env, userId, decodeParam(getMatch[1]));
    }

    // DELETE /flow/delete/:id
    const deleteMatch = pathname.match(/^\/flow\/delete\/([^/]+)$/);
    if (deleteMatch && request.method === "DELETE") {
        return guarded(handleDeleteFlow)(request, env, userId, decodeParam(deleteMatch[1]));
    }

    // GET /flow/versions/:id
    const versionsMatch = pathname.match(/^\/flow\/versions\/([^/]+)$/);
    if (versionsMatch && request.method === "GET") {
        return guarded(handleListVersions)(request, env, userId, decodeParam(versionsMatch[1]));
    }

    return jsonResponse({ error: "Invalid flow route" }, 404);
}
