/**
 * 事件轉發（LM-4B）。設計見 docs/integration/bridge-v1.1-draft.md §B 與 lm-4-plan.md。
 *
 * 客人按 Rich Menu 的 `px:<product_key>:<action>` 時，webhook（lib/event_handler.js，唯一的呼叫端）呼叫 forwardPostback：
 * LM 把事件簽章後 POST 給產品，產品同步回一則 Notification，由呼叫端 reply 給客人。
 *
 * 不變量：
 *   - BRIDGE_ENABLED 不是 "1" → 什麼都不做（零 D1、零網路）
 *   - 只送一種請求：POST 到產品登記的 event_url（https、主機在 url_domains 內，登記時驗證）；redirect: "manual"，3xx 一律視為失敗
 *   - 請求本文只有 event_id、type、occurred_at、link_id、action、params、contact；
 *     **永遠不含** LINE userId、顯示名稱、頭像、replyToken、原始 data；contact 只在這位使用者於「這條連結」已綁定時才有
 *   - 簽章：X-LM-Signature = v1=hex(HMAC-SHA256(event_signing_secret, "<timestamp>.<raw body>"))；
 *     密鑰以 AES-GCM 加密存 D1（lm_service.sealSecret），缺金鑰或解不開 → 不轉發
 *   - 逾時（BRIDGE_EVENT_TIMEOUT_MS，500–5000，預設 2500）→ 主動中止、改送備用內容；晚到的回應丟棄，絕不 push 補送
 *   - 回應本文最多 4 KB；reply 與備用內容都經 content.js 驗證（同 /messages），網址受產品 url_domains 限制
 *   - 去重：LINE 的 webhookEventId（D1 旗標，10 分鐘）；限流：每（連結, LINE 使用者）每分鐘 10 次，超過靜默略過
 *   - 稽核（event_forwarded）：event_id、link_id、action 名稱、結果、延遲毫秒；不記 userId、params 的值、reply 內容
 *   - 絕不丟錯：任何例外 → { messages: null, outcome: "not_forwarded" }
 */
import { sealSecret, openSecret } from "../lm_service.js";
import { sha256Hex } from "../lib/crypto_util.js";
import {
  getEventTarget, getBoundContactByUser, getEventFallback, takeToken, claimFlag, writeAudit,
} from "./db.js";
import { validateContent, contentToMessage, checkActionUrl } from "./content.js";

export const EVENT_TIMEOUT_DEFAULT_MS = 2500;
export const EVENT_TIMEOUT_MIN_MS = 500;
export const EVENT_TIMEOUT_MAX_MS = 5000;
export const EVENT_RESPONSE_MAX_BYTES = 4096;
/** 每（連結, LINE 使用者）每分鐘最多轉發這麼多次 */
export const FORWARD_RATE = { windowMs: 60_000, cap: 10 };
const DEDUP_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 沒有設定備用內容的動作使用的通用文字（純文字，不帶按鈕） */
export const GENERIC_FALLBACK_TEXT = "目前無法查詢，請稍後再試";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const enabled = (env) => Boolean(env) && env.BRIDGE_ENABLED === "1";
const validId = (v) => typeof v === "string" && v !== "" && v.length <= 128;

/** BRIDGE_EVENT_TIMEOUT_MS：500–5000 的整數才採用，其餘（缺、空、小數、字母、超出範圍）一律用預設 */
export function eventTimeoutMs(env) {
  const raw = env && env.BRIDGE_EVENT_TIMEOUT_MS;
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^[0-9]{3,4}$/.test(text.trim())) return EVENT_TIMEOUT_DEFAULT_MS;
  const n = Number(text.trim());
  return n >= EVENT_TIMEOUT_MIN_MS && n <= EVENT_TIMEOUT_MAX_MS ? n : EVENT_TIMEOUT_DEFAULT_MS;
}

