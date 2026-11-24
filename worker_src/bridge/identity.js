/**
 * LINE 身分換 ref（LM-4C）。設計見 docs/integration/bridge-v1.1-draft.md §C 與 lm-4-plan.md。
 *
 *   GET|PUT|DELETE /bridge/v1/admin/identity   LIFF 人主體＋OA owner：設定 LINE Login channel、建立 LIFF、看驗證狀態
 *   GET  /bridge/identity/{botId}              公開：LIFF 的 endpoint 頁（極小的 HTML，只內嵌 liffId）
 *   POST /bridge/v1/identity/verify            公開（以 ID token 為憑）：確認 Login channel 與 OA 同一個 Provider
 *   POST /bridge/v1/identity/exchange          公開（以 ID token 為憑）：發一次性身分碼，回產品登記的導回網址
 *   POST /bridge/v1/identity/token             連結金鑰＋identity:read：產品用身分碼換 external_contact_ref
 *
 * 安全性質：
 *   - 身分只來自「LINE 驗證成功的 ID token 的 sub」，不信任客戶端傳來的任何 userId；本地再比對 iss、aud、exp
 *   - 同 Provider 驗證：LINE 沒有 API 可查，所以用「sub 是不是這個 OA 的會員」（lm_service.hasMember）。
 *     不同 Provider 的 sub 不會剛好等於該 OA 的某位會員，所以命中即證明相同；沒命中就不啟用
 *   - 身分碼 `lmi_`：32 bytes CSPRNG、60 秒、單次、只存 SHA-256；資料庫只存發碼當下的 ref／status，**不存 userId**
 *   - 導回網址只來自產品登記的 identity_return_uris（精確），請求只能決定 `to`（相對路徑）與 `s`（state），都原樣帶回
 *   - login CSRF：攻擊者可能把「自己的」導回網址（含他的身分碼）丟給受害者。產品若是從自己的網頁發起（可帶 `s`）就用 state 擋；
 *     從固定的 Rich Menu 按鈕發起時無法帶 per-session state，這是已知限制，寫在契約的產品 MUST 裡
 *   - 公開端點對「OA 不存在／未驗證／產品或連結不合」一律回同一種錯誤，不洩漏存在與否；有限流
 *   - LINE Login 的 channel secret 以 AES-GCM 加密存 D1；不進回應、audit、log。缺金鑰 → 503，不降級
 *   - 稽核（identity_channel_set／identity_verified／identity_issued／identity_redeemed）只有 product_id、link_id、has_contact
 *   - 缺 0007 遷移 → 503 bridge_not_configured（公開端點回「未啟用」），不放行
 */
import { sealSecret, openSecret, hasMember } from "../lm_service.js";
import { sha256Hex, randomToken } from "../lib/crypto_util.js";
import {
  issueLoginChannelToken, listLiffApps, createLiffApp, deleteLiffApp, verifyIdToken, LineApiError,
} from "../lib/line_api.js";
import { checkRateLimit } from "../middleware/rate_limiter.js";
import { bridgeError } from "./errors.js";
import { withLink } from "./auth.js";
import { json, noContent, rateLimited, readJsonBody, mountPrefix, requireUser, resolveOwnedBot } from "./links.js";
import {
  BridgeDbError, getIdentityChannel, putIdentityChannel, setIdentityVerified, deleteIdentityChannel,
  getIdentityTarget, getBoundContactByUser, createIdentityCode, consumeIdentityCode, writeAudit,
} from "./db.js";

export const IDENTITY_ADMIN_PATH = "/bridge/v1/admin/identity";
export const IDENTITY_PAGE_PREFIX = "/bridge/identity/";
export const IDENTITY_VERIFY_PATH = "/bridge/v1/identity/verify";
export const IDENTITY_EXCHANGE_PATH = "/bridge/v1/identity/exchange";
export const IDENTITY_TOKEN_PATH = "/bridge/v1/identity/token";

