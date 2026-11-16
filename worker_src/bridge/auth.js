/**
 * 系統主體認證（橋接 API）
 *
 * 垂直後端以 `Authorization: Bearer <service key>` + `X-Bot-Id` 呼叫。
 *
 * 安全性質（見 docs/ARCHITECTURE_PLATFORM.md 第五、十節）：
 *   - KV 只存 key 的 SHA-256，不存原文；以雜湊直接查，不做逐筆比對
 *   - 查不到與已撤銷回同一個 401，不洩漏 key 是否存在過
 *   - X-Bot-Id 只是宣稱，必須等於 key 記錄裡的 botId（跨 bot = 橫向越權）
 *   - 系統停用或被刪除立即生效（每次都讀系統紀錄）
 *   - 缺 KV binding 時 fail-closed
 *   - 回應不含 stack
 */
import { jsonResponse } from "../lib/utils.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { BotKeys, ServiceKeyKeys } from "../lib/kv_schema.js";

const UNAUTHORIZED = "Invalid or revoked service key";

function fail(status, error) {
  return { authenticated: false, status, error };
}

/**
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<
 *   {authenticated: true, principal: {botId: string, system: string, scopes: string[], rateLimit?: object}} |
 *   {authenticated: false, status: number, error: string}
 * >}
 */
export async function authenticateBridge(request, env) {
  const kv = env && env.KV_LINE_STORAGE;
  if (!kv) return fail(503, "Service unavailable");

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return fail(401, "Authorization header required");
  }
  const key = authHeader.substring(7).trim();
  if (!key) return fail(401, "Authorization header required");

  const claimedBotId = request.headers.get("X-Bot-Id");
  if (!claimedBotId || claimedBotId.includes(":")) {
    return fail(400, "X-Bot-Id header required");
  }

  try {
    const keyHash = await sha256Hex(key);
    const record = await kv.get(ServiceKeyKeys.byHash(keyHash), { type: "json" });
    if (!record || record.revokedAt) return fail(401, UNAUTHORIZED);

    if (record.botId !== claimedBotId) return fail(403, "Bot mismatch");

    const system = await kv.get(BotKeys.system(record.botId, record.system), { type: "json" });
    if (!system || system.disabled) return fail(403, "System disabled");

    return {
      authenticated: true,
      principal: {
        botId: record.botId,
        system: record.system,
        scopes: Array.isArray(record.scopes) ? record.scopes : [],
        rateLimit: system.rateLimit,
      },
    };
  } catch (err) {
    console.error("[BridgeAuth] error:", err && err.message);
    return fail(503, "Service unavailable");
  }
}

/**
 * 包住 handler：認證 + scope 檢查。handler 收到 (request, env, principal, ...args)。
 *
 * @param {Function} handler
 * @param {string} requiredScope
 */
export function withService(handler, requiredScope) {
  return async (request, env, ...args) => {
    const auth = await authenticateBridge(request, env);
    if (!auth.authenticated) {
      return jsonResponse({ success: false, error: auth.error }, auth.status);
    }
    if (requiredScope && !auth.principal.scopes.includes(requiredScope)) {
      return jsonResponse({ success: false, error: "Insufficient scope" }, 403);
    }
    return handler(request, env, auth.principal, ...args);
  };
}
