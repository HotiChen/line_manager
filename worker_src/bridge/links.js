/**
 * 連結流程（LM-2A）：產品登記、授權碼、連結與連結金鑰
 *
 * 設計見 docs/integration/lm-2a-plan.md。所有端點都用 errors.js 的 bridgeError
 * （`{error:{code,message,retryable}}`，欄位 snake_case）；/raw/* 與 /systems* 維持舊格式。
 *
 *   POST   /bridge/v1/admin/products              營運密鑰（BRIDGE_ADMIN_SECRET）  登記產品，回產品密鑰（一次）
 *   GET    /bridge/v1/link/authorize              無（瀏覽器）                     驗證參數 → 302 到同意頁
 *   GET    /bridge/v1/link/authorize/preview      人（LIFF）                       同意頁資料
 *   POST   /bridge/v1/link/authorize/approve      人（LIFF）+ 該 bot 的 owner       產生授權碼
 *   POST   /bridge/v1/links/token                 產品密鑰                          授權碼換連結與金鑰
 *   GET    /bridge/v1/links/{link_id}             連結金鑰（link:manage）
 *   DELETE /bridge/v1/links/{link_id}             連結金鑰（link:manage）
 *   POST   /bridge/v1/links/{link_id}/rotate-key  連結金鑰（link:manage）
 *   GET    /bridge/v1/admin/links                 人（LIFF）+ owner                  後台列表
 *   DELETE /bridge/v1/admin/links/{link_id}       人（LIFF）+ owner                  後台撤銷
 *
 * 安全性質：
 *   - redirect_uri 與產品登記值逐字元精確比對；不通過一律回 400，絕不導向未驗證的位址
 *   - 授權碼 256 位元 CSPRNG、只存 SHA-256、5 分鐘、單次（db.consumeAuthCode 的單一 UPDATE）；
 *     過期／已用／不存在／redirect_uri 不符回同一個 INVALID_CODE
 *   - 產品密鑰錯與產品不存在回同一個 INVALID_KEY；比對用常數時間
 *   - 連結流程永遠不發 raw:push／messages:push；產品登記時就拒絕
 *   - approve 的 bot 以 lm_service.getOwnedBot 檢查（owner 權限），不信任 body 的任何 ownerId
 *   - 連結金鑰只能操作「自己這條」連結；link_id 不符一律 NOT_FOUND（不洩漏他人連結是否存在）
 *   - 回應與稽核都不含授權碼、金鑰、雜湊、產品密鑰
 *   - 缺 BRIDGE_DB 或查詢失敗 → 503 INTERNAL（fail-closed）
 *
 * 不經 LIFF 認證的端點（authorize、links/token、admin/products、links/{id}）各自有認證：
 * worker_src/index.js 對 /bridge 路徑一律交給 handleBridge，不套用 LM 的 LIFF 閘門。
 */
import { authenticateUser, getOwnedBot, listOwnedBots, getBotDisplayName } from "../lm_service.js";
import { sha256Hex, randomToken, timingSafeEqual, generateBrokerKey } from "../lib/crypto_util.js";
import { checkRateLimit } from "../middleware/rate_limiter.js";
import { bridgeError } from "./errors.js";
import { withLink } from "./auth.js";
import { LINK_SCOPES, onlyLinkScopes } from "./scopes.js";
import {
  BridgeDbError, createProduct, getProduct, createAuthCode, consumeAuthCode, createLinkWithKey, getLink,
  listLinksForBot, revokeLink, rotateLinkKey, writeAudit, updateProduct, getProductByKey,
  listEventFallbacks, putEventFallback, deleteEventFallback,
} from "./db.js";
import { defer, captureLinkRecipients, captureReplacedRecipients, refreshRecipients } from "./segments.js";
import { generateEventSecret, sealEventSecret, checkEventUrl } from "./events.js";
import { validateContent, checkActionUrl } from "./content.js";

export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_STATE_LENGTH = 256;
const MAX_URI_LENGTH = 2048;
const MAX_BODY_CHARS = 20_000;
const MAX_REDIRECT_URIS = 10;
const MAX_URL_DOMAINS = 20;
const TOKEN_RATE_LIMIT = { limit: 30, windowSec: 60 };
const ADMIN_RATE_LIMIT = { limit: 10, windowSec: 60 };

const PRODUCT_ID_RE = /^prd_[a-f0-9]{12}$/;
const PRODUCT_KEY_RE = /^[a-z][a-z0-9]{1,15}$/;
const LINK_ID_RE = /^lnk_[a-f0-9]{16}$/;
const PRODUCT_SECRET_RE = /^bps_([a-f0-9]{12})_[A-Za-z0-9_-]{43}$/;
const AUTH_CODE_RE = /^lmc_[A-Za-z0-9_-]{43}$/;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const RESERVED_QUERY_PARAMS = ["code", "state", "error"];