const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRODUCT_KEY_RE = /^[a-z][a-z0-9]{1,15}$/;
const CHANNEL_ID_RE = /^[0-9]{6,20}$/;
const CHANNEL_SECRET_RE = /^[0-9a-f]{32}$/i;
const LIFF_ID_RE = /^[0-9]{6,20}-[A-Za-z0-9]{4,16}$/;
const TO_RE = /^\/[A-Za-z0-9/_\-.?=&]{0,199}$/;
/** 產品自己決定的 state（防 login CSRF；LM 原樣帶回，不解讀） */
const STATE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const IDENTITY_CODE_RE = /^lmi_[A-Za-z0-9_-]{43}$/;
const MAX_ID_TOKEN_LENGTH = 4096;
const MAX_CODE_ATTEMPTS = 3;

const PUBLIC_RATE_IP = { limit: 30, windowSec: 60 };
const PUBLIC_RATE_BOT = { limit: 120, windowSec: 60 };
const TOKEN_RATE_LIMIT = { limit: 60, windowSec: 60 };
const ADMIN_RATE_LIMIT = { limit: 20, windowSec: 60 };

/** LIFF 的名稱不可含 "LINE" 或類似字串 */
const LIFF_DESCRIPTION = "Identity check";

const invalidRequest = (message) => bridgeError("INVALID_REQUEST", message);
const notFound = (message = "Not found") => bridgeError("NOT_FOUND", message);
/** 公開端點「找不到／未啟用」的唯一回應：不分原因，不洩漏 OA、產品、連結是否存在 */
const unavailable = () => bridgeError("NOT_FOUND", "Identity is not available");
const notConfigured = () => bridgeError("INTERNAL", "bridge_not_configured", { status: 503 });

const noStore = { "Cache-Control": "no-store" };

function clientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP");
  return typeof ip === "string" && ip !== "" && ip.length <= 64 ? ip : "unknown";
}

function audit(env, entry) {
  return writeAudit(env, { result: "ok", ...entry });
}

/** LIFF 的 endpoint：這個 Worker 的公開位址 + 掛載前綴 + /bridge/identity/{botId} */
export function endpointUrlFor(request, env, botId) {
  return `${new URL(request.url).origin}${mountPrefix(env)}${IDENTITY_PAGE_PREFIX}${botId}`;
}

// ── 後台設定（人主體 + owner）──

function statusView(request, env, botId, row) {
  if (!row) return { configured: false, verified: false };
  return {
    configured: true,
    channel_id: row.channelId,
    liff_id: row.liffId,
    liff_url: row.liffUrl,
    endpoint_url: endpointUrlFor(request, env, botId),
    verify_url: row.liffId ? `https://liff.line.me/${row.liffId}?verify=1` : null,
    verified: row.verifiedAt !== null,
    verified_at: row.verifiedAt !== null ? new Date(row.verifiedAt).toISOString() : null,
  };
}

/** LINE 呼叫失敗 → 給後台看的、可行動但不回顯 LINE 內容的訊息 */
function lineFailure(err) {
  if (err instanceof LineApiError && err.status >= 400 && err.status < 500) {
    if (err.status === 401 || err.status === 400 || err.status === 403) {
      return invalidRequest("LINE rejected the channel ID or secret, or the channel is not a LINE Login channel, or it already has the maximum number of LIFF apps");
    }
  }
  return bridgeError("INTERNAL", "LINE is unreachable, retry later", { status: 502, retryable: true });
}

async function handleAdminGet(request, env, botId) {
  return json(statusView(request, env, botId, await getIdentityChannel(env, botId)));
}