/** 產生一把新的事件簽章密鑰：`pes_` + 32 bytes（CSPRNG）base64url。只在登記／輪替時回給營運一次 */
export function generateEventSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `pes_${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** 密鑰 → 加密後的字串（存 D1）。缺金鑰時丟錯，呼叫端 fail-closed */
export async function sealEventSecret(env, secret) {
  return sealSecret(env, secret);
}

/**
 * 簽章：`v1=` + hex(HMAC-SHA256(secret, "<timestamp>.<rawBody>"))。產品端用同一個演算法驗證。
 *
 * @param {string} secret
 * @param {number|string} timestamp unix 秒
 * @param {string} rawBody
 * @returns {Promise<string>}
 */
export async function signEvent(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  return `v1=${hex(new Uint8Array(sig))}`;
}

/**
 * event_url 的驗證（營運登記時用）：https、無帳密與 fragment、埠空或 443、非 IP／localhost，主機在 url_domains 內。
 * 與通知按鈕網址同一套規則（checkActionUrl）。
 *
 * @param {unknown} raw
 * @param {unknown} urlDomains
 * @returns {{ok: true, url: string} | {ok: false}}
 */
export function checkEventUrl(raw, urlDomains) {
  if (typeof raw === "string" && raw.includes("#")) return { ok: false };
  return checkActionUrl(raw, urlDomains);
}

const msg = (text) => ({ type: "text", text });

/** 備用內容 → LINE messages。沒有設定、內容壞掉或網址不合 → null */
async function fallbackMessages(env, { botId, productKey, action, urlDomains }) {
  try {
    const stored = await getEventFallback(env, { botId, productKey, action });
    if (!stored) return null;
    const checked = validateContent(stored);
    if (checked.error) return null;
    const message = contentToMessage(checked.value, urlDomains ?? []);
    return message ? [message] : null;
  } catch {
    return null;
  }
}

/** 先讀到 4 KB 就停；超過回 null。逾時由外層中止 */
async function readLimited(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > EVENT_RESPONSE_MAX_BYTES) return null;
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return new TextEncoder().encode(text).length > EVENT_RESPONSE_MAX_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > EVENT_RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder().decode(all);
}

/** 呼叫產品。回 {kind: "reply"|"no_reply"|"invalid"|"error"|"timeout", reply?} */
async function callProduct(env, { url, secret, body, eventId, timestamp }) {
  const timeoutMs = eventTimeoutMs(env);
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeoutMs);
  });
  const work = (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-LM-Event-Id": eventId,
          "X-LM-Timestamp": String(timestamp),
          "X-LM-Signature": await signEvent(secret, timestamp, body),
        },
        body,
      });
      if (response.status === 204) return { kind: "no_reply" };
      if (response.status !== 200) return { kind: "error" };
      const text = await readLimited(response);
      if (text === null) return { kind: "invalid" };
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { kind: "invalid" }; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.reply === undefined) return { kind: "invalid" };
      return { kind: "reply", reply: parsed.reply };
    } catch {
      // 中止後的例外（逾時分支已先 resolve）或網路錯誤；不記錯誤內容（可能含網址）
      return { kind: "error" };
    }
  })();
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function audit(env, { botId, productId, linkId, eventId, action, outcome, latencyMs }) {
  await writeAudit(env, {
    actorType: "system", actorId: "webhook", botId, action: "event_forwarded",
    result: outcome === "replied" || outcome === "no_reply" ? "ok" : "failed",
    detail: { product_id: productId, link_id: linkId, event_id: eventId, event_action: action, outcome, latency_ms: latencyMs },
  });
}

/**
 * 轉發一個 `px:` postback。絕不丟錯。
 *
 * @param {Object} env
 * @param {{botId: string, route: {kind: string, productKey?: string, action?: string, params?: object}, event: object, now?: number}} input
 *   botId 是 webhook 的 destination；route 是 parsePostback 的結果；event 是 LINE 事件（只讀 source、webhookEventId、timestamp）
 * @returns {Promise<{messages: object[]|null, outcome: string}>}
 *   outcome：replied | no_reply | fallback_timeout | fallback_error | fallback_invalid | not_forwarded | duplicate | rate_limited
 */
export async function forwardPostback(env, { botId, route, event, now = Date.now() } = {}) {
  const none = (outcome) => ({ messages: null, outcome });
  try {
    if (!enabled(env)) return none("not_forwarded");
    if (!route || route.kind !== "px" || !validId(botId)) return none("not_forwarded");
    const source = event && event.source;
    const lineUserId = source && source.type === "user" ? source.userId : null;
    if (!validId(lineUserId)) return none("not_forwarded");
    const { productKey, action } = route;

    // 去重（LINE 重送同一個事件）
    const webhookEventId = event.webhookEventId;
    if (typeof webhookEventId === "string" && WEBHOOK_EVENT_ID_RE.test(webhookEventId)) {
      const first = await claimFlag(env, { key: `fwdevt:${botId}:${webhookEventId}`, untilAt: now + DEDUP_TTL_MS, now });
      if (!first) return none("duplicate");
    }

    const target = await getEventTarget(env, { botId, productKey });
    const eligible = Boolean(target) && !target.productDisabled && target.linkScopes.includes("events:receive")
      && typeof target.eventUrl === "string" && target.eventUrl !== "" && Boolean(target.eventSecretEnc);

    const fallbackFor = (extra = {}) => fallbackMessages(env, { botId, productKey, action, urlDomains: target ? target.urlDomains : [], ...extra });
    const auditBase = { botId, productId: target ? target.productId : undefined, linkId: target ? target.linkId : undefined, action };

    if (!eligible) {
      const messages = await fallbackFor();
      if (target) await audit(env, { ...auditBase, outcome: "not_forwarded", latencyMs: 0 });
      return { messages, outcome: "not_forwarded" };
    }

    // 限流：靜默略過
    const userKey = (await sha256Hex(lineUserId)).slice(0, 32);
    const slot = await takeToken(env, { key: `fwd:${target.linkId}:${userKey}`, windowMs: FORWARD_RATE.windowMs, cap: FORWARD_RATE.cap, now });
    if (!slot.allowed) return none("rate_limited");

    const secret = await openSecret(env, target.eventSecretEnc);
    if (!secret) {
      await audit(env, { ...auditBase, outcome: "not_forwarded", latencyMs: 0 });
      return { messages: await fallbackFor(), outcome: "not_forwarded" };
    }

    let contact = null;
    try {
      const bound = await getBoundContactByUser(env, { linkId: target.linkId, botId, lineUserId });
      if (bound) contact = { external_contact_ref: bound.ref, status: bound.status };
    } catch {
      contact = null; // 查不到就當公開查詢：絕不因此多給資料
    }

    const eventId = `evt_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const timestamp = Math.floor(now / 1000);
    const occurredMs = Number.isFinite(event.timestamp) ? event.timestamp : now;
    const body = JSON.stringify({
      event_id: eventId,
      type: "postback",
      occurred_at: new Date(occurredMs).toISOString(),
      link_id: target.linkId,
      action,
      params: route.params ?? {},
      contact,
    });

    const started = Date.now();
    const result = await callProduct(env, { url: target.eventUrl, secret, body, eventId, timestamp });
    const latencyMs = Math.max(0, Date.now() - started);
    const record = (outcome) => audit(env, { ...auditBase, eventId, outcome, latencyMs });

    if (result.kind === "no_reply") {
      await record("no_reply");
      return none("no_reply");
    }
    if (result.kind === "reply") {
      const checked = validateContent(result.reply);
      const message = checked.error ? null : contentToMessage(checked.value, target.urlDomains);
      if (message) {
        await record("replied");
        return { messages: [message], outcome: "replied" };
      }
      await record("fallback_invalid");
      return { messages: (await fallbackFor()) ?? [msg(GENERIC_FALLBACK_TEXT)], outcome: "fallback_invalid" };
    }
    const outcome = result.kind === "timeout" ? "fallback_timeout" : result.kind === "invalid" ? "fallback_invalid" : "fallback_error";
    await record(outcome);
    return { messages: (await fallbackFor()) ?? [msg(GENERIC_FALLBACK_TEXT)], outcome };
  } catch (err) {
    // 只記 message：不記 userId、網址、密鑰
    console.error("[Events] forward failed:", err && err.message);
    return { messages: null, outcome: "not_forwarded" };
  }
}
