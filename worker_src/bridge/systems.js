/**
 * 系統註冊與 service key（橋接 API，人主體操作）
 *
 *   POST   /bridge/v1/systems                       註冊，回傳 apiKey（`brk_<前綴>_<密鑰>`，只回這一次）
 *   GET    /bridge/v1/systems                       列出
 *   PATCH  /bridge/v1/systems/{system}              改 webhookUrl / events / disabled
 *   POST   /bridge/v1/systems/{system}/keys/rotate  輪替 key（舊 key 立即失效）
 *   DELETE /bridge/v1/systems/{system}              刪除（key 立即失效）
 *
 * 全部要求 owner 權限，且只接受人主體（LIFF）。service key 打不進這裡 ——
 * 「key 不能用來發 key」，見 bridge/routes.js 的 isBridgeServiceRoute。
 *
 * 儲存：D1（binding BRIDGE_DB，SQL 全在 ./db.js；結構見 migrations/0001_bridge_init.sql）
 *   - 註冊：系統＋第一把 key 同一個 batch；撞 (bot_id, system) 主鍵 → 409，不先讀後寫
 *   - 輪替／刪除：batch（交易），全成功或全回滾；撤銷過的 key 紀錄保留供稽核
 *   - 每個動作寫一筆 audit_log（best-effort，失敗不影響回應）
 *   - 缺 BRIDGE_DB 或查詢失敗 → 503 bridge_not_configured（fail-closed，不退回 KV）
 */
import { jsonResponse } from "../lib/utils.js";
import { withPermission } from "../lm_service.js";
import { sha256Hex, generateBrokerKey } from "../lib/crypto_util.js";
import {
  BridgeDbError, bridgeUnavailable, createSystemWithKey, listSystems, getSystem, updateSystem,
  rotateKey, deleteSystem, writeAudit,
} from "./db.js";

const SYSTEM_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ALLOWED_SCOPES = ["raw:push", "members:read", "tags:write"];
const DEFAULT_SCOPES = ["raw:push"];
// 過渡相容（LM-1C）：註冊請求若帶舊名 messages:push，視為 raw:push，正規化後才寫入 D1（不寫舊名）。
const LEGACY_SCOPE_ALIASES = { "messages:push": "raw:push" };
const MAX_EVENTS = 20;
const MAX_URL_LENGTH = 2048;

function json(data, status = 200) {
  return jsonResponse(data, status);
}

function secretJson(data, status) {
  const res = jsonResponse(data, status);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function bad(message) {
  return json({ success: false, error: message }, 400);
}

function notFound() {
  return json({ success: false, error: "System not found" }, 404);
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** @returns {string|null} 錯誤訊息；合法回 null */
function validateWebhookUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return "webhookUrl must be a string";
  let u;
  try {
    u = new URL(value);
  } catch {
    return "webhookUrl is not a valid URL";
  }
  if (u.protocol !== "https:") return "webhookUrl must use https";
  if (u.username || u.password) return "webhookUrl must not contain credentials";
  if (isPrivateHost(u.hostname)) return "webhookUrl must not point to a private or local address";
  return null;
}

/** @returns {string|null} */
function validateEvents(value) {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return `events must be an array (max ${MAX_EVENTS})`;
  if (!value.every((e) => typeof e === "string" && e.length > 0 && e.length <= 64)) {
    return "events must be non-empty strings";
  }
  return null;
}

function publicView(record) {
  return {
    system: record.system,
    name: record.name,
    webhookUrl: record.webhookUrl || null,
    events: record.events || [],
    scopes: record.scopes,
    disabled: !!record.disabled,
    createdAt: record.createdAt,
  };
}

function audit(env, userId, botId, system, action, detail) {
  return writeAudit(env, { actorType: "user", actorId: userId, botId, system, action, result: "ok", detail });
}

function internalError(label, err) {
  // 資料庫缺失或查詢失敗：fail-closed 503，不退回 KV
  if (err instanceof BridgeDbError) return bridgeUnavailable();
  // 只記訊息，不記 stack，也不回給呼叫端
  console.error(`[Systems] ${label}:`, err && err.message);
  return json({ success: false, error: "Internal error" }, 500);
}

// ── handlers：由 withPermission 注入 (userId, botId, role) ──

export async function handleCreateSystem(request, env, userId, botId) {
  try {
    const body = await readBody(request);
    if (!body) return bad("Invalid JSON body");

    const { system, name } = body;
    if (typeof system !== "string" || !SYSTEM_NAME_RE.test(system)) {
      return bad("system must match [a-z0-9][a-z0-9_-]{1,31}");
    }
    if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
      return bad("name is required (max 100 chars)");
    }

    let scopes = DEFAULT_SCOPES;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.length === 0) return bad("scopes must be a non-empty array");
      const normalized = body.scopes.map((s) => (typeof s === "string" && Object.hasOwn(LEGACY_SCOPE_ALIASES, s) ? LEGACY_SCOPE_ALIASES[s] : s));
      if (!normalized.every((s) => ALLOWED_SCOPES.includes(s))) {
        return bad(`scopes must be among: ${ALLOWED_SCOPES.join(", ")}`);
      }
      scopes = [...new Set(normalized)];
    }

    let events = [];
    if (body.events !== undefined) {
      const err = validateEvents(body.events);
      if (err) return bad(err);
      events = body.events;
    }

    let webhookUrl = null;
    if (body.webhookUrl !== undefined && body.webhookUrl !== null) {
      const err = validateWebhookUrl(body.webhookUrl);
      if (err) return bad(err);
      webhookUrl = body.webhookUrl;
    }

    const apiKey = generateBrokerKey();
    const created = await createSystemWithKey(env, {
      botId, system, name: name.trim(), scopes, events, webhookUrl, createdBy: userId, keyHash: await sha256Hex(apiKey),
    });
    if (created.conflict) return json({ success: false, error: "System already registered" }, 409);
    const record = created.record;
    await audit(env, userId, botId, system, "system_created", { scopes });

    return secretJson({ success: true, ...publicView(record), apiKey }, 201);
  } catch (err) {
    return internalError("create", err);
  }
}