async function handleAdminPut(request, env, botId, userId) {
  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  const channelSecret = typeof body.channel_secret === "string" ? body.channel_secret.trim() : "";
  if (!CHANNEL_ID_RE.test(channelId)) return invalidRequest("channel_id must be the numeric LINE Login channel ID");
  if (!CHANNEL_SECRET_RE.test(channelSecret)) return invalidRequest("channel_secret must be 32 hex characters");

  let secretEnc;
  try {
    secretEnc = await sealSecret(env, channelSecret); // 缺 TOKEN_ENCRYPTION_KEY → 丟錯，不降級
  } catch {
    return bridgeError("INTERNAL", "identity_secret_not_configured", { status: 503 });
  }

  const existing = await getIdentityChannel(env, botId);
  const endpoint = endpointUrlFor(request, env, botId);
  let liffId;
  try {
    const token = await issueLoginChannelToken(channelId, channelSecret);
    const apps = await listLiffApps(token);
    // 冪等：同一個 endpoint 已有 LIFF 就沿用，不重複建立
    const found = apps.find((a) => a && a.view && a.view.url === endpoint && typeof a.liffId === "string");
    liffId = found ? found.liffId : await createLiffApp(token, { endpointUrl: endpoint, description: LIFF_DESCRIPTION });
  } catch (err) {
    return lineFailure(err);
  }
  if (!LIFF_ID_RE.test(liffId)) return bridgeError("INTERNAL", "LINE returned an unexpected LIFF ID", { status: 502, retryable: true });

  // 換 channel：舊 channel 上由 LM 建的 LIFF 盡力刪掉（失敗不影響這次設定）
  if (existing && existing.channelId !== channelId) await cleanupOldLiff(env, existing, endpoint);

  const liffUrl = `https://liff.line.me/${liffId}`;
  const sameChannel = Boolean(existing) && existing.channelId === channelId && existing.liffId === liffId;
  await putIdentityChannel(env, { botId, channelId, secretEnc, liffId, liffUrl, keepVerified: sameChannel });
  await audit(env, { actorType: "user", actorId: userId, botId, action: "identity_channel_set" });
  return json(statusView(request, env, botId, await getIdentityChannel(env, botId)));
}

async function cleanupOldLiff(env, old, endpoint) {
  try {
    const secret = await openSecret(env, old.secretEnc);
    if (!secret || !old.liffId) return;
    const token = await issueLoginChannelToken(old.channelId, secret);
    const apps = await listLiffApps(token);
    if (apps.some((a) => a && a.liffId === old.liffId && a.view && a.view.url === endpoint)) await deleteLiffApp(token, old.liffId);
  } catch {
    // 盡力而為
  }
}

async function handleAdminDelete(request, env, botId, userId) {
  const existing = await getIdentityChannel(env, botId);
  if (existing) {
    await cleanupOldLiff(env, existing, endpointUrlFor(request, env, botId));
    await deleteIdentityChannel(env, botId);
    await audit(env, { actorType: "user", actorId: userId, botId, action: "identity_channel_removed" });
  }
  return noContent(); // 本來就沒有也是 204（冪等）
}

async function handleAdmin(request, env) {
  const limited = await checkRateLimit(env, `idadmin.${clientIp(request)}`, ADMIN_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);
  const user = await requireUser(request, env);
  if (user.response) return user.response;
  const resolved = await resolveOwnedBot(request, env, user.userId);
  if (resolved.response) return resolved.response;
  const botId = resolved.bot.botId;
  switch (request.method) {
    case "GET": return handleAdminGet(request, env, botId);
    case "PUT": return handleAdminPut(request, env, botId, user.userId);
    case "DELETE": return handleAdminDelete(request, env, botId, user.userId);
    default: return notFound();
  }
}

// ── 公開：LIFF endpoint 頁 ──

const escapeAttr = (v) => String(v).replace(/[^A-Za-z0-9_:/.-]/g, "");

