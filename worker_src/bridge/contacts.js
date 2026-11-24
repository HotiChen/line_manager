/**
 * 聯絡人綁定端點（LM-3A）。設計見 docs/integration/lm-3a-plan.md。
 *
 *   POST   /bridge/v1/contacts/bind-tokens            連結金鑰（contacts:bind）  產生綁定碼 → 201 {bind_code, bind_url, expires_at}
 *                                                       body：external_contact_ref；選填 allow_rebind（boolean，預設 false）
 *   GET    /bridge/v1/contacts/{external_contact_ref}  連結金鑰（contacts:bind）  → 200 {external_contact_ref, status, bound_at}
 *   DELETE /bridge/v1/contacts/{external_contact_ref}  連結金鑰（contacts:bind）  解除綁定 → 204
 *   PUT    /bridge/v1/contacts/{external_contact_ref}/segment  連結金鑰（segments:write）  設定／清除分眾 → 204（LM-4D）
 *
 * LM-4D 分眾：只對 bound；冪等（同值不寫、不重算）；變更後在 ctx.waitUntil 內經 segments.js 重新計算 Rich Menu，
 * LINE 失敗不影響回應。回應與稽核不含 LINE userId、ref、分眾值、Rich Menu id。
 *
 * 安全性質：
 *   - 認證一律 withLink(…, "contacts:bind")；系統金鑰是 INVALID_KEY，撤銷連結是 LINK_REVOKED
 *   - 所有查詢都以「金鑰所屬連結」限定範圍：別條連結的 ref 看起來就是 unbound，永遠碰不到別人的綁定
 *   - 回應、audit、log 都不含 LINE userId；綁定碼只在建立當下回一次（資料庫只存 SHA-256）
 *   - audit：contact_bind_token_created、contact_unbound，detail 只有 product_id 與 link_id（不含 ref）
 *   - DELETE 是冪等的：不論原本有沒有綁定或待用碼都回 204（不洩漏「ref 是否存在過」）
 *   - 缺 BRIDGE_DB 或查詢失敗 → 503 INTERNAL bridge_not_configured（fail-closed）
 *   - 綁定碼 `LM-XXXX-XXXX-XXXX`（12 碼 Crockford base32，60 bit），48 小時有效；資料庫存的是無連字號標準形的 SHA-256
 *   - allow_rebind（M-02／D6）：預設 false —— 這個 ref 已被另一位 LINE 使用者綁定時，用此碼綁定會被拒絕（碼不被消耗）；
 *     true 才允許覆蓋（原綁定者會收到「你的綁定已被更換」）。非 boolean → 400 INVALID_REQUEST
 *   - 缺 0004 遷移 → 發碼的 INSERT 失敗 → 503 bridge_not_configured（fail-closed）
 *   - 路徑上的 ref 不合法（格式不符、無法解碼）→ 404 NOT_FOUND；body 的 ref 不合法 → 400 INVALID_REQUEST
 */
import { getBotBasicId } from "../lm_service.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { checkRateLimit } from "../middleware/rate_limiter.js";
import { bridgeError } from "./errors.js";
import { withLink } from "./auth.js";
import { json, noContent, rateLimited, readJsonBody, isoOrNull } from "./links.js";
import { generateBindCode, formatBindCode, BIND_CODE_TTL_MS } from "./binding.js";
import { BridgeDbError, createBindCode, getContactSnapshot, deleteContact, writeAudit, getProduct, setContactSegment } from "./db.js";
import { CONTACT_REF_RE } from "./content.js";
import { SEGMENT_RE, defer, captureContactRecipients, refreshRecipients } from "./segments.js";

export { CONTACT_REF_RE };
const BIND_TOKEN_RATE_LIMIT = { limit: 30, windowSec: 60 };
const SEGMENT_RATE_LIMIT = { limit: 60, windowSec: 60 };
const MAX_CODE_ATTEMPTS = 3;
/** LINE 官方帳號 basic ID：`@` 開頭的英數字（含 . _ -） */
const BASIC_ID_RE = /^@?[A-Za-z0-9._-]{1,64}$/;