const SENSITIVE = { "Cache-Control": "no-store" };

// ── 回應小工具 ──

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SENSITIVE } });
}

export function noContent() {
  return new Response(null, { status: 204, headers: SENSITIVE });
}

const invalidRequest = (message) => bridgeError("INVALID_REQUEST", message);
const invalidKey = (message = "Invalid or revoked key") => bridgeError("INVALID_KEY", message);
const notFound = (message = "Not found") => bridgeError("NOT_FOUND", message);
const unavailable = () => bridgeError("INTERNAL", "bridge_not_configured", { status: 503 });

export function rateLimited(resetAt) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return bridgeError("RATE_LIMITED", "Too many requests", { headers: { "Retry-After": String(retryAfter) } });
}

export async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function clientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP");
  return typeof ip === "string" && ip !== "" && ip.length <= 64 ? ip : "unknown";
}

/** 隨機小寫 hex（CSPRNG） */
function randomHex(byteLength) {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常數時間字串比較（先各自做 SHA-256，長度固定，不洩漏長度與內容） */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return timingSafeEqual(enc.encode(ha), enc.encode(hb));
}

/** 掛載前綴（與 lib/mount.js 的 normalizeMount 同規則；Bridge 不得 import 它，所以這裡複製這一小段） */
export function mountPrefix(env) {
  const raw = env && env.MOUNT_PATH;
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (t === "" || t === "/") return "";
  const withLeading = t.startsWith("/") ? t : `/${t}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

/** 用 URL API 組出 `base?k=v…`（保留 base 原有的 query；值一律由 URL API 編碼） */
function withParams(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
  return u.toString();
}

function audit(env, entry) {
  return writeAudit(env, { result: "ok", ...entry });
}

// ── 產品登記（營運密鑰）──

function validateRedirectUri(value, allowLocalhost) {
  if (typeof value !== "string" || value === "" || value.length > MAX_URI_LENGTH) return "redirect_uris must be non-empty strings";
  if (value.includes("#")) return "redirect_uris must not contain a fragment";
  let u;
  try {
    u = new URL(value);
  } catch {
    return "redirect_uris must be absolute URLs";
  }
  if (u.username || u.password) return "redirect_uris must not contain credentials";
  if (u.hash) return "redirect_uris must not contain a fragment";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "https:") {
    if (isLocal && !allowLocalhost) return "redirect_uris must not point to localhost";
  } else if (u.protocol === "http:") {
    if (!(allowLocalhost && isLocal)) return "redirect_uris must use https";
  } else {
    return "redirect_uris must use https";
  }
  for (const reserved of RESERVED_QUERY_PARAMS) {
    if (u.searchParams.has(reserved)) return `redirect_uris must not contain a "${reserved}" query parameter`;
  }
  return null;
}

/** identity_return_uris：1–MAX_REDIRECT_URIS 個，逐一用 redirect_uris 的規則驗證 @returns {{error: string} | {value: string[]}} */
function parseIdentityReturnUris(list, allowLocalhost) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REDIRECT_URIS) {
    return { error: `identity_return_uris must be an array of 1-${MAX_REDIRECT_URIS} URLs` };
  }
  for (const uri of list) {
    const err = validateRedirectUri(uri, allowLocalhost);
    if (err) return { error: err.replace("redirect_uris", "identity_return_uris") };
  }
  return { value: [...new Set(list)] };
}

/** @returns {{error: string} | {value: object}} */
function parseProductInput(body, env) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > 100 || CONTROL_CHARS_RE.test(name)) return { error: "name is required (max 100 chars, no control characters)" };

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > MAX_REDIRECT_URIS) {
    return { error: `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URLs` };
  }
  const allowLocalhost = env.BRIDGE_ALLOW_LOCALHOST_REDIRECT === "1";
  for (const uri of body.redirect_uris) {
    const err = validateRedirectUri(uri, allowLocalhost);
    if (err) return { error: err };
  }
  const redirectUris = [...new Set(body.redirect_uris)];

  let urlDomains = [];
  if (body.url_domains !== undefined) {
    if (!Array.isArray(body.url_domains) || body.url_domains.length > MAX_URL_DOMAINS
      || !body.url_domains.every((d) => typeof d === "string" && DOMAIN_RE.test(d))) {
      return { error: "url_domains must be an array of lowercase host names (no scheme, port or wildcard)" };
    }
    urlDomains = [...new Set(body.url_domains)];
  }

  if (!Array.isArray(body.scopes) || body.scopes.length === 0) return { error: "scopes must be a non-empty array" };
  if (!body.scopes.every((s) => typeof s === "string" && LINK_SCOPES.includes(s))) {
    return { error: `scopes must be among: ${LINK_SCOPES.join(", ")}` };
  }
  let productKey = null;
  if (body.product_key !== undefined) {
    if (typeof body.product_key !== "string" || !PRODUCT_KEY_RE.test(body.product_key)) {
      return { error: "product_key must match ^[a-z][a-z0-9]{1,15}$" };
    }
    productKey = body.product_key;
  }

  // LM-4B：events:receive 需要 product_key 與 event_url；沒有這個 scope 就不接受 event_url
  const wantsEvents = body.scopes.includes("events:receive");
  let eventUrl = null;
  if (wantsEvents) {
    if (!productKey) return { error: "events:receive requires product_key" };
    const checked = checkEventUrl(body.event_url, urlDomains);
    if (!checked.ok) return { error: "event_url must be an https URL whose host is in url_domains" };
    eventUrl = checked.url;
  } else if (body.event_url !== undefined) {
    return { error: "event_url requires the events:receive scope" };
  }

  // LM-4C：identity:read 需要 product_key 與 identity_return_uris（規則同 redirect_uris，精確比對）；沒有這個 scope 就不接受
  let identityReturnUris = null;
  if (body.scopes.includes("identity:read")) {
    if (!productKey) return { error: "identity:read requires product_key" };
    const checked = parseIdentityReturnUris(body.identity_return_uris, allowLocalhost);
    if (checked.error) return checked;
    identityReturnUris = checked.value;
  } else if (body.identity_return_uris !== undefined) {
    return { error: "identity_return_uris requires the identity:read scope" };
  }
  return { value: { name, redirectUris, urlDomains, scopes: onlyLinkScopes(body.scopes), productKey, eventUrl, identityReturnUris } };
}

/**
 * 營運密鑰認證（產品登記、產品更新共用）。未設定營運密鑰（或空字串）→ 整個端點不存在（fail-closed）。
 *
 * @returns {Promise<Response|null>} null = 通過
 */
async function requireAdmin(request, env, method) {
  const secret = env.BRIDGE_ADMIN_SECRET;
  if (typeof secret !== "string" || secret === "") return notFound();
  if (request.method !== method) return notFound();

  const limited = await checkRateLimit(env, `lnkadmin.${clientIp(request)}`, ADMIN_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);

  const header = request.headers.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.substring(7).trim() : "";
  if (presented === "" || !(await safeEqual(presented, secret))) return invalidKey("Invalid admin credential");
  return null;
}

async function handleRegisterProduct(request, env) {
  const denied = await requireAdmin(request, env, "POST");
  if (denied) return denied;

  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const parsed = parseProductInput(body, env);
  if (parsed.error) return invalidRequest(parsed.error);
  const { name, redirectUris, urlDomains, scopes, productKey, eventUrl, identityReturnUris } = parsed.value;

  const idPart = randomHex(6);
  const productId = `prd_${idPart}`;
  const productSecret = `bps_${idPart}_${randomToken()}`;
  // LM-4B：事件簽章密鑰只在登記時回一次；缺 TOKEN_ENCRYPTION_KEY → 503（不降級存明文）
  let eventSecret = null;
  let eventSecretEnc = null;
  if (eventUrl) {
    eventSecret = generateEventSecret();
    try {
      eventSecretEnc = await sealEventSecret(env, eventSecret);
    } catch {
      return bridgeError("INTERNAL", "event_secret_not_configured", { status: 503 });
    }
  }
  const created = await createProduct(env, {
    productId, name, secretHash: await sha256Hex(productSecret), redirectUris, urlDomains, scopes, productKey, eventUrl, eventSecretEnc, identityReturnUris,
  });
  if (created.keyTaken) return invalidRequest("product_key is already in use");
  if (created.conflict) return bridgeError("INTERNAL", "Please retry");

  await audit(env, { actorType: "system", actorId: "admin_endpoint", action: "product_registered", detail: { product_id: productId, scopes } });
  return json({
    product_id: productId, product_secret: productSecret, name,
    redirect_uris: redirectUris, url_domains: urlDomains, scopes, product_key: productKey,
    ...(eventUrl ? { event_url: eventUrl, event_signing_secret: eventSecret } : {}),
    ...(identityReturnUris ? { identity_return_uris: identityReturnUris } : {}),
  }, 201);
}

/**
 * PATCH /bridge/v1/admin/products/{product_id}（LM-4D，營運）：
 *   - product_key：只能從 NULL 設一次（同值冪等），全域唯一
 *   - scopes：只能增加（新集合必須包含舊的），限 LINK_SCOPES；既有連結不會自動取得新 scope（要重新授權）
 *   - url_domains：只能增加（新集合必須包含舊的）；同一個請求內的 event_url 可以用新增的網域
 */
async function handleUpdateProduct(request, env, productId) {
  const denied = await requireAdmin(request, env, "PATCH");
  if (denied) return denied;
  if (!PRODUCT_ID_RE.test(productId)) return notFound("Product not found");

  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const product = await getProduct(env, productId);
  if (!product) return notFound("Product not found");

  let productKey = null;
  if (body.product_key !== undefined) {
    if (typeof body.product_key !== "string" || !PRODUCT_KEY_RE.test(body.product_key)) {
      return invalidRequest("product_key must match ^[a-z][a-z0-9]{1,15}$");
    }
    if (product.productKey && product.productKey !== body.product_key) return invalidRequest("product_key cannot be changed once set");
    productKey = body.product_key;
  }

  let scopes = null;
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || !body.scopes.every((x) => typeof x === "string" && LINK_SCOPES.includes(x))) {
      return invalidRequest(`scopes must be among: ${LINK_SCOPES.join(", ")}`);
    }
    if (!product.scopes.every((x) => body.scopes.includes(x))) return invalidRequest("scopes can only be added, not removed");
    scopes = onlyLinkScopes(body.scopes);
  }

  // url_domains 只能增加（新集合必須包含舊的）：它同時是通知按鈕網址與 event_url 的白名單，縮小會讓既有設定失效；
  // 增加的網域同一個請求內的 event_url 就可以用
  let urlDomains = null;
  if (body.url_domains !== undefined) {
    if (!Array.isArray(body.url_domains) || body.url_domains.length > MAX_URL_DOMAINS
      || !body.url_domains.every((d) => typeof d === "string" && DOMAIN_RE.test(d))) {
      return invalidRequest("url_domains must be an array of lowercase host names (no scheme, port or wildcard)");
    }
    if (!product.urlDomains.every((d) => body.url_domains.includes(d))) return invalidRequest("url_domains can only be added, not removed");
    urlDomains = [...new Set(body.url_domains)];
  }
  const finalUrlDomains = urlDomains ?? product.urlDomains;

  // LM-4B：event_url（https、主機在 url_domains 內）與簽章密鑰（登記／輪替時回一次）
  let eventUrl = null;
  if (body.event_url !== undefined) {
    const checked = checkEventUrl(body.event_url, finalUrlDomains);
    if (!checked.ok) return invalidRequest("event_url must be an https URL whose host is in url_domains");
    eventUrl = checked.url;
  }
  let identityReturnUris = null;
  if (body.identity_return_uris !== undefined) {
    const checked = parseIdentityReturnUris(body.identity_return_uris, env.BRIDGE_ALLOW_LOCALHOST_REDIRECT === "1");
    if (checked.error) return invalidRequest(checked.error);
    identityReturnUris = checked.value;
  }
  if (body.rotate_event_secret !== undefined && typeof body.rotate_event_secret !== "boolean") {
    return invalidRequest("rotate_event_secret must be a boolean");
  }
  const finalScopes = scopes ?? product.scopes;
  const finalKey = product.productKey ?? productKey;
  const finalEventUrl = eventUrl ?? product.eventUrl;
  const wantsEvents = finalScopes.includes("events:receive");
  if (wantsEvents && !finalKey) return invalidRequest("events:receive requires product_key");
  if (wantsEvents && !finalEventUrl) return invalidRequest("events:receive requires event_url");
  if (!wantsEvents && eventUrl) return invalidRequest("event_url requires the events:receive scope");
  const wantsIdentity = finalScopes.includes("identity:read");
  if (wantsIdentity && !finalKey) return invalidRequest("identity:read requires product_key");
  if (wantsIdentity && !(identityReturnUris ?? product.identityReturnUris).length) return invalidRequest("identity:read requires identity_return_uris");
  if (!wantsIdentity && identityReturnUris) return invalidRequest("identity_return_uris requires the identity:read scope");

  let eventSecret = null;
  let eventSecretEnc = null;
  if (body.rotate_event_secret === true || (wantsEvents && !product.eventSecretEnc)) {
    if (!wantsEvents) return invalidRequest("rotate_event_secret requires the events:receive scope");
    eventSecret = generateEventSecret();
    try {
      eventSecretEnc = await sealEventSecret(env, eventSecret);
    } catch {
      return bridgeError("INTERNAL", "event_secret_not_configured", { status: 503 });
    }
  }
  if (productKey === null && scopes === null && urlDomains === null && eventUrl === null && eventSecretEnc === null && identityReturnUris === null) {
    return invalidRequest("Nothing to update (product_key, scopes, url_domains, event_url, identity_return_uris or rotate_event_secret)");
  }

  const updated = await updateProduct(env, { productId, productKey, scopes, urlDomains, eventUrl, eventSecretEnc, identityReturnUris });
  if (updated.keyTaken) return invalidRequest("product_key is already in use");
  if (updated.keyLocked) return invalidRequest("product_key cannot be changed once set");
  if (updated.notFound) return notFound("Product not found");

  await audit(env, {
    actorType: "system", actorId: "admin_endpoint", action: "product_updated",
    detail: { product_id: productId, scopes: scopes ?? product.scopes },
  });
  const fresh = await getProduct(env, productId);
  return json({
    product_id: productId, name: fresh.name, product_key: fresh.productKey, scopes: fresh.scopes, event_url: fresh.eventUrl,
    identity_return_uris: fresh.identityReturnUris, url_domains: fresh.urlDomains,
    ...(eventSecret ? { event_signing_secret: eventSecret } : {}),
  });
}

// ── 授權參數驗證（authorize／preview／approve 共用）──

/**
 * 驗證 product_id、state、redirect_uri；redirect_uri 必須與產品登記值逐字元相同。
 * 所有失敗都是同一則訊息：不洩漏「產品不存在」「已停用」「uri 不符」的差別。
 *
 * @returns {Promise<{ok: true, product: object, state: string, redirectUri: string} | {ok: false}>}
 */
async function validateAuthorizeParams(env, { productId, state, redirectUri }) {
  if (typeof productId !== "string" || !PRODUCT_ID_RE.test(productId)) return { ok: false };
  if (typeof state !== "string" || state === "" || state.length > MAX_STATE_LENGTH) return { ok: false };
  if (typeof redirectUri !== "string" || redirectUri === "" || redirectUri.length > MAX_URI_LENGTH) return { ok: false };
  const product = await getProduct(env, productId);
  if (!product || product.disabled) return { ok: false };
  if (!product.redirectUris.includes(redirectUri)) return { ok: false };
  return { ok: true, product, state, redirectUri };
}

const badAuthorizeRequest = () => invalidRequest("Invalid product_id, state or redirect_uri");

function queryParams(request) {
  const q = new URL(request.url).searchParams;
  return { productId: q.get("product_id"), state: q.get("state"), redirectUri: q.get("redirect_uri") };
}

async function handleAuthorize(request, env) {
  if (request.method !== "GET") return notFound();
  const checked = await validateAuthorizeParams(env, queryParams(request));
  // 驗證不過：直接顯示錯誤，絕不導向（未驗證的）redirect_uri
  if (!checked.ok) return badAuthorizeRequest();

  const target = new URL(`${mountPrefix(env)}/pages/link_authorize.html`, request.url);
  target.searchParams.set("product_id", checked.product.productId);
  target.searchParams.set("state", checked.state);
  target.searchParams.set("redirect_uri", checked.redirectUri);
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

// ── 人主體（LIFF）──

/** @returns {Promise<{userId: string} | {response: Response}>} */
export async function requireUser(request, env) {
  const auth = await authenticateUser(request, env);
  if (auth.authenticated) return { userId: auth.userId };
  if (auth.status === 429) {
    return { response: bridgeError("RATE_LIMITED", "Too many requests", { headers: { "Retry-After": String(auth.retryAfter) } }) };
  }
  return { response: bridgeError("INVALID_KEY", "Authentication required", { status: 401 }) };
}

async function handlePreview(request, env) {
  if (request.method !== "GET") return notFound();
  const user = await requireUser(request, env);
  if (user.response) return user.response;

  const checked = await validateAuthorizeParams(env, queryParams(request));
  if (!checked.ok) return badAuthorizeRequest();

  const bots = await listOwnedBots(env, user.userId);
  return json({
    product: { product_id: checked.product.productId, name: checked.product.name },
    scopes: onlyLinkScopes(checked.product.scopes),
    bots: bots.map((b) => ({ bot_id: b.botId, display_name: b.displayName })),
    // 使用者按「取消」時要導去的位址（已驗證過的 redirect_uri；前端不必也不應自己組）
    cancel_redirect_to: withParams(checked.redirectUri, { error: "access_denied", state: checked.state }),
  });
}

async function handleApprove(request, env) {
  if (request.method !== "POST") return notFound();
  const user = await requireUser(request, env);
  if (user.response) return user.response;

  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const checked = await validateAuthorizeParams(env, {
    productId: body.product_id, state: body.state, redirectUri: body.redirect_uri,
  });
  if (!checked.ok) return badAuthorizeRequest();

  if (typeof body.bot_id !== "string" || !BOT_ID_RE.test(body.bot_id)) return invalidRequest("bot_id is required");
  // owner 權限檢查：以 permissions 為準；不是 owner 與 bot 不存在回同一個 404
  const bot = await getOwnedBot(env, user.userId, body.bot_id);
  if (!bot) return notFound("Bot not found");

  const scopes = onlyLinkScopes(checked.product.scopes); // 預設全開，受產品登記的上限約束
  const code = randomToken("lmc_");
  const now = Date.now();
  await createAuthCode(env, {
    codeHash: await sha256Hex(code), productId: checked.product.productId, botId: bot.botId,
    redirectUri: checked.redirectUri, scopes, createdBy: user.userId, expiresAt: now + AUTH_CODE_TTL_MS, now,
  });
  return json({ redirect_to: withParams(checked.redirectUri, { code, state: checked.state }) });
}

// ── 授權碼換連結與金鑰（產品密鑰）──

// 假雜湊：產品不存在時也做一次比對，讓「不存在」與「密鑰錯」耗時相近
const DUMMY_HASH = "0".repeat(64);

async function failExchange(env, product, code, message) {
  if (product) {
    await audit(env, {
      actorType: "system", actorId: product.productId, action: "code_exchange_failed", result: "failed",
      detail: { product_id: product.productId, error_code: code },
    });
  }
  return code === "INVALID_KEY" ? invalidKey() : bridgeError(code, message);
}

async function handleToken(request, env, ctx) {
  if (request.method !== "POST") return notFound();

  const header = request.headers.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.substring(7).trim() : "";
  const m = PRODUCT_SECRET_RE.exec(presented);
  const claimedProductId = m ? `prd_${m[1]}` : "unknown";

  // 以 (來源 IP, product_id) 限流，擋暴力猜碼。沿用 KV 限流器：缺 KV binding 或 KV 失敗時 fail-open（既有行為）
  const limited = await checkRateLimit(env, `lnktoken.${clientIp(request)}.${claimedProductId}`, TOKEN_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);

  const product = m ? await getProduct(env, claimedProductId) : null;
  const hashMatches = timingSafeEqual(
    new TextEncoder().encode(await sha256Hex(presented)),
    new TextEncoder().encode(product ? product.secretHash : DUMMY_HASH)
  );
  if (!product || !hashMatches || product.disabled) {
    // 只有「產品真的存在」才記稽核（避免任意 product_id 灌爆 audit_log）
    return failExchange(env, product && !product.disabled ? product : null, "INVALID_KEY");
  }

  const body = await readJsonBody(request);
  if (!body || typeof body.code !== "string" || typeof body.redirect_uri !== "string") {
    return failExchange(env, product, "INVALID_REQUEST", "code and redirect_uri are required");
  }

  const bad = () => failExchange(env, product, "INVALID_CODE", "Invalid or expired code");
  if (!AUTH_CODE_RE.test(body.code) || body.redirect_uri.length > MAX_URI_LENGTH) return bad();

  const consumed = await consumeAuthCode(env, {
    codeHash: await sha256Hex(body.code), productId: product.productId, redirectUri: body.redirect_uri,
  });
  if (!consumed) return bad();

  // 連結 scope ⊆ 發碼當下的 scope ⊆ 產品登記的 scope ⊆ LINK_SCOPES（產品之後被縮小也要生效）
  const scopes = onlyLinkScopes(consumed.scopes).filter((s) => product.scopes.includes(s));
  if (scopes.length === 0) return bad();

  const linkId = `lnk_${randomHex(8)}`;
  const serviceKey = generateBrokerKey();
  // LM-4D：被取代的連結下有分眾的人，搬家後分眾會被清掉 → 先記下來，之後重新計算
  const affected = await captureReplacedRecipients(env, { productId: product.productId, botId: consumed.botId });
  const { revokedLinkIds } = await createLinkWithKey(env, {
    linkId, productId: product.productId, botId: consumed.botId, scopes, createdBy: consumed.createdBy,
    keyHash: await sha256Hex(serviceKey),
  });

  await audit(env, {
    actorType: "user", actorId: consumed.createdBy, botId: consumed.botId, action: "link_authorized",
    detail: { product_id: product.productId, link_id: linkId, scopes },
  });
  for (const oldId of revokedLinkIds) {
    await audit(env, {
      actorType: "user", actorId: consumed.createdBy, botId: consumed.botId, action: "link_revoked",
      detail: { product_id: product.productId, link_id: oldId },
    });
  }
  if (affected.recipients.length > 0) await defer(ctx, refreshRecipients(env, affected));

  return json({
    link_id: linkId, service_key: serviceKey, scopes, bot_display_name: await getBotDisplayName(env, consumed.botId),
  });
}

// ── 連結金鑰（只能操作自己這條連結）──

export function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 路徑上的 link_id 與金鑰所屬連結不同（或格式不對）→ NOT_FOUND，不洩漏他人連結是否存在 */
function ownLink(principal, linkId) {
  return LINK_ID_RE.test(linkId) && linkId === principal.linkId;
}

async function handleGetLink(request, env, principal, linkId) {
  if (!ownLink(principal, linkId)) return notFound("Link not found");
  const link = await getLink(env, principal.linkId);
  if (!link) return notFound("Link not found");
  return json({
    link_id: link.linkId, status: link.status, scopes: onlyLinkScopes(link.scopes),
    bot_display_name: await getBotDisplayName(env, link.botId),
    created_at: isoOrNull(link.createdAt), revoked_at: isoOrNull(link.revokedAt),
  });
}

async function handleDeleteOwnLink(request, env, principal, linkId, ctx) {
  if (!ownLink(principal, linkId)) return notFound("Link not found");
  const affected = await captureLinkRecipients(env, principal.linkId, { botId: principal.botId, productId: principal.productId });
  if (!(await revokeLink(env, { linkId: principal.linkId, botId: principal.botId }))) {
    return bridgeError("LINK_REVOKED", "Link is revoked");
  }
  if (affected.recipients.length > 0) await defer(ctx, refreshRecipients(env, affected));
  await audit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "link_revoked",
    detail: { product_id: principal.productId, link_id: principal.linkId },
  });
  return noContent();
}

async function handleRotateOwnKey(request, env, principal, linkId) {
  if (!ownLink(principal, linkId)) return notFound("Link not found");
  const serviceKey = generateBrokerKey();
  const rotated = await rotateLinkKey(env, {
    linkId: principal.linkId, botId: principal.botId, keyHash: await sha256Hex(serviceKey),
  });
  if (!rotated) return bridgeError("LINK_REVOKED", "Link is revoked");
  await audit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "key_rotated",
    detail: { product_id: principal.productId, link_id: principal.linkId },
  });
  return json({ service_key: serviceKey });
}

// ── 後台（人主體 + owner）──

/** bot 來自 X-Bot-Id 或 ?bot_id=，且必須通過 owner 檢查 */
export async function resolveOwnedBot(request, env, userId) {
  const botId = request.headers.get("X-Bot-Id") || new URL(request.url).searchParams.get("bot_id");
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) return { response: invalidRequest("X-Bot-Id is required") };
  const bot = await getOwnedBot(env, userId, botId);
  if (!bot) return { response: notFound("Bot not found") };
  return { bot };
}

async function handleAdminList(request, env) {
  if (request.method !== "GET") return notFound();
  const user = await requireUser(request, env);
  if (user.response) return user.response;
  const resolved = await resolveOwnedBot(request, env, user.userId);
  if (resolved.response) return resolved.response;

  const links = await listLinksForBot(env, resolved.bot.botId);
  return json({
    links: links.map((l) => ({
      link_id: l.linkId, product_id: l.productId, product_name: l.productName, product_key: l.productKey, status: l.status,
      scopes: onlyLinkScopes(l.scopes), created_at: isoOrNull(l.createdAt), revoked_at: isoOrNull(l.revokedAt),
    })),
  });
}

async function handleAdminRevoke(request, env, linkId, ctx) {
  const user = await requireUser(request, env);
  if (user.response) return user.response;
  const resolved = await resolveOwnedBot(request, env, user.userId);
  if (resolved.response) return resolved.response;

  const link = LINK_ID_RE.test(linkId) ? await getLink(env, linkId) : null;
  // 不存在與「屬於別的 bot」回同一個 404
  if (!link || link.botId !== resolved.bot.botId) return notFound("Link not found");

  const affected = await captureLinkRecipients(env, linkId, { botId: resolved.bot.botId, productId: link.productId });
  if (await revokeLink(env, { linkId, botId: resolved.bot.botId })) {
    await audit(env, {
      actorType: "user", actorId: user.userId, botId: resolved.bot.botId, action: "link_revoked",
      detail: { product_id: link.productId, link_id: linkId },
    });
    if (affected.recipients.length > 0) await defer(ctx, refreshRecipients(env, affected));
  }
  return noContent(); // 已撤銷的再撤銷一次也是 204（冪等）
}

// ── 事件備用內容（LM-4B；人主體 + owner）──

const FALLBACK_ACTION_RE = /^[a-z][a-z0-9_.-]{0,31}$/;

/** 備用內容的共同前置：人主體、owner 的 bot、product_key 對應的產品 */
async function resolveFallbackScope(request, env, productKey) {
  const user = await requireUser(request, env);
  if (user.response) return { response: user.response };
  const resolved = await resolveOwnedBot(request, env, user.userId);
  if (resolved.response) return { response: resolved.response };
  if (typeof productKey !== "string" || !PRODUCT_KEY_RE.test(productKey)) return { response: invalidRequest("product_key is required") };
  const product = await getProductByKey(env, productKey);
  if (!product) return { response: notFound("Product not found") };
  return { user, bot: resolved.bot, product };
}

async function handleFallbackList(request, env) {
  const url = new URL(request.url);
  const scope = await resolveFallbackScope(request, env, url.searchParams.get("product_key"));
  if (scope.response) return scope.response;
  const rows = await listEventFallbacks(env, { botId: scope.bot.botId, productKey: scope.product.productKey });
  return json({ product_key: scope.product.productKey, fallbacks: rows.map((r) => ({ action: r.action, content: r.content })) });
}

async function handleFallbackPut(request, env) {
  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const scope = await resolveFallbackScope(request, env, body.product_key);
  if (scope.response) return scope.response;
  if (typeof body.action !== "string" || !FALLBACK_ACTION_RE.test(body.action)) return invalidRequest("action must match ^[a-z][a-z0-9_.-]{0,31}$");
  const checked = validateContent(body.content);
  if (checked.error) return invalidRequest(checked.error);
  const content = checked.value;
  if (content.action) {
    const url = checkActionUrl(content.action.url, scope.product.urlDomains);
    if (!url.ok) return invalidRequest("action.url must be https and its host must be in the product's url_domains");
    content.action = { label: content.action.label, url: url.url };
  }
  const stored = { title: content.title, body: content.body, ...(content.action ? { action: content.action } : {}) };
  await putEventFallback(env, { botId: scope.bot.botId, productKey: scope.product.productKey, action: body.action, content: stored });
  await audit(env, {
    actorType: "user", actorId: scope.user.userId, botId: scope.bot.botId, action: "event_fallback_set",
    detail: { product_id: scope.product.productId, event_action: body.action },
  });
  return json({ product_key: scope.product.productKey, action: body.action, content: stored });
}

async function handleFallbackDelete(request, env) {
  const url = new URL(request.url);
  const scope = await resolveFallbackScope(request, env, url.searchParams.get("product_key"));
  if (scope.response) return scope.response;
  const action = url.searchParams.get("action");
  if (typeof action !== "string" || !FALLBACK_ACTION_RE.test(action)) return invalidRequest("action must match ^[a-z][a-z0-9_.-]{0,31}$");
  const removed = await deleteEventFallback(env, { botId: scope.bot.botId, productKey: scope.product.productKey, action });
  if (removed) {
    await audit(env, {
      actorType: "user", actorId: scope.user.userId, botId: scope.bot.botId, action: "event_fallback_deleted",
      detail: { product_id: scope.product.productId, event_action: action },
    });
  }
  return noContent(); // 本來就沒有也是 204（冪等）
}

// ── 路由 ──

function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function dispatch(request, env, pathname, ctx) {
  const parts = pathname.split("/").filter(Boolean); // ["bridge","v1", root, ...]
  const [, , root, a, b] = parts;
  const method = request.method;
  const n = parts.length;

  if (root === "admin") {
    if (n === 4 && a === "products") return handleRegisterProduct(request, env);
    if (n === 5 && a === "products") {
      const productId = decodeSegment(b);
      return productId === null ? notFound() : handleUpdateProduct(request, env, productId);
    }
    if (n === 4 && a === "links" && method === "GET") return handleAdminList(request, env);
    if (n === 4 && a === "event-fallbacks") {
      if (method === "GET") return handleFallbackList(request, env);
      if (method === "PUT") return handleFallbackPut(request, env);
      if (method === "DELETE") return handleFallbackDelete(request, env);
      return notFound();
    }
    if (n === 5 && a === "links" && method === "DELETE") {
      const linkId = decodeSegment(b);
      return linkId === null ? notFound() : handleAdminRevoke(request, env, linkId, ctx);
    }
    return notFound();
  }

  if (root === "link") {
    if (n === 4 && a === "authorize") return handleAuthorize(request, env);
    if (n === 5 && a === "authorize" && b === "preview") return handlePreview(request, env);
    if (n === 5 && a === "authorize" && b === "approve") return handleApprove(request, env);
    return notFound();
  }

  if (root === "links") {
    if (n === 4 && a === "token") return handleToken(request, env, ctx);
    const linkId = a === undefined ? null : decodeSegment(a);
    if (linkId === null) return notFound();
    if (n === 4 && method === "GET") return withLink(handleGetLink, "link:manage")(request, env, linkId);
    if (n === 4 && method === "DELETE") return withLink(handleDeleteOwnLink, "link:manage")(request, env, linkId, ctx);
    if (n === 5 && b === "rotate-key" && method === "POST") return withLink(handleRotateOwnKey, "link:manage")(request, env, linkId);
    return notFound();
  }

  return notFound();
}

/**
 * 處理一個連結流程請求（pathname 已去掉掛載前綴）。例外隔離由 bridge/index.js 負責，
 * 這裡只把資料庫失敗變成新格式的 503（連結流程的所有回應都是 bridgeError 格式）。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
export async function route(request, env, pathname, ctx) {
  try {
    return await dispatch(request, env, pathname, ctx);
  } catch (err) {
    if (err instanceof BridgeDbError) return unavailable();
    // 只記訊息，不記 stack，也不回給呼叫端
    console.error("[Links] unhandled:", err && err.message);
    return bridgeError("INTERNAL", "Internal error");
  }
}
