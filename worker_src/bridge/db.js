/**
 * Bridge 資料層（Cloudflare D1，binding: BRIDGE_DB）
 *
 * 所有 SQL 都在這個檔案；bridge/ 其他檔案不得自己組 SQL（test_bridge_db_boundary 把關）。
 * `BRIDGE_DB` 也只在 bridge/ 之內被讀取。結構見 migrations/0001_bridge_init.sql，
 * 設計見 docs/integration/lm-1b-plan.md。
 *
 * 約定：
 *   - 值一律走 bound parameter，不做字串拼接。
 *   - 缺 binding 或任何查詢失敗 → BridgeDbError（fail-closed）。呼叫端把它變成
 *     503 bridge_not_configured（bridgeUnavailable()），絕不退回 KV。
 *   - 錯誤只記 err.message，不記 stack，也不回給呼叫端。
 *   - writeAudit 是盡力而為：失敗只記 log，永遠不丟錯。
 */
import { jsonResponse } from "../lib/utils.js";

/** 冪等紀錄的存活時間（毫秒）。處理中只活 2 分鐘：Worker 被回收時不會把鍵永遠鎖死。 */
export const IDEM_IN_PROGRESS_TTL_MS = 120_000;
export const IDEM_DONE_TTL_MS = 24 * 60 * 60 * 1000;

/** 資料庫缺失或查詢失敗。message 只供 log，不給呼叫端看。 */
export class BridgeDbError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeDbError";
  }
}

/** @returns {Response} 503 {"success":false,"error":"bridge_not_configured"} */
export function bridgeUnavailable() {
  return jsonResponse({ success: false, error: "bridge_not_configured" }, 503);
}

function getDb(env) {
  const db = env && env.BRIDGE_DB;
  if (!db || typeof db.prepare !== "function") {
    throw new BridgeDbError("BRIDGE_DB binding is missing");
  }
  return db;
}

/** 取得 db，執行 fn；任何失敗都包成 BridgeDbError。 */
async function withDb(env, fn) {
  const db = getDb(env);
  try {
    return await fn(db);
  } catch (err) {
    if (err instanceof BridgeDbError) throw err;
    console.error("[BridgeDb] query failed:", err && err.message);
    throw new BridgeDbError("query failed");
  }
}

function parseJson(text, fallback) {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToSystem(row) {
  return {
    system: row.system,
    name: row.name,
    webhookUrl: row.webhook_url ?? null,
    events: parseJson(row.events, []),
    scopes: parseJson(row.scopes, []),
    disabled: row.disabled === 1,
    rateLimit: parseJson(row.rate_limit, undefined) || undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SYSTEM_COLUMNS =
  "system, name, scopes, webhook_url, events, disabled, rate_limit, created_by, created_at, updated_at";

// ── 健康檢查 ──

/** SELECT 1。失敗丟 BridgeDbError。 */
export async function pingDb(env) {
  await withDb(env, (db) => db.prepare("SELECT 1 AS ok").first());
}

// ── 認證 ──

/**
 * 以金鑰雜湊查金鑰與其系統（單一查詢，LEFT JOIN）。
 * 「金鑰在但系統不存在」（system: null）與「金鑰不存在」（回 null）可區分。
 *
 * @returns {Promise<null | {
 *   key: {botId: string, system: string, scopes: string[], revokedAt: number|null},
 *   system: null | {disabled: boolean, rateLimit?: object}
 * }>}
 */
export async function getKeyWithSystem(env, keyHash) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT k.bot_id AS bot_id, k.system AS system, k.scopes AS scopes, k.revoked_at AS revoked_at,
                s.bot_id AS s_bot_id, s.disabled AS s_disabled, s.rate_limit AS s_rate_limit
           FROM service_keys k
           LEFT JOIN systems s ON s.bot_id = k.bot_id AND s.system = k.system
          WHERE k.key_hash = ?1`
      )
      .bind(keyHash)
      .first();
    if (!row) return null;
    const scopes = parseJson(row.scopes, []);
    return {
      key: {
        botId: row.bot_id,
        system: row.system,
        scopes: Array.isArray(scopes) ? scopes : [],
        revokedAt: row.revoked_at ?? null,
      },
      system:
        row.s_bot_id === null || row.s_bot_id === undefined
          ? null
          : {
              disabled: row.s_disabled === 1,
              rateLimit: parseJson(row.s_rate_limit, undefined) || undefined,
            },
    };
  });
}

// ── 系統 ──

/**
 * 註冊系統並發第一把 key（同一個 batch）。
 * (bot_id, system) 是主鍵：撞到 → {created:false, conflict:true}，整批回滾，不會留下孤兒 key。
 *
 * @returns {Promise<{created: true, record: object} | {created: false, conflict: true}>}
 */
export async function createSystemWithKey(env, input) {
  const { botId, system, name, scopes, events, webhookUrl, rateLimit, createdBy, keyHash } = input;
  const now = input.now ?? Date.now();
  return withDb(env, async (db) => {
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO systems (bot_id, system, name, scopes, webhook_url, events, disabled, rate_limit, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?9)`
          )
          .bind(
            botId, system, name, JSON.stringify(scopes), webhookUrl ?? null, JSON.stringify(events ?? []),
            rateLimit ? JSON.stringify(rateLimit) : null, createdBy, now
          ),
        db
          .prepare(
            "INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)"
          )
          .bind(keyHash, botId, system, JSON.stringify(scopes), now),
      ]);
    } catch (err) {
      // 只有「主鍵／唯一約束」才是 409；其他（NOT NULL、缺表…）照常往上丟，變成 503
      if (/UNIQUE constraint failed/i.test(String(err && err.message))) {
        return { created: false, conflict: true };
      }
      throw err;
    }
    return {
      created: true,
      record: {
        system, name, webhookUrl: webhookUrl ?? null, events: events ?? [], scopes,
        disabled: false, rateLimit: rateLimit || undefined, createdBy, createdAt: now, updatedAt: now,
      },
    };
  });
}