const notFound = (message = "Not found") => bridgeError("NOT_FOUND", message);
const invalidRequest = (message) => bridgeError("INVALID_REQUEST", message);

function audit(env, entry) {
  return writeAudit(env, { result: "ok", ...entry });
}

/**
 * LINE 預填訊息連結：https://line.me/R/oaMessage/@basic_id/?text（text 是完整的綁定碼）。
 * basic ID 的 `@` 留在路徑上，其餘字元編碼；格式怪異或沒有 basic ID → null（產品改成顯示碼，請客戶自己傳）。
 *
 * @param {string|null} basicId
 * @param {string} code
 * @returns {string|null}
 */
export function buildBindUrl(basicId, code) {
  if (typeof basicId !== "string" || !BASIC_ID_RE.test(basicId)) return null;
  const id = basicId.startsWith("@") ? basicId.slice(1) : basicId;
  return `https://line.me/R/oaMessage/@${encodeURIComponent(id)}/?${encodeURIComponent(code)}`;
}

/**
 * 狀態推導（不存）：連結已撤銷或產品停用 → disabled；有列且 blocked → blocked；有列 → bound；
 * 無列但有有效未用碼 → pending；其餘 → unbound。
 *
 * @param {null | {linkStatus: string, productDisabled: boolean, contact: null | {status: string}, hasPendingCode: boolean}} snapshot
 * @returns {"disabled"|"blocked"|"bound"|"pending"|"unbound"}
 */
export function deriveContactStatus(snapshot) {
  if (!snapshot || snapshot.linkStatus !== "active" || snapshot.productDisabled) return "disabled";
  if (snapshot.contact) return snapshot.contact.status === "blocked" ? "blocked" : "bound";
  return snapshot.hasPendingCode ? "pending" : "unbound";
}

// ── 端點 ──

async function handleCreateBindToken(request, env, principal) {
  const limited = await checkRateLimit(env, `bindtoken.${principal.linkId}`, BIND_TOKEN_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);

  const body = await readJsonBody(request);
  if (!body) return invalidRequest("Invalid JSON body");
  const ref = body.external_contact_ref;
  if (typeof ref !== "string" || !CONTACT_REF_RE.test(ref)) {
    return invalidRequest("external_contact_ref must match ^[A-Za-z0-9_-]{8,64}$");
  }

  if (body.allow_rebind !== undefined && typeof body.allow_rebind !== "boolean") {
    return invalidRequest("allow_rebind must be a boolean");
  }
  const allowRebind = body.allow_rebind === true;

  const now = Date.now();
  const expiresAt = now + BIND_CODE_TTL_MS;
  let code = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && code === null; attempt++) {
    const candidate = generateBindCode();
    const created = await createBindCode(env, {
      codeHash: await sha256Hex(candidate), linkId: principal.linkId, botId: principal.botId, ref, expiresAt, allowRebind, now,
    });
    if (created.capped) return bridgeError("RATE_LIMITED", "Too many pending bind codes for this link");
    if (created.created) code = candidate;
    // conflict（雜湊撞到既有列，約 2^-60）：換一組再試
  }
  if (code === null) return bridgeError("INTERNAL", "Please retry");

  await audit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "contact_bind_token_created",
    detail: { product_id: principal.productId, link_id: principal.linkId },
  });
  const basicId = await getBotBasicId(env, principal.botId);
  const display = formatBindCode(code);
  return json({ bind_code: display, bind_url: buildBindUrl(basicId, display), expires_at: isoOrNull(expiresAt) }, 201);
}

async function handleGetContact(request, env, principal, ref) {
  if (!CONTACT_REF_RE.test(ref)) return notFound("Contact not found");
  const snapshot = await getContactSnapshot(env, { linkId: principal.linkId, ref });
  const status = deriveContactStatus(snapshot);
  const showTime = status === "bound" || status === "blocked";
  return json({
    external_contact_ref: ref, status, bound_at: showTime ? isoOrNull(snapshot.contact.boundAt) : null,
    segment: status === "bound" ? snapshot.contact.segment ?? null : null,
  });
}

