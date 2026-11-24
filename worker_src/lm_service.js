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
import { BotKeys, UserKeys } from "./lib/kv_schema.js";
import { syncMemberRichMenu } from "./lib/segmented_richmenu_logic.js";
import { encryptToken, decryptToken, isEncrypted } from "./lib/token_crypto.js";

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
 * 這個 LINE userId 是不是「透過這個官方帳號的 webhook 互動過」的會員（LM-4C 的同 Provider 驗證用）。
 *
 * 不能只看會員資料存不存在：`/member/save` 讓團隊成員手動寫入任意 memberId，名單可以被污染。
 * webhook 建立的會員才有 `botIds`（由事件的 destination 寫入），而 `/member/save` 不接受 body 裡的 botIds，
 * 所以 `botIds` 含這個 bot，就代表這個 userId 真的是從這個官方帳號的 webhook 來的（OA 所屬 Provider 的 userId）。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @returns {Promise<boolean>}
 */
export async function hasWebhookMember(env, botId, lineUserId) {
  const store = await openBotStoreForBot(env, botId);
  const member = await store.get("member", lineUserId);
  return Boolean(member) && Array.isArray(member.botIds) && member.botIds.includes(botId);
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
 * LM-4B：加密一個需要日後取回明文的密鑰（事件簽章密鑰）。用 LM 保存 OA token 的同一把金鑰（TOKEN_ENCRYPTION_KEY）。
 * 缺金鑰時丟錯（呼叫端 fail-closed），絕不降級存明文。
 *
 * @param {Object} env
 * @param {string} plaintext
 * @returns {Promise<string>} `enc.v1.…`
 */
export async function sealSecret(env, plaintext) {
  return encryptToken(env, plaintext);
}

/**
 * LM-4B：解開 sealSecret 的密文。不是密文（明文、空值、壞資料）、缺金鑰、驗證失敗一律回 null —— 不放行明文。
 *
 * @param {Object} env
 * @param {unknown} stored
 * @returns {Promise<string|null>}
 */
export async function openSecret(env, stored) {
  try {
    if (!isEncrypted(stored)) return null;
    return await decryptToken(env, stored);
  } catch (err) {
    console.error("[lm_service] openSecret failed:", err && err.message);
    return null;
  }
}

/**
 * LM-4D：寫入這位會員的產品分眾副本（KV member.productSegments），並依 4R 的規則重新計算 Rich Menu。
 *
 * 分眾的真相在 Bridge 的 D1；這裡只存一份副本，讓 LM 端其他觸發點（標籤變更、加好友）重新計算時也看得到。
 * 會員不存在 → 什麼都不做（回 true：沒有要切換的對象）。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @param {string[]} segments `<product_key>:<segment>` 清單
 * @param {{sync?: boolean}} [opts] sync = false 只寫副本、不呼叫 LINE（例如封鎖時）
 * @returns {Promise<boolean>} false = 需要重試（LINE 或 token 失敗）
 */
export async function applyProductSegments(env, botId, lineUserId, segments, { sync = true } = {}) {
  try {
    const store = await openBotStoreForBot(env, botId);
    const member = await store.get("member", lineUserId);
    if (!member) return true;
    await store.put("member", { ...member, productSegments: [...segments] }, lineUserId);
    if (!sync) return true;
    const token = await getBotAccessToken(env, botId);
    if (!token) return false;
    return await syncMemberRichMenu(store, lineUserId, { accessToken: token, segments });
  } catch (err) {
    console.error("[lm_service] applyProductSegments failed:", err && err.message);
    return false;
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

// ── LM-2A：連結流程需要的 bot 資訊（唯讀、窄介面）──

const MAX_OWNED_BOTS = 50;
const usable = (v) => typeof v === "string" && v !== "" && !v.includes(":");

function pickName(...candidates) {
  for (const c of candidates) if (typeof c === "string" && c.trim() !== "") return c;
  return null;
}

async function readJson(env, key) {
  return env.KV_LINE_STORAGE.get(key, { type: "json" });
}

/**
 * 這個人是不是該 bot 的 owner；是 → 回 bot 的 id 與顯示名稱。
 * 授權以 `bot:{id}:permissions` 為準（與 withPermission 同一個來源），不看 user:{id}:bots 索引，
 * 也不信任呼叫端宣稱的任何 ownerId。
 *
 * @param {Object} env
 * @param {string} userId 已經過 authenticateUser 的使用者
 * @param {string} botId
 * @returns {Promise<{botId: string, displayName: string}|null>} 不是 owner、bot 不存在、KV 壞掉都回 null
 */
export async function getOwnedBot(env, userId, botId) {
  try {
    if (!env || !env.KV_LINE_STORAGE || !usable(userId) || !usable(botId)) return null;
    const permissions = await readJson(env, BotKeys.permissions(botId));
    const users = permissions && Array.isArray(permissions.users) ? permissions.users : [];
    if (!users.some((u) => u && u.userId === userId && u.role === "owner")) return null;
    const info = await readJson(env, BotKeys.info(botId));
    return { botId, displayName: pickName(info && info.displayName, info && info.name) || "LINE 官方帳號" };
  } catch (err) {
    console.error("[lm_service] getOwnedBot failed:", err && err.message);
    return null;
  }
}

/**
 * 這個人擁有（owner）的 bot 清單，給同意頁讓使用者選。
 * 候選來自 user:{id}:bots，但每一個都用 getOwnedBot 對 permissions 重新驗證。
 *
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<Array<{botId: string, displayName: string}>>} 任何失敗回空陣列
 */
export async function listOwnedBots(env, userId) {
  try {
    if (!env || !env.KV_LINE_STORAGE || !usable(userId)) return [];
    const stored = await readJson(env, UserKeys.bots(userId));
    const entries = stored && Array.isArray(stored.bots) ? stored.bots : [];
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
      if (out.length >= MAX_OWNED_BOTS) break;
      const botId = entry && entry.botId;
      if (!usable(botId) || seen.has(botId)) continue;
      seen.add(botId);
      const bot = await getOwnedBot(env, userId, botId);
      if (bot) out.push(bot);
    }
    return out;
  } catch (err) {
    console.error("[lm_service] listOwnedBots failed:", err && err.message);
    return [];
  }
}

/**
 * bot 的顯示名稱（給連結流程回應用，不是授權判斷）。
 *
 * @param {Object} env
 * @param {string} botId
 * @returns {Promise<string>} 查不到時回通用名稱，不丟錯
 */
export async function getBotDisplayName(env, botId) {
  try {
    if (!env || !env.KV_LINE_STORAGE || !usable(botId)) return "LINE 官方帳號";
    const info = await readJson(env, BotKeys.info(botId));
    return pickName(info && info.displayName, info && info.name) || "LINE 官方帳號";
  } catch (err) {
    console.error("[lm_service] getBotDisplayName failed:", err && err.message);
    return "LINE 官方帳號";
  }
}

// ── LM-3A：聯絡人綁定需要的 OA 資訊 ──

const BOT_INFO_TIMEOUT_MS = 3000;

/**
 * 該官方帳號的 basic ID（形如 "@123abcde"），用來組「預填訊息」連結。
 * 以 bot owner 的 access token 呼叫 LINE `GET /v2/bot/info`。
 *
 * @param {Object} env
 * @param {string} botId
 * @returns {Promise<string|null>} 任何失敗（沒有 token、LINE 回錯、逾時、沒有 basicId、格式怪異）都回 null，不丟錯
 */
export async function getBotBasicId(env, botId) {
  try {
    const token = await getBotAccessToken(env, botId);
    if (!token) return null;
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BOT_INFO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const info = await res.json();
    const basicId = info && typeof info.basicId === "string" ? info.basicId.trim() : "";
    return basicId === "" ? null : basicId;
  } catch (err) {
    // 只記 message：不記 token
    console.error("[lm_service] getBotBasicId failed:", err && err.message);
    return null;
  }
}
