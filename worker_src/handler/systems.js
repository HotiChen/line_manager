/**
 * 系統註冊與 service key（橋接 API，人主體操作）
 *
 *   POST   /api/v1/systems                       註冊，回傳 apiKey（只回這一次）
 *   GET    /api/v1/systems                       列出
 *   PATCH  /api/v1/systems/{system}              改 webhookUrl / events / disabled
 *   POST   /api/v1/systems/{system}/keys/rotate  輪替 key（舊 key 立即失效）
 *   DELETE /api/v1/systems/{system}              刪除（key 立即失效）
 *
 * 全部要求 owner 權限，且只接受人主體（LIFF）。service key 打不進這裡 ——
 * 「key 不能用來發 key」，見 middleware/auth_routes.js 的 isBridgeServiceRoute。
 *
 * KV 結構：
 *   service_key:${sha256}        全域，{botId, system, scopes, createdAt, revokedAt}
 *   bot:${botId}:system:${name}  系統紀錄（含目前那把 key 的雜湊，絕不外流）
 *   bot:${botId}:systems         系統名稱清單
 */
import { jsonResponse } from "../lib/utils.js";
import { withPermission } from "../middleware/permission.js";
import { sha256Hex, randomToken } from "../lib/crypto_util.js";
import { BotKeys, ServiceKeyKeys } from "../lib/kv_schema.js";

const SYSTEM_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ALLOWED_SCOPES = ["messages:push", "members:read", "tags:write"];
const DEFAULT_SCOPES = ["messages:push"];
const MAX_EVENTS = 20;
const MAX_URL_LENGTH = 2048;
/** 撤銷後的 key 紀錄保留多久（稽核用）；到期後查不到，行為與「已撤銷」相同（401） */
const REVOKED_KEY_TTL_SEC = 90 * 24 * 60 * 60;

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

async function getSystem(env, botId, system) {
  return env.KV_LINE_STORAGE.get(BotKeys.system(botId, system), { type: "json" });
}

async function putJson(env, key, value, options) {
  await env.KV_LINE_STORAGE.put(key, JSON.stringify(value), options);
}

async function revokeKeyByHash(env, keyHash) {
  const k = ServiceKeyKeys.byHash(keyHash);
  const record = await env.KV_LINE_STORAGE.get(k, { type: "json" });
  if (!record) return;
  await putJson(env, k, { ...record, revokedAt: Date.now() }, { expirationTtl: REVOKED_KEY_TTL_SEC });
}

async function issueKey(env, botId, system, scopes) {
  const apiKey = randomToken("sk_");
  const keyHash = await sha256Hex(apiKey);
  await putJson(env, ServiceKeyKeys.byHash(keyHash), {
    botId,
    system,
    scopes,
    createdAt: Date.now(),
    revokedAt: null,
  });
  return { apiKey, keyHash };
}

async function readIndex(env, botId) {
  const list = await env.KV_LINE_STORAGE.get(BotKeys.systems(botId), { type: "json" });
  return Array.isArray(list) ? list : [];
}

function internalError(label, err) {
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
      if (!body.scopes.every((s) => ALLOWED_SCOPES.includes(s))) {
        return bad(`scopes must be among: ${ALLOWED_SCOPES.join(", ")}`);
      }
      scopes = [...new Set(body.scopes)];
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

    if (await getSystem(env, botId, system)) {
      return json({ success: false, error: "System already registered" }, 409);
    }

    // 順序：先寫 key，再寫系統紀錄。中途失敗只會留下一把「找不到系統」的 key，
    // authenticateBridge 會因系統不存在而拒絕，不會變成有效憑證。
    const { apiKey, keyHash } = await issueKey(env, botId, system, scopes);
    const record = {
      system,
      name: name.trim(),
      webhookUrl,
      events,
      scopes,
      disabled: false,
      createdAt: Date.now(),
      createdBy: userId,
      keyHash,
    };
    await putJson(env, BotKeys.system(botId, system), record);
    const index = await readIndex(env, botId);
    if (!index.includes(system)) {
      await putJson(env, BotKeys.systems(botId), [...index, system]);
    }

    return secretJson({ success: true, ...publicView(record), apiKey }, 201);
  } catch (err) {
    return internalError("create", err);
  }
}

export async function handleListSystems(request, env, userId, botId) {
  try {
    const index = await readIndex(env, botId);
    const systems = [];
    for (const name of index) {
      const record = await getSystem(env, botId, name);
      if (record) systems.push(publicView(record));
    }
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

    const next = { ...record };
    let touched = false;

    if (body.webhookUrl !== undefined) {
      if (body.webhookUrl === null) {
        next.webhookUrl = null;
      } else {
        const err = validateWebhookUrl(body.webhookUrl);
        if (err) return bad(err);
        next.webhookUrl = body.webhookUrl;
      }
      touched = true;
    }
    if (body.events !== undefined) {
      const err = validateEvents(body.events);
      if (err) return bad(err);
      next.events = body.events;
      touched = true;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return bad("disabled must be a boolean");
      next.disabled = body.disabled;
      touched = true;
    }
    // scopes 刻意不可經由 PATCH 變更：換權限要重新註冊，才會產生新的 key。

    if (!touched) return bad("No updatable fields (webhookUrl, events, disabled)");

    await putJson(env, BotKeys.system(botId, system), next);
    return json({ success: true, ...publicView(next) });
  } catch (err) {
    return internalError("update", err);
  }
}

export async function handleRotateKey(request, env, userId, botId, role, system) {
  try {
    const record = await getSystem(env, botId, system);
    if (!record) return notFound();

    // 先發新 key、更新系統紀錄，最後才撤銷舊的：中途失敗時呼叫端看到錯誤會重試，
    // 不會落入「舊的已失效、新的沒存到」把使用者鎖在外面。
    const { apiKey, keyHash } = await issueKey(env, botId, system, record.scopes);
    const oldHash = record.keyHash;
    await putJson(env, BotKeys.system(botId, system), { ...record, keyHash });
    if (oldHash) await revokeKeyByHash(env, oldHash);

    return secretJson({ success: true, system, scopes: record.scopes, apiKey }, 200);
  } catch (err) {
    return internalError("rotate", err);
  }
}

export async function handleDeleteSystem(request, env, userId, botId, role, system) {
  try {
    const record = await getSystem(env, botId, system);
    if (!record) return notFound();

    if (record.keyHash) await revokeKeyByHash(env, record.keyHash);
    await env.KV_LINE_STORAGE.delete(BotKeys.system(botId, system));
    const index = await readIndex(env, botId);
    await putJson(env, BotKeys.systems(botId), index.filter((n) => n !== system));

    return json({ success: true });
  } catch (err) {
    return internalError("delete", err);
  }
}

// ── 路由 ──

export function route(request, env, userId, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api","v1","systems",...]
  if (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "systems") {
    return json({ success: false, error: "Not Found" }, 404);
  }
  const method = request.method;
  const owner = (h) => withPermission(h, "owner");

  if (parts.length === 3) {
    if (method === "POST") return owner(handleCreateSystem)(request, env, userId);
    if (method === "GET") return owner(handleListSystems)(request, env, userId);
    return json({ success: false, error: "Not Found" }, 404);
  }

  // 路徑段會被當成 KV key 的一部分，所以先解碼再驗證格式（擋 %3A 之類的偽裝）
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
