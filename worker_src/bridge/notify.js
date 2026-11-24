/**
 * 受限通知端點（LM-3B）。設計見 docs/integration/lm-3b-plan.md。
 *
 *   POST /bridge/v1/messages   連結金鑰（messages:send）  → 200 {message_id, status:"sent", sent_at}
 *
 * 產品用 external_contact_ref 指定一位「已綁定」的客戶，送出純文字標題、內文與最多一顆按鈕。
 * 訊息由 LM 組成固定外觀的 Flex bubble（buildFlexMessage）；產品不能帶 LINE message object（那是 /raw/*，只給系統金鑰）。
 *
 * 安全性質：
 *   - 認證一律 withLink(…, "messages:send")；系統金鑰是 INVALID_KEY，無 scope 是 SCOPE_DENIED，撤銷連結是 LINK_REVOKED
 *   - ref 只在「金鑰所屬連結」範圍內解析；別條連結的 ref 看起來就是 CONTACT_NOT_BOUND
 *   - LINE userId 只在 handler 內存活（交給 LINE），不進回應、audit、log、冪等紀錄
 *   - action.url 必須是 https、443、非 IP、非 localhost，主機名稱等於或是產品登記 url_domains 的子網域
 *   - title／body／label 不可含 http:// 或 https://（否則可以把連結貼進內文繞過白名單）
 *   - 使用者文字只放進 Flex 的 text／label 欄位（LINE 不解析成標記），不放進任何其他欄位
 *   - 發送預算（M-01，D1 原子計數 bridge/db.js takeToken；固定視窗）：每連結 60 則／分鐘、每（連結, ref）10 則／小時
 *     → 429 RATE_LIMITED + Retry-After（距視窗結束的秒數，至少 1）；每連結每日 500 則（env BRIDGE_LINK_DAILY_CAP，
 *     正整數，否則預設）→ 402 QUOTA_EXCEEDED。被擋的請求不打 LINE、不搶佔冪等鍵。
 *     日預算用到 80% 時寫一筆稽核 usage_high（每連結每日一次）。ref 只以 SHA-256 前 32 碼進計數鍵。
 *     名額在「驗證通過之後、冪等之前」扣；被後面的限制擋下、冪等重送（回放／處理中／鍵重用）、
 *     或 action.url 不在白名單的請求，會把名額還回去（網址不合只保留每分鐘那一格，仍受每連結頻率限制）；
 *     其餘（聯絡人未綁定、LINE 失敗等）算一次嘗試，不還。
 *     缺 0004 遷移（沒有 counters 表）→ 503 bridge_not_configured（fail-closed，不放行）
 *   - 冪等：D1 的 idempotency，system 欄放 `link:{link_id}`；只快取成功與確定性失敗，
 *     CONTACT_NOT_BOUND、RECIPIENT_BLOCKED、額度、暫時性錯誤一律釋放（之後可能綁定、解除封鎖），與 /raw 不同
 *   - audit（message_sent／message_blocked／message_failed）detail 只有 product_id、link_id、message_id、error_code、
 *     status、cost；不記 ref、userId、標題、內文、網址
 *   - 缺 BRIDGE_DB 或查詢失敗 → 503 INTERNAL bridge_not_configured（fail-closed）
 */
import { getBotAccessToken, markMemberInactive } from "../lm_service.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { pushMessage, LineApiError } from "../lib/line_api.js";
import { bridgeError, ERROR_DEFAULTS } from "./errors.js";
import { withLink } from "./auth.js";
import { json, rateLimited, isoOrNull } from "./links.js";
import { NOTIFY_PATH } from "./routes.js";
import { retryKeyFor } from "./retry_key.js";
import { checkQuota, recordUsage, markExhausted } from "./quota.js";
import { CONTACT_REF_RE } from "./contacts.js";
import {
  BridgeDbError, getProduct, getContactForSend, markContactsBlockedByUser,
  claimIdempotency, completeIdempotency, releaseIdempotency, writeAudit,
  takeToken, giveBackTokens, claimFlag,
} from "./db.js";
import { blockAndClearSegments } from "./segments.js";