export async function handleListSystems(request, env, userId, botId) {
  try {
    const systems = (await listSystems(env, botId)).map(publicView);
    return json({ success: true, systems });
  } catch (err) {
    return internalError("list", err);
  }
}

export async function handleUpdateSystem(request, env, userId, botId, role, system) {
  try {
    const record = await getSystem(env, botId, system);
    if (!record) return notFound();

    const body = await readBody(request);
    if (!body) return bad("Invalid JSON body");

    const changes = {};

    if (body.webhookUrl !== undefined) {
      if (body.webhookUrl === null) {
        changes.webhookUrl = null;
      } else {
        const err = validateWebhookUrl(body.webhookUrl);
        if (err) return bad(err);
        changes.webhookUrl = body.webhookUrl;
      }
    }
    if (body.events !== undefined) {
      const err = validateEvents(body.events);
      if (err) return bad(err);
      changes.events = body.events;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return bad("disabled must be a boolean");
      changes.disabled = body.disabled;
    }
    // scopes 刻意不可經由 PATCH 變更：換權限要重新註冊，才會產生新的 key。

    const fields = Object.keys(changes);
    if (fields.length === 0) return bad("No updatable fields (webhookUrl, events, disabled)");

    const next = await updateSystem(env, botId, system, changes);
    if (!next) return notFound(); // 讀取之後被別人刪掉
    await audit(env, userId, botId, system, "system_updated", { fields, disabled: changes.disabled });
    return json({ success: true, ...publicView(next) });
  } catch (err) {
    return internalError("update", err);
  }
}

export async function handleRotateKey(request, env, userId, botId, role, system) {
  try {
    const record = await getSystem(env, botId, system);
    if (!record) return notFound();

    // 一個 batch：撤銷舊 key、發新 key（scopes 沿用）、更新系統。全成功或全回滾，
    // 不會落入「兩把都有效」或「舊的已失效、新的沒存到」。
    const apiKey = generateBrokerKey();
    if (!(await rotateKey(env, { botId, system, keyHash: await sha256Hex(apiKey) }))) return notFound();
    await audit(env, userId, botId, system, "key_rotated");

    return secretJson({ success: true, system, scopes: record.scopes, apiKey }, 200);
  } catch (err) {
    return internalError("rotate", err);
  }
}

export async function handleDeleteSystem(request, env, userId, botId, role, system) {
  try {
    if (!(await deleteSystem(env, botId, system))) return notFound();
    await audit(env, userId, botId, system, "system_deleted");

    return json({ success: true });
  } catch (err) {
    return internalError("delete", err);
  }
}

// ── 路由 ──

export function route(request, env, userId, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["bridge","v1","systems",...]
  if (parts[0] !== "bridge" || parts[1] !== "v1" || parts[2] !== "systems") {
    return json({ success: false, error: "Not Found" }, 404);
  }
  const method = request.method;
  const owner = (h) => withPermission(h, "owner");

  if (parts.length === 3) {
    if (method === "POST") return owner(handleCreateSystem)(request, env, userId);
    if (method === "GET") return owner(handleListSystems)(request, env, userId);
    return json({ success: false, error: "Not Found" }, 404);
  }

  // 路徑段會被當成系統名稱使用，所以先解碼再驗證格式（擋 %3A 之類的偽裝）
  let system;
  try {
    system = decodeURIComponent(parts[3]);
  } catch {
    return bad("Invalid system name");
  }
  if (!SYSTEM_NAME_RE.test(system)) return bad("Invalid system name");

  if (parts.length === 4) {
    if (method === "PATCH") return owner(handleUpdateSystem)(request, env, userId, system);
    if (method === "DELETE") return owner(handleDeleteSystem)(request, env, userId, system);
  }
  if (parts.length === 6 && parts[4] === "keys" && parts[5] === "rotate" && method === "POST") {
    return owner(handleRotateKey)(request, env, userId, system);
  }
  return json({ success: false, error: "Not Found" }, 404);
}