function pageHtml({ liffId, botId, apiBase, scriptSrc }) {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="liff-id" content="${escapeAttr(liffId)}">
<meta name="bot-id" content="${escapeAttr(botId)}">
<meta name="api-base" content="${escapeAttr(apiBase)}">
<title>身分確認</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#333}main{text-align:center;padding:24px}</style>
</head>
<body>
<main><p id="status">處理中，請稍候…</p></main>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script src="${escapeAttr(scriptSrc)}"></script>
</body>
</html>`;
}

async function handlePage(request, env, pathname) {
  if (request.method !== "GET") return notFound();
  const botId = pathname.slice(IDENTITY_PAGE_PREFIX.length);
  if (!BOT_ID_RE.test(botId)) return notFound();
  let channel;
  try {
    channel = await getIdentityChannel(env, botId);
  } catch {
    return notFound();
  }
  if (!channel || !channel.liffId || !LIFF_ID_RE.test(channel.liffId)) return notFound();
  const mount = mountPrefix(env);
  const html = pageHtml({
    liffId: channel.liffId,
    botId,
    apiBase: `${new URL(request.url).origin}${mount}`,
    scriptSrc: `${mount}/js/identity_liff.js`,
  });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // LIFF SDK 需要連到 line.me 與 line-scdn.net；其餘一律不放行，頁面本身沒有 inline script
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net; "
        + "style-src 'unsafe-inline'; img-src https://*.line-scdn.net data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

// ── 公開：verify 與 exchange ──

/** 公開端點的共同前置：限流、解 JSON、bot_id 與 id_token 的格式、驗證 ID token。成功回 {botId, channel, sub, body} */
async function authenticateIdToken(request, env) {
  const ip = await checkRateLimit(env, `idpub.ip.${clientIp(request)}`, PUBLIC_RATE_IP);
  if (!ip.allowed) return { response: rateLimited(ip.resetAt) };

  const body = await readJsonBody(request);
  if (!body) return { response: invalidRequest("Invalid JSON body") };
  const { bot_id: botId, id_token: idToken } = body;
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) return { response: unavailable() };
  if (typeof idToken !== "string" || idToken === "" || idToken.length > MAX_ID_TOKEN_LENGTH) return { response: invalidRequest("id_token is required") };

  const perBot = await checkRateLimit(env, `idpub.bot.${botId}`, PUBLIC_RATE_BOT);
  if (!perBot.allowed) return { response: rateLimited(perBot.resetAt) };

  const channel = await getIdentityChannel(env, botId);
  if (!channel || !channel.liffId) return { response: unavailable() };

  const verified = await verifyIdToken(idToken, channel.channelId);
  if (!verified.ok) {
    return { response: verified.reason === "unavailable" ? bridgeError("INTERNAL", "LINE is unreachable, retry later", { status: 502, retryable: true }) : bridgeError("INVALID_KEY", "Invalid ID token") };
  }
  return { botId, channel, sub: verified.sub, body };
}

async function handleVerify(request, env) {
  if (request.method !== "POST") return notFound();
  const auth = await authenticateIdToken(request, env);
  if (auth.response) return auth.response;
  // 同 Provider 的證明：這個 sub 是不是這個 OA 的會員
  const member = await hasMember(env, auth.botId, auth.sub).catch(() => false);
  if (!member) {
    return invalidRequest("This LINE account is not a member of the official account yet. Add the account as a friend and send it a message, and check that the LINE Login channel and the official account are under the same Provider.");
  }
  await setIdentityVerified(env, { botId: auth.botId });
  await audit(env, { actorType: "system", actorId: "identity_page", botId: auth.botId, action: "identity_verified" });
  return json({ verified: true }, 200);
}

/** 產品登記的導回網址 + code + to（用 URL API 組，值由 URL API 編碼） */
function buildReturnUrl(base, code, to, state) {
  const u = new URL(base);
  u.searchParams.append("code", code);
  if (state) u.searchParams.append("state", state);
  if (to) u.searchParams.append("to", to);
  return u.toString();
}

async function issueCode(env, { linkId, botId, contact }) {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomToken("lmi_");
    const created = await createIdentityCode(env, {
      codeHash: await sha256Hex(code), linkId, botId, ref: contact ? contact.ref : null, status: contact ? contact.status : null,
    });
    if (created.created) return code;
  }
  return null;
}

async function handleExchange(request, env) {
  if (request.method !== "POST") return notFound();
  const auth = await authenticateIdToken(request, env);
  if (auth.response) return auth.response;
  // 驗證過（確認同 Provider）才發碼；未驗證等同未啟用
  if (auth.channel.verifiedAt === null) return unavailable();

  const { p: productKey, to: rawTo } = auth.body;
  if (typeof productKey !== "string" || !PRODUCT_KEY_RE.test(productKey)) return unavailable();
  // 相對路徑，且不能是 `//host`（有些框架會把它當成同協定的外部網址）
  if (rawTo !== undefined && rawTo !== null && (typeof rawTo !== "string" || !TO_RE.test(rawTo) || rawTo.startsWith("//"))) return invalidRequest("to must be a relative path");
  const to = typeof rawTo === "string" ? rawTo : null;
  const rawState = auth.body.s;
  if (rawState !== undefined && rawState !== null && (typeof rawState !== "string" || !STATE_RE.test(rawState))) return invalidRequest("s must match ^[A-Za-z0-9_-]{1,128}$");
  const state = typeof rawState === "string" ? rawState : null;

  const target = await getIdentityTarget(env, { botId: auth.botId, productKey });
  if (!target || target.productDisabled || !target.linkScopes.includes("identity:read") || target.identityReturnUris.length === 0) return unavailable();

  // 查不到就當「沒有綁定」：絕不因此多給資料
  const contact = await getBoundContactByUser(env, { linkId: target.linkId, botId: auth.botId, lineUserId: auth.sub }).catch(() => null);
  const code = await issueCode(env, { linkId: target.linkId, botId: auth.botId, contact });
  if (!code) return bridgeError("INTERNAL", "Please retry");

  await audit(env, {
    actorType: "system", actorId: "identity_page", botId: auth.botId, action: "identity_issued",
    detail: { product_id: target.productId, link_id: target.linkId, has_contact: contact !== null },
  });
  return json({ redirect_to: buildReturnUrl(target.identityReturnUris[0], code, to, state) }, 200);
}

