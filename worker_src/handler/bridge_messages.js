/**
 * 橋接 API：推播（系統主體）
 *
 *   POST /api/v1/messages/push        { to, messages[] }
 *   POST /api/v1/messages/multicast   { to[], messages[] }   ≤ 500
 *
 * 不變量（ARCHITECTURE_PLATFORM.md 第一、七、九節）：
 *   - messages[] 是呼叫端組好的 LINE message object，原樣轉送。
 *     平台層不產生內容、不套模板、不替換變數 —— 與後台用的 /api/send-message 不同。
 *   - 推不出去的情況都不是 500：409 target_inactive、402 quota_exhausted、404 target_not_found。
 *   - 重複推播比漏推更傷：X-Idempotency-Key 命中時不再打 LINE。
 *   - 額度以 LINE 的數字為準（lib/quota.js），回應一律回報。
 *
 * 冪等的誠實限制：KV 沒有原子操作，「讀 → 寫 in_progress」之間有極短的競態窗口。
 * 第二道防線是 LINE 自己的 X-Line-Retry-Key（由冪等鍵衍生的 UUID，24 小時內 LINE
 * 不會重複投遞）。嚴格去重需要 Durable Object，目前 repo 沒有。
 */
import { jsonResponse } from "../lib/utils.js";
import { withService } from "../middleware/bridge_auth.js";
import { bridgeRateLimit } from "../middleware/rate_limiter.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { BotKeys } from "../lib/kv_schema.js";
import { resolveOwner } from "../lib/bot_context.js";
import { getAccessTokenForDestination } from "../lib/token_store.js";
import { openBotStoreForBot } from "../lib/bot_store.js";
import { pushMessage, multicastMessage, LineApiError, MULTICAST_MAX_RECIPIENTS } from "../lib/line_api.js";
import { checkQuota, recordUsage, markExhausted } from "../lib/quota.js";

const MAX_MESSAGES = 5; // LINE 單次上限
const MAX_IDEM_KEY_LENGTH = 128;
const MAX_BODY_CHARS = 200_000;
const IDEM_DONE_TTL_SEC = 24 * 60 * 60;
/** 處理中的紀錄只活 2 分鐘：Worker 被回收時不會把鍵永遠鎖死（KV 最小 TTL 為 60 秒） */
const IDEM_IN_PROGRESS_TTL_SEC = 120;
const TARGET_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── 小工具 ──

function reply(status, body, headers) {
  const res = jsonResponse(body, status);
  if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

function badRequest(message) {
  return reply(400, { success: false, error: "invalid_request", detail: message });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return { tooLarge: true };
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > MAX_MESSAGES) return `messages must have at most ${MAX_MESSAGES} items`;
  const ok = messages.every((m) => m && typeof m === "object" && !Array.isArray(m) && typeof m.type === "string" && m.type !== "");
  return ok ? null : "each message must be an object with a string type";
}

/** @returns {{error: string}|{recipients: string[], messages: object[]}} */
function parseRequest(kind, body) {
  const msgErr = validMessages(body.messages);
  if (msgErr) return { error: msgErr };

  if (kind === "push") {
    if (typeof body.to !== "string" || !TARGET_RE.test(body.to)) return { error: "to must be a LINE user, group or room id" };
    return { recipients: [body.to], messages: body.messages };
  }

  if (!Array.isArray(body.to) || body.to.length === 0) return { error: "to must be a non-empty array" };
  if (!body.to.every((t) => typeof t === "string" && TARGET_RE.test(t))) return { error: "to must contain only LINE ids" };
  const recipients = [...new Set(body.to)];
  if (recipients.length > MULTICAST_MAX_RECIPIENTS) return { error: `to must have at most ${MULTICAST_MAX_RECIPIENTS} recipients` };
  return { recipients, messages: body.messages };
}