/** @returns {Promise<object[]>} */
export async function listSystems(env, botId) {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(`SELECT ${SYSTEM_COLUMNS} FROM systems WHERE bot_id = ?1 ORDER BY created_at, system`)
      .bind(botId)
      .all();
    return results.map(rowToSystem);
  });
}

/** @returns {Promise<object|null>} */
export async function getSystem(env, botId, system) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(`SELECT ${SYSTEM_COLUMNS} FROM systems WHERE bot_id = ?1 AND system = ?2`)
      .bind(botId, system)
      .first();
    return row ? rowToSystem(row) : null;
  });
}

/**
 * 只改 webhookUrl / events / disabled（有給才改）。scopes 刻意不可更新。
 *
 * @param {{webhookUrl?: string|null, events?: string[], disabled?: boolean}} changes
 * @returns {Promise<object|null>} 更新後的紀錄；系統不存在回 null
 */
export async function updateSystem(env, botId, system, changes, now = Date.now()) {
  const setWebhook = changes.webhookUrl !== undefined ? 1 : 0;
  const setEvents = changes.events !== undefined ? 1 : 0;
  const setDisabled = changes.disabled !== undefined ? 1 : 0;
  return withDb(env, async (db) => {
    const [, selected] = await db.batch([
      db
        .prepare(
          `UPDATE systems SET
             webhook_url = CASE WHEN ?3 = 1 THEN ?4 ELSE webhook_url END,
             events      = CASE WHEN ?5 = 1 THEN ?6 ELSE events END,
             disabled    = CASE WHEN ?7 = 1 THEN ?8 ELSE disabled END,
             updated_at  = ?9
           WHERE bot_id = ?1 AND system = ?2`
        )
        .bind(
          botId, system,
          setWebhook, changes.webhookUrl ?? null,
          setEvents, JSON.stringify(changes.events ?? []),
          setDisabled, changes.disabled ? 1 : 0,
          now
        ),
      db
        .prepare(`SELECT ${SYSTEM_COLUMNS} FROM systems WHERE bot_id = ?1 AND system = ?2`)
        .bind(botId, system),
    ]);
    const row = selected.results[0];
    return row ? rowToSystem(row) : null;
  });
}

/**
 * 輪替金鑰：一個 batch（交易）內撤銷舊的、發新的（scopes 沿用系統的）、更新系統。
 * 全成功或全回滾；並行輪替後仍恰好剩一把有效。
 *
 * @returns {Promise<boolean>} 系統存在且已輪替 → true；系統不存在 → false（不留孤兒 key）
 */
