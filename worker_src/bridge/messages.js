/**
 * 橋接 API：推播（系統主體）
 *
 *   POST /bridge/v1/raw/push        { to, messages[] }
 *   POST /bridge/v1/raw/multicast   { to[], messages[] }   ≤ 500
 *
 * 不變量（ARCHITECTURE_PLATFORM.md 第一、七、九節）：
 *   - messages[] 是呼叫端組好的 LINE message object，原樣轉送。
 *     平台層不產生內容、不套模板、不替換變數 —— 與後台用的 /api/send-message 不同。
 *   - 推不出去的情況都不是 500：409 target_inactive、402 quota_exhausted、404 target_not_found。
 *   - 重複推播比漏推更傷：X-Idempotency-Key 命中時不再打 LINE。
 *   - 額度以 LINE 的數字為準（bridge/quota.js），回應一律回報。
 *
 * 冪等：D1 單一 `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now`（bridge/db.js 的
 * claimIdempotency）原子地搶佔，並行的請求只有一個會真的送出；過期的紀錄可被接手。
 * 第二道防線仍是 LINE 自己的 X-Line-Retry-Key（由冪等鍵衍生的 UUID，24 小時內 LINE
 * 不會重複投遞）。
 *
 * 稽核：每次推播／群發的結果寫一筆 audit_log（只記次數與錯誤碼，不記內文、金鑰、userId；
 * best-effort，失敗不影響回應）。缺 BRIDGE_DB 或查詢失敗 → 503 bridge_not_configured。
 */
import { jsonResponse } from "../lib/utils.js";
import { withService } from "./auth.js";
import { bridgeRateLimit } from "../middleware/rate_limiter.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { getBotAccessToken, hasMember, markMemberInactive } from "../lm_service.js";
import { pushMessage, multicastMessage, LineApiError, MULTICAST_MAX_RECIPIENTS } from "../lib/line_api.js";
import { retryKeyFor } from "./retry_key.js";
import { checkQuota, recordUsage, markExhausted } from "./quota.js";
import {
  BridgeDbError, bridgeUnavailable, claimIdempotency, completeIdempotency, releaseIdempotency, writeAudit,
} from "./db.js";

const MAX_MESSAGES = 5; // LINE 單次上限
const MAX_IDEM_KEY_LENGTH = 128;
const MAX_BODY_CHARS = 200_000;
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

// ── 實際送出 ──

/**
 * @returns {Promise<{status: number, body: object, cacheable: boolean, headers?: object}>}
 *   cacheable：結果是決定性的，重試也會得到同樣的結果，才可以記進冪等紀錄。
 *   暫時性失敗（5xx、429、額度、找不到 token）不可快取，否則呼叫端永遠重試不了。
 */
async function execute(kind, env, principal, { recipients, messages }, idemKey) {
  const { botId, system } = principal;
  const to = recipients[0];

  const token = await getBotAccessToken(env, botId);
  if (!token) {
    return { status: 503, body: { success: false, error: "bot_not_configured" }, cacheable: false };
  }

  if (kind === "push" && to.startsWith("U")) {
    if (!(await hasMember(env, botId, to))) {
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

// ── 稽核 ──

/** 把結果對應成稽核的 result 欄位：sent / blocked / quota_exhausted / replayed / failed */
function auditResult(result, replayed) {
  if (replayed) return "replayed";
  if (result.status === 200) return "sent";
  if (result.status === 409 && result.body?.error === "target_inactive") return "blocked";
  if (result.status === 402) return "quota_exhausted";
  return "failed";
}

/** 只放白名單欄位：次數、成本、狀態碼、錯誤碼。不放內文、金鑰、LINE userId。 */
function auditDelivery(env, principal, kind, parsed, result, replayed = false) {
  const requested = parsed ? parsed.recipients.length * parsed.messages.length : undefined;
  const consumed = result.body && Number.isSafeInteger(result.body.quotaConsumed) ? result.body.quotaConsumed : undefined;
  return writeAudit(env, {
    actorType: "service_key",
    actorId: principal.system,
    botId: principal.botId,
    system: principal.system,
    action: kind,
    result: auditResult(result, replayed),
    detail: {
      recipients: parsed ? parsed.recipients.length : undefined,
      messages: parsed ? parsed.messages.length : undefined,
      cost: result.status === 200 ? consumed : requested,
      status: result.status,
      error: result.body && typeof result.body.error === "string" ? result.body.error : undefined,
    },
  });
}

/** 冪等紀錄的收尾是盡力而為：訊息已經送出（或已確定失敗），不可因為記錄失敗而改變回應 */
async function quietly(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[Bridge] idempotency ${label} failed:`, err && err.message);
  }
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
    await auditDelivery(env, principal, kind, parsed, result);
    return reply(result.status, result.body, { ...result.headers, "X-Idempotency-Missing": "true" });
  }

  const { botId, system } = principal;
  const keyHash = await sha256Hex(idemKey);
  const fingerprint = await sha256Hex(JSON.stringify({ kind, recipients: parsed.recipients, messages: parsed.messages }));

  const claim = await claimIdempotency(env, { botId, system, keyHash, fingerprint });
  if (!claim.won) {
    const existing = claim.existing;
    if (existing.fingerprint !== fingerprint) {
      return reply(422, { success: false, error: "idempotency_key_reuse" });
    }
    if (existing.status === "done") {
      await auditDelivery(env, principal, kind, parsed, existing.response, true);
      return reply(existing.response.status, existing.response.body, { "X-Idempotency-Replayed": "true" });
    }
    return reply(409, { success: false, error: "in_progress" });
  }

  let result;
  try {
    result = await execute(kind, env, principal, parsed, idemKey);
  } catch (err) {
    await quietly("release", () => releaseIdempotency(env, { botId, system, keyHash }));
    throw err;
  }

  if (result.cacheable) {
    await quietly("complete", () =>
      completeIdempotency(env, { botId, system, keyHash, fingerprint, response: { status: result.status, body: result.body } })
    );
  } else {
    await quietly("release", () => releaseIdempotency(env, { botId, system, keyHash }));
  }
  await auditDelivery(env, principal, kind, parsed, result);
  return reply(result.status, result.body, result.headers);
}

function guarded(kind) {
  return async (request, env, principal) => {
    try {
      return await deliver(kind, request, env, principal);
    } catch (err) {
      // 資料庫缺失或查詢失敗：fail-closed 503，不退回 KV
      if (err instanceof BridgeDbError) return bridgeUnavailable();
      // 只記訊息，不記 stack，也不回給呼叫端
      console.error(`[Bridge] ${kind} failed:`, err && err.message);
      await writeAudit(env, {
        actorType: "service_key", actorId: principal.system, botId: principal.botId, system: principal.system,
        action: kind, result: "failed", detail: { status: 500, error: "internal_error" },
      });
      return reply(500, { success: false, error: "internal_error" });
    }
  };
}

export const handlePush = guarded("push");
export const handleMulticast = guarded("multicast");

// ── 路由 ──

export function route(request, env, pathname) {
  const target =
    pathname === "/bridge/v1/raw/push" ? withService(handlePush, "raw:push")
    : pathname === "/bridge/v1/raw/multicast" ? withService(handleMulticast, "raw:push")
    : null;

  if (!target) return reply(404, { success: false, error: "Not Found" });
  if (request.method !== "POST") return reply(405, { success: false, error: "Method not allowed" }, { Allow: "POST" });
  return target(request, env);
}