/** 由冪等鍵衍生 UUID v4 形狀的 retry key（LINE 要求 UUID）。綁 (bot, system, key)，同一把永遠相同。 */
async function retryKeyFor(botId, system, idemKey) {
  const h = await sha256Hex(`${botId}|${system}|${idemKey}`);
  const variant = "89ab"[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function getLineToken(env, botId) {
  try {
    const ownerId = await resolveOwner(env, botId);
    if (!ownerId) return null;
    const { token } = await getAccessTokenForDestination(env, ownerId, botId);
    return token || null;
  } catch (err) {
    // 解密失敗（金鑰缺失或資料被改）—— 不外洩細節
    console.error("[Bridge] token lookup failed:", err && err.message);
    return null;
  }
}

async function markMemberInactive(env, botId, lineUserId) {
  try {
    const store = await openBotStoreForBot(env, botId);
    const member = await store.get("member", lineUserId);
    if (member) await store.put("member", { ...member, inactiveAt: Date.now() }, lineUserId);
  } catch (err) {
    // 標記是盡力而為，不可讓它把 409 變成 500
    console.error("[Bridge] markMemberInactive failed:", err && err.message);
  }
}

// ── 實際送出 ──

/**
 * @returns {Promise<{status: number, body: object, cacheable: boolean, headers?: object}>}
 *   cacheable：結果是決定性的，重試也會得到同樣的結果，才可以記進冪等紀錄。
 *   暫時性失敗（5xx、429、額度、找不到 token）不可快取，否則呼叫端永遠重試不了。
 */
async function execute(kind, env, principal, { recipients, messages }, idemKey) {
  const { botId, system } = principal;
  const to = recipients[0];

  const token = await getLineToken(env, botId);
  if (!token) {
    return { status: 503, body: { success: false, error: "bot_not_configured" }, cacheable: false };
  }

  if (kind === "push" && to.startsWith("U")) {
    const store = await openBotStoreForBot(env, botId);
    const member = await store.get("member", to);
    if (!member) {
      return { status: 404, body: { success: false, error: "target_not_found" }, cacheable: false };
    }
  }

  const cost = recipients.length * messages.length;
  const quota = await checkQuota(env, botId, token, cost);
  if (!quota.allowed) {
    return {
      status: 402,
      body: { success: false, error: "quota_exhausted", remaining: quota.remaining },
      cacheable: false,
    };
  }

  const retryKey = idemKey ? await retryKeyFor(botId, system, idemKey) : undefined;

  try {
    if (kind === "push") await pushMessage(token, to, messages, { retryKey });
    else await multicastMessage(token, recipients, messages, { retryKey });
  } catch (err) {
    return mapLineError(err, { kind, env, botId, to, quota });
  }

  await recordUsage(env, botId, cost);
  const remaining = quota.remaining === null ? null : Math.max(0, quota.remaining - cost);
  return { status: 200, body: { success: true, quotaConsumed: cost, remaining }, cacheable: true };
}

async function mapLineError(err, { kind, env, botId, to, quota }) {
  if (!(err instanceof LineApiError)) {
    // 網路層失敗（fetch 丟錯）。不知道 LINE 有沒有收到 —— 所以才需要 retry key。
    console.error("[Bridge] LINE request failed:", err && err.message);
    return { status: 502, body: { success: false, error: "line_unavailable", retryable: true }, cacheable: false };
  }

  switch (err.status) {
    case 409:
      // retry key 先前已被接受：LINE 已經投遞過了，視為成功，不要讓客人收到兩則
      return {
        status: 200,
        body: { success: true, quotaConsumed: 0, remaining: quota.remaining, acceptedEarlier: true },
        cacheable: true,
      };

    case 403: {
      if (kind !== "push") break;
      const isUser = to.startsWith("U");
      if (isUser) await markMemberInactive(env, botId, to);
      return {
        status: 409,
        body: { success: false, error: "target_inactive", reason: isUser ? "blocked" : "bot_left" },
        cacheable: true,
      };
    }

    case 429: {
      const message = String(err.body?.message || "");
      if (/monthly limit/i.test(message)) {
        await markExhausted(env, botId);
        return { status: 402, body: { success: false, error: "quota_exhausted", remaining: 0 }, cacheable: false };
      }
      return {
        status: 429,
        body: { success: false, error: "line_rate_limited", retryAfter: err.retryAfter ?? 1 },
        headers: { "Retry-After": String(err.retryAfter ?? 1) },
        cacheable: false,
      };
    }

    case 400:
      return {
        status: 400,
        body: { success: false, error: "invalid_request", detail: String(err.body?.message || "rejected by LINE") },
        cacheable: false,
      };

    case 401:
      // LINE 不認這把 access token（被撤銷或重發）—— 是 bot 的設定問題，不是呼叫端的錯
      return { status: 503, body: { success: false, error: "bot_not_configured" }, cacheable: false };
  }

  console.error(`[Bridge] LINE ${err.status}:`, err.message);
  return { status: 502, body: { success: false, error: "line_unavailable", retryable: err.status >= 500 }, cacheable: false };
}

// ── 冪等包裝 ──

async function deliver(kind, request, env, principal) {
  const limited = await bridgeRateLimit(env, principal, "write");
  if (limited) return limited;

  const idemKey = request.headers.get("X-Idempotency-Key");
  if (idemKey !== null && (idemKey === "" || idemKey.length > MAX_IDEM_KEY_LENGTH)) {
    return badRequest(`X-Idempotency-Key must be 1-${MAX_IDEM_KEY_LENGTH} characters`);
  }

  const read = await readBody(request);
  if (read.tooLarge) return reply(413, { success: false, error: "payload_too_large" });
  if (read.invalid) return badRequest("Invalid JSON body");

  const parsed = parseRequest(kind, read.body);
  if (parsed.error) return badRequest(parsed.error);

  if (idemKey === null) {
    const result = await execute(kind, env, principal, parsed, null);
    return reply(result.status, result.body, { ...result.headers, "X-Idempotency-Missing": "true" });
  }

  const kv = env.KV_LINE_STORAGE;
  const recordKey = BotKeys.idem(principal.botId, principal.system, await sha256Hex(idemKey));
  const fingerprint = await sha256Hex(JSON.stringify({ kind, recipients: parsed.recipients, messages: parsed.messages }));

  const existing = await kv.get(recordKey, { type: "json" });
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return reply(422, { success: false, error: "idempotency_key_reuse" });
    }
    if (existing.status === "done") {
      return reply(existing.response.status, existing.response.body, { "X-Idempotency-Replayed": "true" });
    }
    return reply(409, { success: false, error: "in_progress" });
  }

  await kv.put(recordKey, JSON.stringify({ status: "in_progress", fingerprint }), {
    expirationTtl: IDEM_IN_PROGRESS_TTL_SEC,
  });

  let result;
  try {
    result = await execute(kind, env, principal, parsed, idemKey);
  } catch (err) {
    await kv.delete(recordKey);
    throw err;
  }

  if (result.cacheable) {
    await kv.put(
      recordKey,
      JSON.stringify({ status: "done", fingerprint, response: { status: result.status, body: result.body } }),
      { expirationTtl: IDEM_DONE_TTL_SEC }
    );
  } else {
    await kv.delete(recordKey);
  }
  return reply(result.status, result.body, result.headers);
}

function guarded(kind) {
  return async (request, env, principal) => {
    try {
      return await deliver(kind, request, env, principal);
    } catch (err) {
      // 只記訊息，不記 stack，也不回給呼叫端
      console.error(`[Bridge] ${kind} failed:`, err && err.message);
      return reply(500, { success: false, error: "internal_error" });
    }
  };
}

export const handlePush = guarded("push");
export const handleMulticast = guarded("multicast");

// ── 路由 ──

export function route(request, env, pathname) {
  const target =
    pathname === "/api/v1/messages/push" ? withService(handlePush, "messages:push")
    : pathname === "/api/v1/messages/multicast" ? withService(handleMulticast, "messages:push")
    : null;

  if (!target) return reply(404, { success: false, error: "Not Found" });
  if (request.method !== "POST") return reply(405, { success: false, error: "Method not allowed" }, { Allow: "POST" });
  return target(request, env);
}