// ── 產品：用身分碼換 ref ──

async function handleToken(request, env, principal) {
  const limited = await checkRateLimit(env, `idtoken.${principal.linkId}`, TOKEN_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);

  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const bad = () => bridgeError("INVALID_CODE", "Invalid or expired code");
  if (typeof body.code !== "string" || !IDENTITY_CODE_RE.test(body.code)) return bad();

  const consumed = await consumeIdentityCode(env, { codeHash: await sha256Hex(body.code), linkId: principal.linkId });
  if (!consumed) return bad();

  await audit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "identity_redeemed",
    detail: { product_id: principal.productId, link_id: principal.linkId, has_contact: consumed.ref !== null },
  });
  const contact = consumed.ref !== null ? { external_contact_ref: consumed.ref, status: consumed.status ?? "bound" } : null;
  return json({ link_id: principal.linkId, contact }, 200);
}

// ── 路由 ──

async function dispatch(request, env, pathname) {
  if (pathname === IDENTITY_ADMIN_PATH) return handleAdmin(request, env);
  if (pathname.startsWith(IDENTITY_PAGE_PREFIX)) return handlePage(request, env, pathname);
  if (pathname === IDENTITY_VERIFY_PATH) return handleVerify(request, env);
  if (pathname === IDENTITY_EXCHANGE_PATH) return handleExchange(request, env);
  if (pathname === IDENTITY_TOKEN_PATH) {
    return request.method === "POST" ? withLink(handleToken, "identity:read")(request, env) : notFound();
  }
  return notFound();
}

/**
 * 處理一個身分相關請求（pathname 已去掉掛載前綴）。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
export async function route(request, env, pathname) {
  try {
    const res = await dispatch(request, env, pathname);
    for (const [k, v] of Object.entries(noStore)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  } catch (err) {
    if (err instanceof BridgeDbError) {
      // 公開端點對「資料庫沒設定」也回同一種「未啟用」，不洩漏內部狀態；後台與產品端點回 503
      const isPublic = pathname.startsWith(IDENTITY_PAGE_PREFIX) || pathname === IDENTITY_VERIFY_PATH || pathname === IDENTITY_EXCHANGE_PATH;
      return isPublic ? unavailable() : notConfigured();
    }
    console.error("[Identity] unhandled:", err && err.message);
    return bridgeError("INTERNAL", "Internal error");
  }
}
