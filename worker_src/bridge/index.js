/**
 * Bridge 入口（給外部系統用的 service-key API）
 *
 * 這是 Bridge 唯一對外的接縫：worker_src/index.js 只認得 isBridgePath / handleBridge /
 * isBridgeEnabled。Bridge 要用 LM 的什麼，一律經 ../lm_service.js。
 *
 * 路由（前綴 /bridge/v1）：
 *   GET  /health                      公開（會對 BRIDGE_DB 做 SELECT 1，失敗回 503 bridge_not_configured）
 *   POST /raw/push, /raw/multicast    service key（scope raw:push）
 *   /systems*                         人主體（LIFF）+ owner
 *   其他                              404
 *
 * Feature flag：只有 env.BRIDGE_ENABLED === "1"（精確字串）才啟用。
 * 關閉時所有 /bridge/* 回與未知路由一樣的 404，不認證、不碰 KV／D1。
 *
 * 例外隔離：這裡丟出的任何錯都變成 500 internal_error，只記 err.message，不往外拋 ——
 * Bridge 壞掉不可拖垮 LM core 的路由。
 */
import { jsonResponse } from "../lib/utils.js";
import { authenticateUser } from "../lm_service.js";
import { isSystemsRoute, isBridgeServiceRoute, HEALTH_PATH } from "./routes.js";
import * as MessagesHandler from "./messages.js";
import * as SystemsHandler from "./systems.js";
import { BridgeDbError, bridgeUnavailable, pingDb } from "./db.js";

/**
 * Bridge 是否啟用。只認字串 "1"（"true"、"0"、"" 等一律視為關閉）。
 *
 * @param {Object} env
 * @returns {boolean}
 */
export function isBridgeEnabled(env) {
  return Boolean(env) && env.BRIDGE_ENABLED === "1";
}

/**
 * 這個（已去掉掛載前綴的）路徑是否屬於 Bridge。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isBridgePath(pathname) {
  return typeof pathname === "string" && (pathname === "/bridge" || pathname.startsWith("/bridge/"));
}

function notFound() {
  return jsonResponse({ success: false, error: "Not Found" }, 404);
}

async function dispatch(request, env, pathname) {
  if (pathname === HEALTH_PATH) {
    if (request.method !== "GET") {
      const res = jsonResponse({ success: false, error: "Method not allowed" }, 405);
      res.headers.set("Allow", "GET");
      return res;
    }
    // 資料庫連得上才算健康（缺 binding 或查詢失敗 → 503 bridge_not_configured）
    try {
      await pingDb(env);
    } catch (err) {
      if (err instanceof BridgeDbError) return bridgeUnavailable();
      throw err;
    }
    return jsonResponse({ ok: true });
  }

  if (isSystemsRoute(pathname)) {
    const auth = await authenticateUser(request, env);
    if (!auth.authenticated) {
      const res = jsonResponse({ error: auth.error }, auth.status, request, env);
      if (auth.status === 429) res.headers.set("Retry-After", String(auth.retryAfter));
      return res;
    }
    return SystemsHandler.route(request, env, auth.userId, pathname);
  }

  if (isBridgeServiceRoute(pathname)) {
    return MessagesHandler.route(request, env, pathname);
  }

  return notFound();
}

/**
 * 處理一個 /bridge/* 請求。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} pathname 已去掉掛載前綴的路徑
 * @returns {Promise<Response>}
 */
export async function handleBridge(request, env, pathname) {
  if (!isBridgeEnabled(env)) return notFound();
  try {
    return await dispatch(request, env, pathname);
  } catch (err) {
    if (err instanceof BridgeDbError) return bridgeUnavailable();
    // 只記訊息，不記 stack，也不回給呼叫端
    console.error("[Bridge] unhandled:", err && err.message);
    return jsonResponse({ success: false, error: "internal_error" }, 500);
  }
}