export const LINK_RATE_LIMIT = { limit: 60, windowSec: 60 };
export const CONTACT_RATE_LIMIT = { limit: 10, windowSec: 3600 };
export const DEFAULT_LINK_DAILY_CAP = 500;
/** 日預算用到這個比例時寫一筆 usage_high 稽核 */
export const USAGE_HIGH_RATIO = 0.8;
const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_BODY_CHARS = 20_000;
const MAX_IDEM_KEY_LENGTH = 128;
const MAX_TITLE = 40;
const MAX_BODY = 300;
const MAX_LABEL = 20;
const MAX_URL = 1000;
const ALT_TEXT_MAX = 400;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ALLOWED_FIELDS = ["external_contact_ref", "event_type", "title", "body", "action"];
const REQUIRED_FIELDS = ["external_contact_ref", "event_type", "title", "body"];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_RE = /[\s\u0000-\u001f\u007f-\u009f]/;

const invalidRequest = (message) => bridgeError("INVALID_REQUEST", message);
const unavailable = () => bridgeError("INTERNAL", "bridge_not_configured", { status: 503 });

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** 以 code point 計長度（emoji 算 1 個字元，與 LINE 的計法一致） */
const charLength = (s) => Array.from(s).length;

// ── 發送預算 ──

/** BRIDGE_LINK_DAILY_CAP：正整數（≤ 1e9）才採用，其餘（缺、空、0、負、小數、字母、科學記號）一律用預設 */
export function dailyCapFor(env) {
  const raw = env && env.BRIDGE_LINK_DAILY_CAP;
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,8}$/.test(text.trim())) return DEFAULT_LINK_DAILY_CAP;
  return Number(text.trim());
}

async function giveBackQuietly(env, tokens) {
  try {
    await giveBackTokens(env, tokens);
  } catch (err) {
    console.error("[Notify] budget refund failed:", err && err.message);
  }
}

/**
 * 依序扣 分鐘 → 小時 → 日 三個桶；任何一個擋下，就把前面已扣的還回去。
 * 資料庫失敗（含缺 counters 表）→ BridgeDbError 往上丟（呼叫端 503，不放行）。
 *
 * @returns {Promise<{tokens: {key: string, window: number}[]} | {denied: Response}>}
 */
async function takeSendBudget(env, principal, ref) {
  const { linkId } = principal;
  const now = Date.now();
  const refHash = (await sha256Hex(ref)).slice(0, 32);
  const cap = dailyCapFor(env);
  const plan = [
    { key: `send:min:${linkId}`, windowMs: LINK_RATE_LIMIT.windowSec * 1000, cap: LINK_RATE_LIMIT.limit, daily: false },
    { key: `send:hour:${linkId}:${refHash}`, windowMs: CONTACT_RATE_LIMIT.windowSec * 1000, cap: CONTACT_RATE_LIMIT.limit, daily: false },
    { key: `send:day:${linkId}`, windowMs: DAY_MS, cap, daily: true },
  ];
  const tokens = []; // 順序固定：[分鐘, 小時, 日]
  try {
    for (const step of plan) {
      const t = await takeToken(env, { key: step.key, windowMs: step.windowMs, cap: step.cap, now });
      if (!t.allowed) {
        await giveBackQuietly(env, tokens);
        return {
          denied: step.daily
            ? bridgeError("QUOTA_EXCEEDED", "Daily message budget for this link is exhausted")
            : rateLimited(t.resetAt),
        };
      }
      tokens.push({ key: step.key, window: t.window });
      if (step.daily && t.count === Math.ceil(step.cap * USAGE_HIGH_RATIO)) await noteUsageHigh(env, principal, t);
    }
  } catch (err) {
    await giveBackQuietly(env, tokens);
    throw err;
  }
  return { tokens };
}