async function handleDeleteContact(request, env, principal, ref, ctx) {
  if (!CONTACT_REF_RE.test(ref)) return notFound("Contact not found");
  // LM-4D：有分眾的綁定被解除 → 刪除後重新計算（先記下對象，刪了就查不到）
  const affected = await captureContactRecipients(env, { linkId: principal.linkId, ref, onlySegmented: true });
  const removed = await deleteContact(env, { linkId: principal.linkId, ref });
  if (affected.recipients.length > 0) await defer(ctx, refreshRecipients(env, affected));
  if (removed.contactDeleted || removed.codesDeleted > 0) {
    await audit(env, {
      actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "contact_unbound",
      detail: { product_id: principal.productId, link_id: principal.linkId },
    });
  }
  return noContent(); // 本來就沒有也是 204（冪等）
}

async function handlePutSegment(request, env, principal, ref, ctx) {
  if (!CONTACT_REF_RE.test(ref)) return notFound("Contact not found");
  const limited = await checkRateLimit(env, `segment.${principal.linkId}`, SEGMENT_RATE_LIMIT);
  if (!limited.allowed) return rateLimited(limited.resetAt);

  const body = await readJsonBody(request);
  if (!body || !Object.hasOwn(body, "segment")) return invalidRequest("segment is required (string or null)");
  const segment = body.segment;
  if (segment !== null && (typeof segment !== "string" || !SEGMENT_RE.test(segment))) {
    return invalidRequest("segment must match ^[a-z][a-z0-9_-]{0,31}$ or be null");
  }

  const product = await getProduct(env, principal.productId);
  if (!product || !product.productKey) return invalidRequest("product has no product_key; ask the LM operator to set it");

  const result = await setContactSegment(env, { linkId: principal.linkId, ref, segment });
  if (!result.found) return bridgeError("CONTACT_NOT_BOUND", "Contact is not bound");
  if (result.status === "blocked") return bridgeError("RECIPIENT_BLOCKED", "Recipient has blocked the account");
  if (!result.changed) return noContent(); // 冪等：值沒變，不重算

  await audit(env, {
    actorType: "service_key", actorId: principal.linkId, botId: principal.botId, action: "contact_segment_set",
    detail: { product_id: principal.productId, link_id: principal.linkId, cleared: segment === null },
  });
  const affected = await captureContactRecipients(env, { linkId: principal.linkId, ref });
  await defer(ctx, refreshRecipients(env, affected));
  return noContent();
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
  const parts = pathname.split("/").filter(Boolean); // ["bridge","v1","contacts", seg, ("segment")]
  const n = parts.length;
  const seg = parts[3];
  const method = request.method;
  if (n === 5 && parts[4] === "segment") {
    if (method !== "PUT") return notFound();
    const ref = decodeSegment(seg);
    if (ref === null) return notFound();
    return withLink(handlePutSegment, "segments:write")(request, env, ref, ctx);
  }
  if (n !== 4) return notFound();

  if (seg === "bind-tokens") {
    return method === "POST" ? withLink(handleCreateBindToken, "contacts:bind")(request, env) : notFound();
  }
  if (method !== "GET" && method !== "DELETE") return notFound();
  const ref = decodeSegment(seg);
  if (ref === null) return notFound();
  const handler = method === "GET" ? handleGetContact : handleDeleteContact;
  return withLink(handler, "contacts:bind")(request, env, ref, ctx);
}

/**
 * 處理一個 /bridge/v1/contacts/* 請求（pathname 已去掉掛載前綴）。
 *
 * @param {Request} request
 * @param {Object} env
 * @param {string} pathname
 * @param {{waitUntil?: Function}} [ctx]
 * @returns {Promise<Response>}
 */
export async function route(request, env, pathname, ctx) {
  try {
    return await dispatch(request, env, pathname, ctx);
  } catch (err) {
    if (err instanceof BridgeDbError) return bridgeError("INTERNAL", "bridge_not_configured", { status: 503 });
    // 只記訊息，不記 stack，也不回給呼叫端
    console.error("[Contacts] unhandled:", err && err.message);
    return bridgeError("INTERNAL", "Internal error");
  }
}
