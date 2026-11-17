/**
 * 系統主體認證（橋接 API）
 *
 * 垂直後端以 `Authorization: Bearer <service key>` + `X-Bot-Id` 呼叫。
 *
 * 安全性質（見 docs/ARCHITECTURE_PLATFORM.md 第五、十節）：
 *   - D1 只存 key 的 SHA-256，不存原文；以雜湊直接查（一次 LEFT JOIN 取得 key 與系統）
 *   - 查不到與已撤銷回同一個 401，不洩漏 key 是否存在過
 *   - X-Bot-Id 只是宣稱，必須等於 key 記錄裡的 botId（跨 bot = 橫向越權）
 *   - 系統停用或被刪除立即生效（每次都查資料庫，沒有快取）
 *   - 缺 BRIDGE_DB binding 或查詢失敗 → 503 bridge_not_configured（fail-closed，不退回 KV）
 *   - 回應不含 stack
 */
import { jsonResponse } from "../lib/utils.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { getKeyWithSystem, getLinkKeyContext, BridgeDbError } from "./db.js";
import { bridgeError } from "./errors.js";
import { onlyLinkScopes } from "./scopes.js";

const UNAUTHORIZED = "Invalid or revoked service key";
const NOT_CONFIGURED = "bridge_not_configured";

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
  if (!env || !env.BRIDGE_DB) return fail(503, NOT_CONFIGURED);

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
    const found = await getKeyWithSystem(env, keyHash);
    if (!found || found.key.revokedAt) return fail(401, UNAUTHORIZED);
    const { key: record, system } = found;

    if (record.botId !== claimedBotId) return fail(403, "Bot mismatch");

    if (!system || system.disabled) return fail(403, "System disabled");

    return {
      authenticated: true,
      principal: {
        botId: record.botId,
        system: record.system,
        scopes: record.scopes,
        rateLimit: system.rateLimit,
      },
    };
  } catch (err) {
    if (err instanceof BridgeDbError) return fail(503, NOT_CONFIGURED);
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
// 過渡相容（LM-1C）：scope 由 messages:push 改名 raw:push。舊金鑰的 scopes 裡若還是舊名，
// 檢查 raw:push 時視為擁有；principal.scopes 維持資料庫原樣。單向：不影響其他 scope。
const LEGACY_SCOPE_FOR = { "raw:push": "messages:push" };

function hasScope(scopes, required) {
  if (scopes.includes(required)) return true;
  const legacy = Object.hasOwn(LEGACY_SCOPE_FOR, required) ? LEGACY_SCOPE_FOR[required] : null;
  return legacy !== null && scopes.includes(legacy);
}

export function withService(handler, requiredScope) {
  return async (request, env, ...args) => {
    const auth = await authenticateBridge(request, env);
    if (!auth.authenticated) {
      return jsonResponse({ success: false, error: auth.error }, auth.status);
    }
    if (requiredScope && !hasScope(auth.principal.scopes, requiredScope)) {
      return jsonResponse({ success: false, error: "Insufficient scope" }, 403);
    }
    return handler(request, env, auth.principal, ...args);
  };
}

// ── 連結金鑰（LM-2A）──

/**
 * 連結金鑰認證（Bearer brk_…，金鑰綁定一條連結）。一次 LEFT JOIN 取得 金鑰 → 連結 → 產品，依序檢查：
 *
 *   查不到 / 系統金鑰（無 link_id）/ 孤兒金鑰   → INVALID_KEY（401，三者不可區分）
 *   連結已撤銷                                  → LINK_REVOKED（403）。放在「金鑰已撤銷」之前：
 *                                                 撤銷連結時金鑰也一併撤銷，持有人要看到的是連結被撤銷
 *   金鑰已撤銷（例如已輪替掉）                   → INVALID_KEY
 *   產品停用或不存在                             → LINK_REVOKED
 *   scope 不足                                   → SCOPE_DENIED（403）
 *
 * principal.scopes 是 金鑰 ∩ 連結 ∩ LINK_SCOPES：即使資料庫被寫入 raw:push 也不會被當成權限。
 * 缺 BRIDGE_DB 或查詢失敗 → 503（fail-closed）。「資源屬於這條連結」由 handler 以 principal.linkId 判斷。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} [requiredScope]
 * @returns {Promise<{authenticated: true, principal: {linkId: string, productId: string, botId: string, scopes: string[]}} | {authenticated: false, response: Response}>}
 */
export async function authenticateLink(request, env, requiredScope) {
  const deny = (code, message, opts) => ({ authenticated: false, response: bridgeError(code, message, opts) });

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return deny("INVALID_KEY", "Authorization header required");
  const key = authHeader.substring(7).trim();
  if (!key) return deny("INVALID_KEY", "Authorization header required");

  let ctx;
  try {
    ctx = await getLinkKeyContext(env, await sha256Hex(key));
  } catch (err) {
    if (err instanceof BridgeDbError) return deny("INTERNAL", NOT_CONFIGURED, { status: 503 });
    throw err;
  }

  const INVALID = "Invalid or revoked key";
  if (!ctx || !ctx.key.linkId || !ctx.link) return deny("INVALID_KEY", INVALID);
  if (ctx.link.botId !== ctx.key.botId) return deny("INVALID_KEY", INVALID);
  if (ctx.link.status !== "active") return deny("LINK_REVOKED", "Link is revoked");
  if (ctx.key.revokedAt) return deny("INVALID_KEY", INVALID);
  if (!ctx.product || ctx.product.disabled) return deny("LINK_REVOKED", "Link is revoked");

  const linkScopes = onlyLinkScopes(ctx.link.scopes);
  const scopes = onlyLinkScopes(ctx.key.scopes).filter((s) => linkScopes.includes(s));
  if (requiredScope && !scopes.includes(requiredScope)) return deny("SCOPE_DENIED", "Insufficient scope");

  return {
    authenticated: true,
    principal: { linkId: ctx.link.linkId, productId: ctx.link.productId, botId: ctx.link.botId, scopes },
  };
}

/**
 * 包住 handler：連結金鑰認證 + scope 檢查。handler 收到 (request, env, principal, ...args)。
 *
 * @param {Function} handler
 * @param {string} requiredScope
 */
export function withLink(handler, requiredScope) {
  return async (request, env, ...args) => {
    const auth = await authenticateLink(request, env, requiredScope);
    if (!auth.authenticated) return auth.response;
    return handler(request, env, auth.principal, ...args);
  };
}