/** 日預算達 80%：每連結每日一次稽核（旗標原子搶占）。稽核與旗標都不可讓發送失敗 */
async function noteUsageHigh(env, principal, t) {
  try {
    if (await claimFlag(env, { key: `usage_high:${principal.linkId}:${t.window}`, untilAt: t.resetAt })) {
      await writeAudit(env, {
        actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "usage_high", result: "ok",
        detail: { product_id: principal.productId, link_id: principal.linkId },
      });
    }
  } catch (err) {
    console.error("[Notify] usage_high failed:", err && err.message);
  }
}

// ── 驗證 ──

/**
 * action.url 白名單。通過條件全部成立：https、無帳號密碼、長度 ≤ 1000、無空白與控制字元、埠為空或 443、
 * 主機名稱不是 IP／localhost，且（小寫、去尾端點後）等於某個登記網域或是它的子網域。
 *
 * @param {unknown} raw
 * @param {unknown} urlDomains 產品登記的 url_domains
 * @returns {{ok: true, url: string} | {ok: false}} ok 時 url 是正規化後的網址（真正送給 LINE 的就是它）
 */
export function checkActionUrl(raw, urlDomains) {
  const fail = { ok: false };
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_URL || URL_FORBIDDEN_RE.test(raw)) return fail;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fail;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return fail;
  if (u.port !== "" && u.port !== "443") return fail;
  if (u.href.length > MAX_URL) return fail;

  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.startsWith("[") || !HOSTNAME_RE.test(host)) return fail; // IPv6、空標籤
  if (IPV4_RE.test(host) || /^\d+$/.test(host.split(".").pop())) return fail; // IPv4（含 URL 正規化後的怪寫法）
  if (host === "localhost" || host.endsWith(".localhost")) return fail;

  const domains = Array.isArray(urlDomains) ? urlDomains : [];
  const matched = domains.some((d) => {
    if (typeof d !== "string") return false;
    const domain = d.toLowerCase().replace(/\.$/, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
  return matched ? { ok: true, url: u.href } : fail;
}

const hasLink = (s) => {
  const lower = s.toLowerCase();
  return lower.includes("http://") || lower.includes("https://");
};

function validateText(name, value, max, { allowNewline = false } = {}) {
  if (typeof value !== "string") return `${name} must be a string`;
  const len = charLength(value);
  if (len < 1 || len > max) return `${name} must be 1-${max} characters`;
  if (value.trim() === "") return `${name} must not be blank`;
  if ((allowNewline ? CONTROL_EXCEPT_NEWLINE_RE : CONTROL_RE).test(value)) return `${name} must not contain control characters`;
  if (hasLink(value)) return `${name} must not contain links; put the URL in action.url`;
  return null;
}

/**
 * 驗證請求本體（不含網址白名單）。
 *
 * @param {unknown} body
 * @returns {{error: string} | {value: {ref: string, eventType: string, title: string, body: string, action: null | {label: string, url: string}}}}
 */
export function validateNotification(body) {
  if (!isPlainObject(body)) return { error: "Body must be a JSON object" };
  for (const k of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(k)) return { error: `Unknown field: ${k.slice(0, 40)}` };
  }
  for (const k of REQUIRED_FIELDS) {
    if (body[k] === undefined) return { error: `${k} is required` };
  }
  if (typeof body.external_contact_ref !== "string" || !CONTACT_REF_RE.test(body.external_contact_ref)) {
    return { error: "external_contact_ref must match ^[A-Za-z0-9_-]{8,64}$" };
  }
  if (typeof body.event_type !== "string" || !EVENT_TYPE_RE.test(body.event_type)) {
    return { error: "event_type must match ^[a-z][a-z0-9_.]{0,63}$" };
  }
  const titleErr = validateText("title", body.title, MAX_TITLE);
  if (titleErr) return { error: titleErr };
  const bodyErr = validateText("body", body.body, MAX_BODY, { allowNewline: true });
  if (bodyErr) return { error: bodyErr };

  let action = null;
  if (body.action !== undefined) {
    const a = body.action;
    if (!isPlainObject(a)) return { error: "action must be an object" };
    for (const k of Object.keys(a)) {
      if (k !== "label" && k !== "url") return { error: `Unknown field: action.${k.slice(0, 40)}` };
    }
    const labelErr = validateText("action.label", a.label, MAX_LABEL);
    if (labelErr) return { error: labelErr };
    if (typeof a.url !== "string" || a.url === "") return { error: "action.url must be a non-empty string" };
    action = { label: a.label, url: a.url };
  }

  return { value: { ref: body.external_contact_ref, eventType: body.event_type, title: body.title, body: body.body, action } };
}

// ── 訊息組裝（LM 專屬，產品不能帶 message object）──

/**
 * 固定外觀的 Flex bubble：標題（粗體）、內文、（有 action 時）一顆按鈕。
 * 使用者文字只進 `text`／`label`（LINE 不解析成標記）與 altText（= 標題）；網址只進 uri action。
 *
 * @param {{title: string, body: string, action: null | {label: string, url: string}}} content url 必須已通過 checkActionUrl
 * @returns {object} LINE flex message object
 */
export function buildFlexMessage({ title, body, action }) {
  const bubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: title, weight: "bold", size: "lg", wrap: true },
        { type: "text", text: body, size: "md", wrap: true },
      ],
    },
  };
  if (action) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "button", style: "primary", height: "sm", action: { type: "uri", label: action.label, uri: action.url } },
      ],
    };
  }
  return { type: "flex", altText: title.slice(0, ALT_TEXT_MAX), contents: bubble };
}

