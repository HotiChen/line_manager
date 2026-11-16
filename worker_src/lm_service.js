/**
 * lm_service — Bridge 使用 LM 內部的「唯一」窄介面
 *
 * `worker_src/bridge/` 底下的程式不得直接 import bot_context / token_store /
 * bot_store / middleware/auth / middleware/permission / handler/*（由
 * tests/unit/test_import_boundary.mjs 與 eslint.config.js 的 no-restricted-imports
 * 把關）。需要 LM 的什麼，就在這裡開一個小函式，讓日後把 Bridge 拆成獨立 Worker
 * 時，這個檔案就是要換成「呼叫 LM 的 HTTP/service binding」的那條縫。
 *
 * 約定：
 *   - getBotAccessToken、markMemberInactive 不丟錯（失敗是 null / 靜默）
 *   - 錯誤只記 err.message，不記 stack、不記 token
 */
import { resolveOwner } from "./lib/bot_context.js";
import { getAccessTokenForDestination } from "./lib/token_store.js";
import { openBotStoreForBot } from "./lib/bot_store.js";
import { authenticate } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate_limiter.js";

/** owner-only 路由用的權限包裝（原樣轉出 middleware/permission.js 的實作） */
export { withPermission } from "./middleware/permission.js";

/**
 * 取得 bot 的 LINE channel access token（已解密）。
 *
 * @param {Object} env
 * @param {string} botId
 * @returns {Promise<string|null>} 任何失敗（沒有 owner、沒有 token、解密失敗、KV 壞掉）都回 null
 */
export async function getBotAccessToken(env, botId) {
  try {
    const ownerId = await resolveOwner(env, botId);
    if (!ownerId) return null;
    const { token } = await getAccessTokenForDestination(env, ownerId, botId);
    return token || null;
  } catch (err) {
    // 解密失敗（金鑰缺失或資料被改）—— 不外洩細節
    console.error("[lm_service] token lookup failed:", err && err.message);
    return null;
  }
}

/**
 * 這個 LINE userId 是不是該 bot 的會員。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @returns {Promise<boolean>}
 */
export async function hasMember(env, botId, lineUserId) {
  const store = await openBotStoreForBot(env, botId);
  const member = await store.get("member", lineUserId);
  return Boolean(member);
}

/**
 * 把會員標記為不可推播（被封鎖）。盡力而為：失敗只記 log，不丟錯；會員不存在就什麼都不做。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @returns {Promise<void>}
 */
export async function markMemberInactive(env, botId, lineUserId) {
  try {
    const store = await openBotStoreForBot(env, botId);
    const member = await store.get("member", lineUserId);
    if (member) await store.put("member", { ...member, inactiveAt: Date.now() }, lineUserId);
  } catch (err) {
    // 標記是盡力而為，不可讓它把 409 變成 500
    console.error("[lm_service] markMemberInactive failed:", err && err.message);
  }
}

/**
 * 人主體認證（LIFF）＋ 人類 rate limit —— 與 index.js 對 LM 路由做的事相同。
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<
 *   {authenticated: true, userId: string} |
 *   {authenticated: false, status: 401, error: string} |
 *   {authenticated: false, status: 429, error: string, retryAfter: number}
 * >}
 */
export async function authenticateUser(request, env) {
  const auth = await authenticate(request, env);
  if (!auth.authenticated) {
    return { authenticated: false, status: 401, error: auth.error || "Unauthorized" };
  }

  const limited = await rateLimitMiddleware(env, auth.userId);
  if (limited) {
    let error = "Too many requests. Please try again later.";
    let retryAfter = 1;
    try {
      const body = await limited.json();
      if (body && typeof body.error === "string") error = body.error;
      if (Number.isFinite(body && body.retryAfter)) retryAfter = body.retryAfter;
    } catch {
      // 用預設值
    }
    return { authenticated: false, status: 429, error, retryAfter };
  }

  return { authenticated: true, userId: auth.userId };
}