export async function rotateKey(env, { botId, system, keyHash, now = Date.now() }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE service_keys SET revoked_at = ?3
            WHERE bot_id = ?1 AND system = ?2 AND revoked_at IS NULL
              AND EXISTS (SELECT 1 FROM systems WHERE bot_id = ?1 AND system = ?2)`
        )
        .bind(botId, system, now),
      db
        .prepare(
          `INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at)
           SELECT ?3, bot_id, system, scopes, ?4, NULL FROM systems WHERE bot_id = ?1 AND system = ?2`
        )
        .bind(botId, system, keyHash, now),
      db
        .prepare("UPDATE systems SET updated_at = ?3 WHERE bot_id = ?1 AND system = ?2")
        .bind(botId, system, now),
    ]);
    return results[1].meta.changes === 1;
  });
}

/**
 * 刪除系統：一個 batch 內撤銷全部有效金鑰並刪系統。撤銷過的 key 紀錄保留（稽核用）。
 *
 * @returns {Promise<boolean>} 有刪到 → true；不存在 → false
 */
export async function deleteSystem(env, botId, system, now = Date.now()) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare("UPDATE service_keys SET revoked_at = ?3 WHERE bot_id = ?1 AND system = ?2 AND revoked_at IS NULL")
        .bind(botId, system, now),
      db.prepare("DELETE FROM systems WHERE bot_id = ?1 AND system = ?2").bind(botId, system),
    ]);
    return results[1].meta.changes > 0;
  });
}

// ── 冪等 ──

function idemRow(row) {
  return {
    status: row.status,
    fingerprint: row.fingerprint,
    response:
      row.status === "done"
        ? { status: row.response_status, body: parseJson(row.response_body, null) }
        : undefined,
  };
}

/**
 * 原子地搶佔冪等鍵：單一 INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now。
 * 並行的呼叫者只有一個會讓這句改到一列；過期的紀錄（處理中 2 分鐘、完成 24 小時）可被接手。
 * 沒搶到就讀既有紀錄，讓呼叫端決定回放、409 或 422。
 *
 * @returns {Promise<{won: true} | {won: false, existing: {status: string, fingerprint: string, response?: {status: number, body: any}}}>}
 */
export async function claimIdempotency(env, { botId, system, keyHash, fingerprint, now = Date.now() }) {
  return withDb(env, async (db) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await db
        .prepare(
          `INSERT INTO idempotency (bot_id, system, key_hash, fingerprint, status, response_status, response_body, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, 'in_progress', NULL, NULL, ?5, ?6)
           ON CONFLICT (bot_id, system, key_hash) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             status = 'in_progress',
             response_status = NULL,
             response_body = NULL,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at
           WHERE idempotency.expires_at < ?5`
        )
        .bind(botId, system, keyHash, fingerprint, now, now + IDEM_IN_PROGRESS_TTL_MS)
        .run();
      if (res.meta.changes > 0) return { won: true };

      const row = await db
        .prepare(
          "SELECT status, fingerprint, response_status, response_body FROM idempotency WHERE bot_id = ?1 AND system = ?2 AND key_hash = ?3"
        )
        .bind(botId, system, keyHash)
        .first();
      if (row) return { won: false, existing: idemRow(row) };
      // 讀的時候紀錄剛好被釋放：再搶一次
    }
    return { won: false, existing: { status: "in_progress", fingerprint } };
  });
}

/** 把自己搶到的紀錄標成完成並存回應（24 小時）。只更新 in_progress 且 fingerprint 相符的那列。 */
export async function completeIdempotency(env, { botId, system, keyHash, fingerprint, response, now = Date.now() }) {
  return withDb(env, async (db) => {
    await db
      .prepare(
        `UPDATE idempotency
            SET status = 'done', response_status = ?5, response_body = ?6, expires_at = ?7
          WHERE bot_id = ?1 AND system = ?2 AND key_hash = ?3 AND fingerprint = ?4 AND status = 'in_progress'`
      )
      .bind(botId, system, keyHash, fingerprint, response.status, JSON.stringify(response.body), now + IDEM_DONE_TTL_MS)
      .run();
  });
}

/** 放掉處理中的紀錄（暫時性失敗不可快取，讓呼叫端能重試）。不會刪掉已完成的紀錄。 */
export async function releaseIdempotency(env, { botId, system, keyHash }) {
  return withDb(env, async (db) => {
    await db
      .prepare("DELETE FROM idempotency WHERE bot_id = ?1 AND system = ?2 AND key_hash = ?3 AND status = 'in_progress'")
      .bind(botId, system, keyHash)
      .run();
  });
}

// ── 稽核 ──

const COUNT_FIELDS = ["recipients", "messages", "cost", "status"];
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const NAME_RE = /^[A-Za-z]{1,32}$/;
const SCOPE_RE = /^[a-z]{1,32}:[a-z]{1,32}$/;
const MAX_LIST = 10;

/**
 * detail 白名單：只收這幾個欄位，且型別嚴格；其餘一律丟掉。
 * 絕不收訊息內文、金鑰或其雜湊、LINE userId。
 */
function sanitizeDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const k of COUNT_FIELDS) {
    const v = detail[k];
    if (Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  if (typeof detail.error === "string" && CODE_RE.test(detail.error)) out.error = detail.error;
  if (typeof detail.disabled === "boolean") out.disabled = detail.disabled;
  for (const [k, re] of [["fields", NAME_RE], ["scopes", SCOPE_RE]]) {
    const v = detail[k];
    if (Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => typeof x === "string" && re.test(x))) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 寫一筆稽核紀錄。盡力而為：任何失敗只記 message，永遠不丟錯 ——
 * 稽核壞掉不可把成功的請求變成錯誤。
 *
 * @param {Object} env
 * @param {{actorType: string, actorId?: string, botId?: string, system?: string, action: string, result: string, detail?: object, at?: number}} entry
 * @returns {Promise<void>}
 */
export async function writeAudit(env, entry) {
  try {
    if (!entry || !entry.actorType || !entry.action || !entry.result) return;
    const db = getDb(env);
    const detail = sanitizeDetail(entry.detail);
    await db
      .prepare(
        "INSERT INTO audit_log (at, actor_type, actor_id, bot_id, system, action, result, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
      )
      .bind(
        entry.at ?? Date.now(), entry.actorType, entry.actorId ?? null, entry.botId ?? null,
        entry.system ?? null, entry.action, entry.result, detail ? JSON.stringify(detail) : null
      )
      .run();
  } catch (err) {
    console.error("[BridgeAudit] write failed:", err && err.message);
  }
}