// ── 小工具 ──

async function readBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { invalid: true };
  }
  if (text.length > MAX_BODY_CHARS) return { tooLarge: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

/** msg_ + 16 個小寫 hex（CSPRNG）。只用於對帳與稽核 */
function newMessageId() {
  return `msg_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 失敗結果描述（回應一律由 bridgeError 產生）。cacheable：確定性失敗才可以寫進冪等紀錄。
 * @returns {{error: {code: string, message: string, status: number, retryable: boolean, headers?: object}, cacheable: boolean}}
 */
function failure(code, message, { cacheable = false, status, retryable, headers } = {}) {
  const d = ERROR_DEFAULTS[code];
  return { error: { code, message, status: status ?? d.status, retryable: retryable ?? d.retryable, headers }, cacheable };
}

const errorResponse = ({ code, message, status, retryable, headers }) => bridgeError(code, message, { status, retryable, headers });

/** 把快取的第一次結果還原成回應（錯誤用 bridgeError 重建，成功用 json） */
function replayResponse(stored) {
  const err = stored.body && stored.body.error;
  const res = err && typeof err.code === "string"
    ? bridgeError(err.code, String(err.message), { status: stored.status, retryable: err.retryable === true })
    : json(stored.body, stored.status);
  res.headers.set("X-Idempotency-Replayed", "true");
  return res;
}

/** 冪等紀錄的收尾是盡力而為：訊息已經送出（或已確定失敗），不可因為記錄失敗而改變回應 */
async function quietly(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[Notify] idempotency ${label} failed:`, err && err.message);
  }
}

function auditAction(code) {
  if (code === undefined) return { action: "message_sent", result: "ok" };
  const blocked = code === "CONTACT_NOT_BOUND" || code === "RECIPIENT_BLOCKED" || code === "INVALID_URL_DOMAIN";
  return blocked ? { action: "message_blocked", result: "blocked" } : { action: "message_failed", result: "failed" };
}

/** 只放白名單欄位：product_id、link_id、message_id、error_code、status、cost。不放 ref、userId、標題、內文、網址 */
function auditSend(env, principal, { code, status, messageId }) {
  const { action, result } = auditAction(code);
  return writeAudit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action, result,
    detail: {
      product_id: principal.productId, link_id: principal.linkId, message_id: messageId,
      error_code: code, status, cost: code === undefined ? 1 : undefined,
    },
  });
}

// ── LINE 錯誤對映 ──

async function mapLineError(err, { env, botId, lineUserId }) {
  if (!(err instanceof LineApiError)) {
    // 網路層失敗：不知道 LINE 有沒有收到 —— 所以才需要 retry key。只記 message
    console.error("[Notify] LINE request failed:", err && err.message);
    return failure("INTERNAL", "LINE is unreachable, retry later", { status: 502, retryable: true });
  }
  switch (err.status) {
    case 403:
      // 客戶封鎖了這個官方帳號：把同一個 LINE 使用者的聯絡人都標成 blocked、會員標成 inactive
      // LM-4D：分眾在同一句清掉，原本有分眾才更新 LM 的副本
      await blockAndClearSegments(env, botId, lineUserId, () => markContactsBlockedByUser(env, { botId, lineUserId }));
      await markMemberInactive(env, botId, lineUserId);
      return failure("RECIPIENT_BLOCKED", "Recipient has blocked the account");
    case 429: {
      if (/monthly limit/i.test(String(err.body?.message || ""))) {
        await markExhausted(env, botId);
        return failure("QUOTA_EXCEEDED", "Monthly message quota exhausted");
      }
      const retryAfter = Math.max(1, Math.ceil(err.retryAfter ?? 1));
      return failure("RATE_LIMITED", "LINE rate limit, retry later", { headers: { "Retry-After": String(retryAfter) } });
    }
    case 400:
      // 確定性：同樣的內容重送還是會被 LINE 拒絕，可以快取。不轉述 LINE 的訊息（可能含內容片段）
      return failure("INVALID_REQUEST", "LINE rejected the message", { cacheable: true });
    case 401:
      // LINE 不認這把 access token：是 bot 的設定問題，不是呼叫端的錯
      return failure("INTERNAL", "bot_not_configured", { status: 503 });
  }
  console.error(`[Notify] LINE ${err.status}:`, err.message);
  return failure("INTERNAL", "LINE is unavailable, retry later", { status: 502, retryable: err.status >= 500 });
}

// ── 實際送出 ──

/**
 * @returns {Promise<{status: number, body: object, cacheable: true} | {error: object, cacheable: boolean}>}
 */
async function execute(env, principal, content, idemKey, messageId) {
  const { botId, linkId } = principal;

  const contact = await getContactForSend(env, { linkId, ref: content.ref, botId });
  if (!contact) return failure("CONTACT_NOT_BOUND", "Contact is not bound");
  if (contact.status === "blocked") return failure("RECIPIENT_BLOCKED", "Recipient has blocked the account");
  const lineUserId = contact.lineUserId;

  const token = await getBotAccessToken(env, botId);
  if (!token) return failure("INTERNAL", "bot_not_configured", { status: 503 });

  const quota = await checkQuota(env, botId, token, 1);
  if (!quota.allowed) return failure("QUOTA_EXCEEDED", "Monthly message quota exhausted");

  const message = buildFlexMessage(content);
  const retryKey = await retryKeyFor(botId, `link:${linkId}`, idemKey);

  let consumed = 1;
  try {
    await pushMessage(token, lineUserId, [message], { retryKey });
  } catch (err) {
    // LINE 409：這把 retry key 先前已被接受，客戶已經收到了 → 視為成功，不再計用量
    if (err instanceof LineApiError && err.status === 409) consumed = 0;
    else return mapLineError(err, { env, botId, lineUserId });
  }

  if (consumed > 0) await recordUsage(env, botId, consumed);
  return {
    status: 200,
    body: { message_id: messageId, status: "sent", sent_at: isoOrNull(Date.now()) },
    cacheable: true,
  };
}

// ── 端點 ──

async function handleSend(request, env, principal) {
  const idemKey = request.headers.get("Idempotency-Key");
  if (idemKey === null || idemKey === "" || idemKey.length > MAX_IDEM_KEY_LENGTH) {
    return invalidRequest(`Idempotency-Key header is required (1-${MAX_IDEM_KEY_LENGTH} characters)`);
  }

  const read = await readBody(request);
  if (read.tooLarge) return bridgeError("INVALID_REQUEST", "Request body too large", { status: 413 });
  if (read.invalid) return invalidRequest("Invalid JSON body");
  const parsed = validateNotification(read.body);
  if (parsed.error) return invalidRequest(parsed.error);
  const content = parsed.value;

  // 發送預算：驗證通過之後、冪等之前。被擋的請求不打 LINE
  const budget = await takeSendBudget(env, principal, content.ref);
  if (budget.denied) return budget.denied;

  if (content.action) {
    const product = await getProduct(env, principal.productId);
    const checked = checkActionUrl(content.action.url, product && product.urlDomains);
    if (!checked.ok) {
      // 什麼都沒送：把每聯絡人（小時）與日預算還回去；每分鐘那一格留著，所以亂打網址仍受每連結頻率限制
      await giveBackQuietly(env, budget.tokens.slice(1));
      await auditSend(env, principal, { code: "INVALID_URL_DOMAIN", status: 422 });
      return bridgeError("INVALID_URL_DOMAIN", "action.url must be an https URL on a domain registered for this product");
    }
    content.action = { label: content.action.label, url: checked.url };
  }

  const { botId, linkId } = principal;
  const system = `link:${linkId}`;
  const keyHash = await sha256Hex(idemKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    ref: content.ref, event_type: content.eventType, title: content.title, body: content.body,
    action: content.action ? { label: content.action.label, url: content.action.url } : null,
  }));

  const claim = await claimIdempotency(env, { botId, system, keyHash, fingerprint });
  if (!claim.won) {
    // 重送（回放、處理中、鍵重用）不吃預算
    await giveBackQuietly(env, budget.tokens);
    const existing = claim.existing;
    if (existing.fingerprint !== fingerprint) {
      return bridgeError("IDEMPOTENCY_KEY_REUSE", "Idempotency-Key was already used with a different request");
    }
    if (existing.status === "done" && existing.response) return replayResponse(existing.response);
    return bridgeError("IN_PROGRESS", "A request with this Idempotency-Key is still being processed");
  }

  const messageId = newMessageId();
  let result;
  try {
    result = await execute(env, principal, content, idemKey, messageId);
  } catch (err) {
    await quietly("release", () => releaseIdempotency(env, { botId, system, keyHash }));
    if (err instanceof BridgeDbError) throw err;
    // 只記 message，不記 stack，也不回給呼叫端
    console.error("[Notify] unhandled:", err && err.message);
    await auditSend(env, principal, { code: "INTERNAL", status: 500 });
    return bridgeError("INTERNAL", "Internal error");
  }

  const failed = result.error;
  const response = failed
    ? { status: failed.status, body: { error: { code: failed.code, message: failed.message, retryable: failed.retryable } } }
    : { status: result.status, body: result.body };

  if (result.cacheable) {
    await quietly("complete", () => completeIdempotency(env, { botId, system, keyHash, fingerprint, response }));
  } else {
    await quietly("release", () => releaseIdempotency(env, { botId, system, keyHash }));
  }
  await auditSend(env, principal, {
    code: failed ? failed.code : undefined, status: response.status, messageId: failed ? undefined : messageId,
  });
  return failed ? errorResponse(failed) : json(result.body, 200);
}

// ── 路由 ──

/**
 * 處理 POST /bridge/v1/messages（pathname 已去掉掛載前綴）。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
export async function route(request, env, pathname) {
  if (pathname !== NOTIFY_PATH || request.method !== "POST") return bridgeError("NOT_FOUND", "Not found");
  try {
    return await withLink(handleSend, "messages:send")(request, env);
  } catch (err) {
    if (err instanceof BridgeDbError) return unavailable();
    // 只記訊息，不記 stack，也不回給呼叫端
    console.error("[Notify] unhandled:", err && err.message);
    return bridgeError("INTERNAL", "Internal error");
  }
}
