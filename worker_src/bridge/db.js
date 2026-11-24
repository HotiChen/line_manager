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
 * 連結金鑰（service_keys.link_id 非空，LM-2A）在這裡一律當作「不存在」：它們不得通過 /raw/* 與 /systems*，
 * 只能走 getLinkKeyContext。
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
          WHERE k.key_hash = ?1 AND k.link_id IS NULL`
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

// ── 產品（LM-2A）──

function rowToProduct(row) {
  const asList = (text) => {
    const v = parseJson(text, []);
    return Array.isArray(v) ? v : [];
  };
  return {
    productId: row.product_id,
    name: row.name,
    secretHash: row.secret_hash,
    redirectUris: asList(row.redirect_uris),
    urlDomains: asList(row.url_domains),
    scopes: asList(row.scopes),
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    productKey: row.product_key ?? null,
    eventUrl: row.event_url ?? null,
    eventSecretEnc: row.event_secret_enc ?? null,
    identityReturnUris: asList(row.identity_return_uris),
  };
}

/**
 * 登記產品。product_id 撞主鍵 → {created:false, conflict:true}。
 *
 * @returns {Promise<{created: true} | {created: false, conflict: true}>}
 */
export async function createProduct(env, { productId, name, secretHash, redirectUris, urlDomains, scopes, productKey = null, eventUrl = null, eventSecretEnc = null, identityReturnUris = null, now = Date.now() }) {
  return withDb(env, async (db) => {
    try {
      await db
        .prepare(
          `INSERT INTO products (product_id, name, secret_hash, redirect_uris, url_domains, scopes, disabled, created_at, product_key, event_url, event_secret_enc, identity_return_uris)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(productId, name, secretHash, JSON.stringify(redirectUris), JSON.stringify(urlDomains ?? []), JSON.stringify(scopes), now, productKey, eventUrl, eventSecretEnc, identityReturnUris ? JSON.stringify(identityReturnUris) : null)
        .run();
    } catch (err) {
      const msg = String(err && err.message);
      if (/UNIQUE constraint failed: products\.product_key/i.test(msg)) return { created: false, keyTaken: true };
      if (/UNIQUE constraint failed/i.test(msg)) return { created: false, conflict: true };
      throw err;
    }
    return { created: true };
  });
}

/**
 * 營運更新產品（LM-4D；LM-4B 加 event_url 與 event_secret_enc、LM-4C 加 identity_return_uris、url_domains（只增不減由呼叫端確保），只覆蓋有給的欄位）：product_key 只能從 NULL 設一次（同值視為冪等），scopes 由呼叫端確保只增不減。
 * product_key 撞到別的產品 → {updated:false, keyTaken:true}；已有不同的 product_key → {updated:false, keyLocked:true}。
 *
 * @returns {Promise<{updated: true} | {updated: false, keyTaken?: true, keyLocked?: true, notFound?: true}>}
 */
export async function updateProduct(env, { productId, productKey, scopes, urlDomains, eventUrl, eventSecretEnc, identityReturnUris }) {
  return withDb(env, async (db) => {
    let res;
    try {
      res = await db
        .prepare(
          `UPDATE products SET product_key = COALESCE(product_key, ?2), scopes = COALESCE(?3, scopes),
                 event_url = COALESCE(?4, event_url), event_secret_enc = COALESCE(?5, event_secret_enc),
                 identity_return_uris = COALESCE(?6, identity_return_uris), url_domains = COALESCE(?7, url_domains)
            WHERE product_id = ?1 AND (?2 IS NULL OR product_key IS NULL OR product_key = ?2)`
        )
        .bind(productId, productKey ?? null, scopes ? JSON.stringify(scopes) : null, eventUrl ?? null, eventSecretEnc ?? null, identityReturnUris ? JSON.stringify(identityReturnUris) : null, urlDomains ? JSON.stringify(urlDomains) : null)
        .run();
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err && err.message))) return { updated: false, keyTaken: true };
      throw err;
    }
    if (res.meta.changes === 1) return { updated: true };
    const exists = await db.prepare("SELECT 1 AS x FROM products WHERE product_id = ?1").bind(productId).first();
    return exists ? { updated: false, keyLocked: true } : { updated: false, notFound: true };
  });
}

/** @returns {Promise<null | {productId: string, name: string, secretHash: string, redirectUris: string[], urlDomains: string[], scopes: string[], disabled: boolean, createdAt: number, productKey: string|null, eventUrl: string|null, eventSecretEnc: string|null}>} */
export async function getProduct(env, productId) {
  return withDb(env, async (db) => {
    const row = await db.prepare("SELECT product_id, name, secret_hash, redirect_uris, url_domains, scopes, disabled, created_at, product_key, event_url, event_secret_enc, identity_return_uris FROM products WHERE product_id = ?1").bind(productId).first();
    return row ? rowToProduct(row) : null;
  });
}

/** @returns {Promise<null | object>} 同 getProduct，以 product_key 查 */
export async function getProductByKey(env, productKey) {
  return withDb(env, async (db) => {
    const row = await db.prepare("SELECT product_id, name, secret_hash, redirect_uris, url_domains, scopes, disabled, created_at, product_key, event_url, event_secret_enc, identity_return_uris FROM products WHERE product_key = ?1").bind(productKey).first();
    return row ? rowToProduct(row) : null;
  });
}

// ── 授權碼（LM-2A）──

/** 過期超過這麼久的授權碼在下一次發碼時順手清掉（idx_auth_codes_expiry） */
const AUTH_CODE_PURGE_AFTER_MS = 60 * 60 * 1000;

/** 存一組授權碼（只存雜湊），並順手清掉早已過期的舊碼。 */
export async function createAuthCode(env, { codeHash, productId, botId, redirectUri, scopes, createdBy, expiresAt, now = Date.now() }) {
  return withDb(env, async (db) => {
    await db.batch([
      db.prepare("DELETE FROM auth_codes WHERE expires_at < ?1").bind(now - AUTH_CODE_PURGE_AFTER_MS),
      db
        .prepare(
          `INSERT INTO auth_codes (code_hash, product_id, bot_id, redirect_uri, scopes, created_by, expires_at, used_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`
        )
        .bind(codeHash, productId, botId, redirectUri, JSON.stringify(scopes), createdBy, expiresAt),
    ]);
  });
}

/**
 * 消耗授權碼：單一 UPDATE，條件是「未使用、未過期、產品與 redirect_uri 都與發碼時完全相同」。
 * meta.changes === 1 才算成功，所以並行的兩次交換只有一個會贏。
 * 條件不符（過期、已用、不存在、產品或 redirect_uri 不符）一律回 null，呼叫端不得區分原因；
 * 不符的請求也不會消耗掉合法持有人的碼。
 *
 * @returns {Promise<null | {botId: string, scopes: string[], createdBy: string}>}
 */
export async function consumeAuthCode(env, { codeHash, productId, redirectUri, now = Date.now() }) {
  return withDb(env, async (db) => {
    const [updated, selected] = await db.batch([
      db
        .prepare(
          `UPDATE auth_codes SET used_at = ?4
            WHERE code_hash = ?1 AND product_id = ?2 AND redirect_uri = ?3
              AND used_at IS NULL AND expires_at > ?4`
        )
        .bind(codeHash, productId, redirectUri, now),
      db.prepare("SELECT bot_id, scopes, created_by FROM auth_codes WHERE code_hash = ?1").bind(codeHash),
    ]);
    if (updated.meta.changes !== 1) return null;
    const row = selected.results[0];
    if (!row) return null;
    const scopes = parseJson(row.scopes, []);
    return { botId: row.bot_id, scopes: Array.isArray(scopes) ? scopes : [], createdBy: row.created_by };
  });
}

// ── 連結（LM-2A）──

function rowToLink(row) {
  const scopes = parseJson(row.scopes, []);
  return {
    linkId: row.link_id,
    productId: row.product_id,
    productName: row.product_name ?? null,
    botId: row.bot_id,
    scopes: Array.isArray(scopes) ? scopes : [],
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    productKey: row.product_key ?? null,
  };
}

/** 連結金鑰在 service_keys.system 欄位的值。含 ":"，所以不可能與系統名稱（[a-z0-9_-]）撞名。 */
const linkSystemName = (linkId) => `link:${linkId}`;

/**
 * 建立連結並發第一把金鑰（同一個 batch）：
 * 先撤銷同 (product, bot) 既有 active 連結與其金鑰，再建新連結、發新金鑰。
 * 被取代的連結名下的 contacts 與未用未過期的 bind_codes 在同一個 batch 內改掛到新連結（LM-3A）。
 * 任何一步失敗整批回滾，不留孤兒；唯一索引 uq_links_active 是最後一道防線。
 *
 * @returns {Promise<{revokedLinkIds: string[]}>} 被這次重新授權取代的舊連結
 */
export async function createLinkWithKey(env, { linkId, productId, botId, scopes, createdBy, keyHash, now = Date.now() }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("SELECT link_id FROM links WHERE product_id = ?1 AND bot_id = ?2 AND status = 'active'").bind(productId, botId),
      // LM-3A：重新授權（取代 active 連結）時，綁定與「未用且未過期」的綁定碼跟著搬到新連結。
      // LM-4D：搬家時分眾清掉（新連結的 scope 可能不同，由產品重新設定）。
      // 放在撤銷之前，這樣「這次被取代的連結」就是此刻 status = 'active' 的那些，不會碰到更早被明確撤銷的連結
      // （撤銷即切斷）。新連結剛建、沒有任何列，不會有主鍵衝突。
      db
        .prepare(
          `UPDATE contacts SET link_id = ?3, segment = NULL
            WHERE link_id IN (SELECT link_id FROM links WHERE product_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(productId, botId, linkId),
      db
        .prepare(
          `UPDATE bind_codes SET link_id = ?3
            WHERE used_at IS NULL AND expires_at > ?4
              AND link_id IN (SELECT link_id FROM links WHERE product_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(productId, botId, linkId, now),
      db
        .prepare(
          `UPDATE service_keys SET revoked_at = ?3
            WHERE revoked_at IS NULL
              AND link_id IN (SELECT link_id FROM links WHERE product_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(productId, botId, now),
      db
        .prepare("UPDATE links SET status = 'revoked', revoked_at = ?3 WHERE product_id = ?1 AND bot_id = ?2 AND status = 'active'")
        .bind(productId, botId, now),
      db
        .prepare(
          `INSERT INTO links (link_id, product_id, bot_id, scopes, status, created_by, created_at, revoked_at)
           VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, NULL)`
        )
        .bind(linkId, productId, botId, JSON.stringify(scopes), createdBy, now),
      db
        .prepare(
          `INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at, link_id)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`
        )
        .bind(keyHash, botId, linkSystemName(linkId), JSON.stringify(scopes), now, linkId),
    ]);
    return { revokedLinkIds: results[0].results.map((r) => r.link_id) };
  });
}

/** @returns {Promise<object|null>} */
export async function getLink(env, linkId) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(`SELECT l.link_id AS link_id, l.product_id AS product_id, l.bot_id AS bot_id, l.scopes AS scopes, l.status AS status, l.created_by AS created_by, l.created_at AS created_at, l.revoked_at AS revoked_at, p.name AS product_name FROM links l LEFT JOIN products p ON p.product_id = l.product_id WHERE l.link_id = ?1`)
      .bind(linkId)
      .first();
    return row ? rowToLink(row) : null;
  });
}

/** 後台列表：這個 bot 的連結（含已撤銷的），新的在前。 */
export async function listLinksForBot(env, botId, limit = 200) {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT l.link_id AS link_id, l.product_id AS product_id, l.bot_id AS bot_id, l.scopes AS scopes, l.status AS status, l.created_by AS created_by, l.created_at AS created_at, l.revoked_at AS revoked_at, p.name AS product_name, p.product_key AS product_key FROM links l LEFT JOIN products p ON p.product_id = l.product_id
          WHERE l.bot_id = ?1 ORDER BY l.created_at DESC, l.link_id LIMIT ?2`
      )
      .bind(botId, limit)
      .all();
    return results.map(rowToLink);
  });
}

/**
 * 撤銷連結與它的全部金鑰（同一個 batch）。只動「這個 bot 的 active 連結」。
 *
 * @returns {Promise<boolean>} 有撤銷 → true；不存在、不屬於這個 bot、或早已撤銷 → false
 */
export async function revokeLink(env, { linkId, botId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      // LM-4D：撤銷即清掉這條連結下的分眾（放在改 status 之前，EXISTS 才看得到 active）
      db
        .prepare(
          `UPDATE contacts SET segment = NULL
            WHERE link_id = ?1 AND segment IS NOT NULL
              AND EXISTS (SELECT 1 FROM links WHERE link_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(linkId, botId),
      db
        .prepare(
          `UPDATE service_keys SET revoked_at = ?3
            WHERE link_id = ?1 AND revoked_at IS NULL
              AND EXISTS (SELECT 1 FROM links WHERE link_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(linkId, botId, now),
      db
        .prepare("UPDATE links SET status = 'revoked', revoked_at = ?3 WHERE link_id = ?1 AND bot_id = ?2 AND status = 'active'")
        .bind(linkId, botId, now),
    ]);
    return results[2].meta.changes === 1;
  });
}

/**
 * 輪替連結金鑰：同一個 batch 內撤銷舊的、發新的（scopes 取自連結）。
 * 全成功或全回滾；並行輪替後恰好剩一把有效。連結不是 active → false，不留孤兒金鑰。
 *
 * @returns {Promise<boolean>}
 */
export async function rotateLinkKey(env, { linkId, botId, keyHash, now = Date.now() }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE service_keys SET revoked_at = ?3
            WHERE link_id = ?1 AND revoked_at IS NULL
              AND EXISTS (SELECT 1 FROM links WHERE link_id = ?1 AND bot_id = ?2 AND status = 'active')`
        )
        .bind(linkId, botId, now),
      db
        .prepare(
          `INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at, link_id)
           SELECT ?3, bot_id, 'link:' || link_id, scopes, ?4, NULL, link_id
             FROM links WHERE link_id = ?1 AND bot_id = ?2 AND status = 'active'`
        )
        .bind(linkId, botId, keyHash, now),
    ]);
    return results[1].meta.changes === 1;
  });
}

/**
 * 連結金鑰認證用：以金鑰雜湊一次查到「金鑰 → 連結 → 產品」（LEFT JOIN）。
 * 系統金鑰（link_id 為空）回 {key:{linkId:null}, link:null, product:null}；呼叫端必須拒絕。
 *
 * @returns {Promise<null | {
 *   key: {linkId: string|null, botId: string, scopes: string[], revokedAt: number|null},
 *   link: null | {linkId: string, productId: string, botId: string, scopes: string[], status: string},
 *   product: null | {disabled: boolean},
 * }>}
 */
export async function getLinkKeyContext(env, keyHash) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT k.link_id AS k_link_id, k.bot_id AS k_bot_id, k.scopes AS k_scopes, k.revoked_at AS k_revoked_at,
                l.link_id AS l_link_id, l.product_id AS l_product_id, l.bot_id AS l_bot_id, l.scopes AS l_scopes, l.status AS l_status,
                p.product_id AS p_product_id, p.disabled AS p_disabled
           FROM service_keys k
           LEFT JOIN links l ON l.link_id = k.link_id
           LEFT JOIN products p ON p.product_id = l.product_id
          WHERE k.key_hash = ?1`
      )
      .bind(keyHash)
      .first();
    if (!row) return null;
    const list = (text) => {
      const v = parseJson(text, []);
      return Array.isArray(v) ? v : [];
    };
    return {
      key: {
        linkId: row.k_link_id ?? null,
        botId: row.k_bot_id,
        scopes: list(row.k_scopes),
        revokedAt: row.k_revoked_at ?? null,
      },
      link:
        row.l_link_id === null || row.l_link_id === undefined
          ? null
          : { linkId: row.l_link_id, productId: row.l_product_id, botId: row.l_bot_id, scopes: list(row.l_scopes), status: row.l_status },
      product: row.p_product_id === null || row.p_product_id === undefined ? null : { disabled: row.p_disabled === 1 },
    };
  });
}

// ── 聯絡人綁定（LM-3A）──
//
// line_user_id 只存在 contacts 表。這一節只有兩處把它讀出來：consumeBindCode 的「原綁定者」子查詢（M-02，僅供 binding.js 通知換綁）與 getContactForSend（LM-3B，只給 notify.js 送出訊息用，
// 回傳值只在 handler 內存活，不進回應、audit、log；test_bridge_db_boundary 釘住「只有這一句 SELECT 讀它」）。
// 其餘 HTTP 處理函式拿到的只有狀態與時間。webhook 路徑（binding.js）自己手上就有 lineUserId，只會把它寫進來或當查詢條件。

/** 每條連結同時有效（未用、未過期）的綁定碼上限 */
export const MAX_LIVE_BIND_CODES_PER_LINK = 1000;
/** 過期超過這麼久的綁定碼在下一次發碼時順手清掉（idx_bind_codes_expiry） */
const BIND_CODE_PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * 發一組綁定碼（只存雜湊），單一 batch：
 *   1. INSERT … SELECT，條件是「這條連結其他 ref 的有效未用碼數量 < 上限」（上限不計同 ref 的舊碼，因為它們即將被取代）
 *   2. 只有新碼確實寫入時，才刪除同 (連結, ref) 的其他未用碼 —— 被上限擋下時舊碼原封不動
 *   3. 順手清掉早已過期的舊碼
 * 並行請求可能讓數量短暫略超過上限（與 KV 限流器同級的已知限制），上限是防灌表的護欄，不是精確配額。
 * allowRebind（M-02／D6）：此碼被「不同的 LINE 使用者」消耗時，是否允許覆蓋既有綁定（預設 false）。
 * 缺 0004 遷移（沒有 allow_rebind 欄位）→ 查詢失敗 → BridgeDbError（fail-closed）。
 *
 * @returns {Promise<{created: true} | {created: false, capped: true} | {created: false, conflict: true}>}
 */
export async function createBindCode(env, { codeHash, linkId, botId, ref, expiresAt, allowRebind = false, now = Date.now(), maxLive = MAX_LIVE_BIND_CODES_PER_LINK }) {
  return withDb(env, async (db) => {
    let results;
    try {
      results = await db.batch([
        db
          .prepare(
            `INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at, used_at, allow_rebind)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?8
              WHERE (SELECT COUNT(*) FROM bind_codes
                      WHERE link_id = ?2 AND used_at IS NULL AND expires_at > ?5 AND external_contact_ref <> ?4) < ?7`
          )
          .bind(codeHash, linkId, botId, ref, now, expiresAt, maxLive, allowRebind === true ? 1 : 0),
        db
          .prepare(
            `DELETE FROM bind_codes
              WHERE link_id = ?1 AND external_contact_ref = ?2 AND used_at IS NULL AND code_hash <> ?3
                AND EXISTS (SELECT 1 FROM bind_codes WHERE code_hash = ?3)`
          )
          .bind(linkId, ref, codeHash),
        db.prepare("DELETE FROM bind_codes WHERE expires_at < ?1").bind(now - BIND_CODE_PURGE_AFTER_MS),
      ]);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err && err.message))) return { created: false, conflict: true };
      throw err;
    }
    return results[0].meta.changes === 1 ? { created: true } : { created: false, capped: true };
  });
}

/**
 * 消耗綁定碼並寫入綁定（M-02／D6）。單一 batch（一個交易）：
 *   1. UPDATE used_at：條件是「未使用、未過期、屬於這個 bot、連結仍是 active」，**而且**
 *      （碼的 allow_rebind = 1，或這個 (連結, ref) 目前沒有被「別的 LINE 使用者」綁定）。
 *      條件寫在同一句 UPDATE 裡，所以「被拒絕」時碼不會被燒掉，並行也不會有檢查與消耗之間的空檔。
 *   2. SELECT 這組碼的資訊與（寫入前的）原綁定者 —— 用來分辨「查無此碼」與「碼有效但被擋下」，並在覆蓋時通知原綁定者。
 *   3. INSERT … ON CONFLICT DO UPDATE 寫入綁定，條件是 changes() = 1（也就是第 1 步真的搶到）。
 *      不用「used_at = now」判斷：兩個人在同一毫秒送同一組碼時，輸家也會看到 used_at = now。
 * 同一個 LINE 使用者重綁自己：條件成立（沒有「別人」）→ 視為成功（冪等）。
 * 既有綁定是 blocked 也算「被別人綁定」（要覆蓋就得 allow_rebind）。
 * 條件不符（不存在、過期、已用、別的 bot、連結已撤銷）一律回 null，呼叫端不得區分原因。
 *
 * previousUserId 是原綁定者的 LINE userId（只有「覆蓋了別人」時才有），僅供 binding.js 推播「綁定已被更換」，
 * 不得放進回應、audit、log。這個函式與 getContactForSend 是 db.js 僅有的兩處讀出 line_user_id（boundary 測試把關）。
 *
 * @returns {Promise<null
 *   | {rejected: true, linkId: string, productId: string}
 *   | {rejected: false, linkId: string, productId: string, ref: string, previousUserId: string|null}>}
 */
export async function consumeBindCode(env, { codeHash, botId, lineUserId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const [updated, selected] = await db.batch([
      db
        .prepare(
          `UPDATE bind_codes SET used_at = ?3
            WHERE code_hash = ?1 AND bot_id = ?2 AND used_at IS NULL AND expires_at > ?3
              AND EXISTS (SELECT 1 FROM links WHERE links.link_id = bind_codes.link_id AND links.status = 'active')
              AND (allow_rebind = 1 OR NOT EXISTS (
                    SELECT 1 FROM contacts c
                     WHERE c.link_id = bind_codes.link_id AND c.external_contact_ref = bind_codes.external_contact_ref
                       AND c.line_user_id <> ?4))`
        )
        .bind(codeHash, botId, now, lineUserId),
      db
        .prepare(
          `SELECT b.link_id AS link_id, b.external_contact_ref AS ref, b.bot_id AS bot_id, b.used_at AS used_at,
                  b.expires_at AS expires_at, l.status AS link_status, l.product_id AS product_id,
                  (SELECT c.line_user_id FROM contacts c
                    WHERE c.link_id = b.link_id AND c.external_contact_ref = b.external_contact_ref) AS prev_user,
                  (SELECT c2.segment FROM contacts c2
                    WHERE c2.link_id = b.link_id AND c2.external_contact_ref = b.external_contact_ref) AS prev_segment
             FROM bind_codes b JOIN links l ON l.link_id = b.link_id WHERE b.code_hash = ?1`
        )
        .bind(codeHash),
      db
        .prepare(
          `INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at)
           SELECT b.link_id, b.external_contact_ref, ?2, ?3, 'bound', ?4, ?4 FROM bind_codes b
            WHERE b.code_hash = ?1 AND changes() = 1
           ON CONFLICT (link_id, external_contact_ref) DO UPDATE SET
             bot_id = excluded.bot_id,
             line_user_id = excluded.line_user_id,
             status = 'bound',
             bound_at = excluded.bound_at,
             updated_at = excluded.updated_at`
        )
        .bind(codeHash, botId, lineUserId, now),
    ]);
    const row = selected.results[0];
    if (!row) return null;
    if (updated.meta.changes !== 1) {
      // UPDATE 的其他條件都成立卻沒改到列 → 只剩「別人已綁定、且此碼不許覆蓋」
      const stillValid = row.used_at === null && row.expires_at > now && row.bot_id === botId && row.link_status === "active";
      return stillValid ? { rejected: true, linkId: row.link_id, productId: row.product_id } : null;
    }
    const previousUserId = row.prev_user && row.prev_user !== lineUserId ? row.prev_user : null;
    return { rejected: false, linkId: row.link_id, productId: row.product_id, ref: row.ref, previousUserId, hasSegment: row.prev_segment !== null && row.prev_segment !== undefined };
  });
}

/**
 * 寫入（或覆蓋）綁定：同 (連結, ref) 已有列就換成新的 userId、狀態回到 bound、更新 bound_at。
 * 同一個 userId 綁多個 ref 是允許的（不同主鍵列）。
 */
export async function upsertContactBinding(env, { linkId, ref, botId, lineUserId, now = Date.now() }) {
  return withDb(env, async (db) => {
    await db
      .prepare(
        `INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'bound', ?5, ?5)
         ON CONFLICT (link_id, external_contact_ref) DO UPDATE SET
           bot_id = excluded.bot_id,
           line_user_id = excluded.line_user_id,
           status = 'bound',
           bound_at = excluded.bound_at,
           updated_at = excluded.updated_at`
      )
      .bind(linkId, ref, botId, lineUserId, now)
      .run();
  });
}

/**
 * 狀態推導需要的原料（單一查詢）：連結與產品狀態、這條連結下這個 ref 的綁定列、是否有有效未用碼。
 * 只回狀態與時間，不回 line_user_id。連結不存在回 null。
 *
 * @returns {Promise<null | {
 *   linkStatus: string, productDisabled: boolean,
 *   contact: null | {status: string, boundAt: number},
 *   hasPendingCode: boolean,
 * }>}
 */
export async function getContactSnapshot(env, { linkId, ref, now = Date.now() }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT l.status AS link_status, p.disabled AS product_disabled,
                c.status AS contact_status, c.bound_at AS bound_at, c.segment AS segment,
                EXISTS (SELECT 1 FROM bind_codes b
                         WHERE b.link_id = ?1 AND b.external_contact_ref = ?2 AND b.used_at IS NULL AND b.expires_at > ?3) AS pending
           FROM links l
           LEFT JOIN products p ON p.product_id = l.product_id
           LEFT JOIN contacts c ON c.link_id = l.link_id AND c.external_contact_ref = ?2
          WHERE l.link_id = ?1`
      )
      .bind(linkId, ref, now)
      .first();
    if (!row) return null;
    return {
      linkStatus: row.link_status,
      // 產品列不存在視同停用（與 authenticateLink 一致）
      productDisabled: row.product_disabled === null || row.product_disabled === undefined ? true : row.product_disabled === 1,
      contact: row.contact_status ? { status: row.contact_status, boundAt: row.bound_at, segment: row.segment ?? null } : null,
      hasPendingCode: row.pending === 1,
    };
  });
}

/**
 * LM-3B：送訊息前解析聯絡人。只在「這條連結 + 這個 bot」範圍內找（別條連結的 ref 看起來就是不存在）。
 * 這是全檔唯一讀出 line_user_id 的查詢；呼叫端只能把它交給 LINE，不可放進回應、audit 或 log。
 *
 * @returns {Promise<null | {status: string, lineUserId: string}>}
 */
export async function getContactForSend(env, { linkId, ref, botId }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare("SELECT status, line_user_id FROM contacts WHERE link_id = ?1 AND external_contact_ref = ?2 AND bot_id = ?3")
      .bind(linkId, ref, botId)
      .first();
    return row ? { status: row.status, lineUserId: row.line_user_id } : null;
  });
}

/**
 * 解除綁定：同一個 batch 刪除該 (連結, ref) 的綁定列與全部綁定碼。只動這條連結範圍內的列。
 *
 * @returns {Promise<{contactDeleted: boolean, codesDeleted: number}>}
 */
export async function deleteContact(env, { linkId, ref }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("DELETE FROM contacts WHERE link_id = ?1 AND external_contact_ref = ?2").bind(linkId, ref),
      db.prepare("DELETE FROM bind_codes WHERE link_id = ?1 AND external_contact_ref = ?2").bind(linkId, ref),
    ]);
    return { contactDeleted: results[0].meta.changes > 0, codesDeleted: results[1].meta.changes };
  });
}

/**
 * unfollow：把這個 bot 之下、這個 LINE 使用者的 bound 列標成 blocked。
 *
 * @returns {Promise<number>} 受影響的列數
 */
export async function markContactsBlockedByUser(env, { botId, lineUserId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const res = await db
      .prepare("UPDATE contacts SET status = 'blocked', segment = NULL, updated_at = ?3 WHERE bot_id = ?1 AND line_user_id = ?2 AND status = 'bound'")
      .bind(botId, lineUserId, now)
      .run();
    return res.meta.changes;
  });
}

/**
 * follow：只把「目前是 blocked」的列還原成 bound；不新建綁定。
 *
 * @returns {Promise<number>} 受影響的列數
 */
export async function restoreContactsByUser(env, { botId, lineUserId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const res = await db
      .prepare("UPDATE contacts SET status = 'bound', updated_at = ?3 WHERE bot_id = ?1 AND line_user_id = ?2 AND status = 'blocked'")
      .bind(botId, lineUserId, now)
      .run();
    return res.meta.changes;
  });
}

// ── 客人分眾（LM-4D，migration 0005）──

/**
 * 設定（或清除）這條連結下某個 ref 的分眾。只動 bound 的列；值沒變不寫。
 * 不回 line_user_id。
 *
 * @returns {Promise<{found: false} | {found: true, status: string, changed: boolean}>}
 */
export async function setContactSegment(env, { linkId, ref, segment, now = Date.now() }) {
  return withDb(env, async (db) => {
    const [selected, updated] = await db.batch([
      db.prepare("SELECT status FROM contacts WHERE link_id = ?1 AND external_contact_ref = ?2").bind(linkId, ref),
      db
        .prepare(
          `UPDATE contacts SET segment = ?3, updated_at = ?4
            WHERE link_id = ?1 AND external_contact_ref = ?2 AND status = 'bound' AND segment IS NOT ?3`
        )
        .bind(linkId, ref, segment, now),
    ]);
    const row = selected.results[0];
    if (!row) return { found: false };
    return { found: true, status: row.status, changed: updated.meta.changes === 1 };
  });
}

/**
 * 需要重新計算 Rich Menu 的對象：這條連結下（可限定一個 ref）的 (bot_id, line_user_id)。
 * onlySegmented = true 時只取目前有分眾的列（撤銷、取代前用）。
 * 回傳值只能交給 bridge/segments.js 轉給 lm_service；不得放進回應、audit 或 log。
 *
 * @returns {Promise<{botId: string, lineUserId: string}[]>}
 */
export async function listSegmentRecipients(env, { linkId, ref = null, onlySegmented = false, limit = 201 }) {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT bot_id, line_user_id FROM contacts
          WHERE link_id = ?1 AND (?2 IS NULL OR external_contact_ref = ?2) AND (?3 = 0 OR segment IS NOT NULL)
          LIMIT ?4`
      )
      .bind(linkId, ref, onlySegmented ? 1 : 0, limit)
      .all();
    return results.map((r) => ({ botId: r.bot_id, lineUserId: r.line_user_id }));
  });
}

/**
 * 這位 LINE 使用者在這個 bot 上目前有效的分眾：`<product_key>:<segment>`。
 * 只算 bound、連結 active、產品未停用且有 product_key 的列。line_user_id 只當 WHERE 條件。
 *
 * @returns {Promise<string[]>} 排序過、去重
 */
export async function listUserSegments(env, { botId, lineUserId }) {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT p.product_key AS product_key, c.segment AS segment
           FROM contacts c
           JOIN links l ON l.link_id = c.link_id
           JOIN products p ON p.product_id = l.product_id
          WHERE c.bot_id = ?1 AND c.line_user_id = ?2 AND c.status = 'bound' AND c.segment IS NOT NULL
            AND l.status = 'active' AND p.disabled = 0 AND p.product_key IS NOT NULL`
      )
      .bind(botId, lineUserId)
      .all();
    return [...new Set(results.map((r) => `${r.product_key}:${r.segment}`))].sort();
  });
}

// ── 事件轉發（LM-4B，migration 0006）──

/**
 * 這個 bot 上、product_key 對應的 active 連結與產品（轉發的對象）。找不到 → null。
 * 回傳含密文的簽章密鑰，只給 events.js 解開使用，不得放進回應、audit 或 log。
 *
 * @returns {Promise<null | {linkId: string, productId: string, linkScopes: string[], productDisabled: boolean, urlDomains: string[], eventUrl: string|null, eventSecretEnc: string|null}>}
 */
export async function getEventTarget(env, { botId, productKey }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT l.link_id AS link_id, l.scopes AS link_scopes, p.product_id AS product_id, p.disabled AS disabled,
                p.url_domains AS url_domains, p.event_url AS event_url, p.event_secret_enc AS event_secret_enc
           FROM links l JOIN products p ON p.product_id = l.product_id
          WHERE l.bot_id = ?1 AND l.status = 'active' AND p.product_key = ?2
          LIMIT 1`
      )
      .bind(botId, productKey)
      .first();
    if (!row) return null;
    const list = (t) => { const v = parseJson(t, []); return Array.isArray(v) ? v : []; };
    return {
      linkId: row.link_id,
      productId: row.product_id,
      linkScopes: list(row.link_scopes),
      productDisabled: row.disabled === 1,
      urlDomains: list(row.url_domains),
      eventUrl: row.event_url ?? null,
      eventSecretEnc: row.event_secret_enc ?? null,
    };
  });
}

/**
 * 這位 LINE 使用者在「這條連結」下已綁定的聯絡人（轉發時帶 contact 用）。
 * line_user_id 只當 WHERE 條件；回傳只有 ref 與狀態。
 *
 * @returns {Promise<null | {ref: string, status: string}>}
 */
export async function getBoundContactByUser(env, { linkId, botId, lineUserId }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT external_contact_ref AS ref, status FROM contacts
          WHERE link_id = ?1 AND bot_id = ?2 AND line_user_id = ?3 AND status = 'bound'
          ORDER BY bound_at DESC LIMIT 1`
      )
      .bind(linkId, botId, lineUserId)
      .first();
    return row ? { ref: row.ref, status: row.status } : null;
  });
}

/** @returns {Promise<null | object>} 備用內容（已解析的 Notification）；沒有或壞掉 → null */
export async function getEventFallback(env, { botId, productKey, action }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare("SELECT content FROM event_fallbacks WHERE bot_id = ?1 AND product_key = ?2 AND action = ?3")
      .bind(botId, productKey, action)
      .first();
    if (!row) return null;
    const v = parseJson(row.content, null);
    return v && typeof v === "object" ? v : null;
  });
}

/** @returns {Promise<{action: string, content: object}[]>} */
export async function listEventFallbacks(env, { botId, productKey }) {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare("SELECT action, content FROM event_fallbacks WHERE bot_id = ?1 AND product_key = ?2 ORDER BY action LIMIT 200")
      .bind(botId, productKey)
      .all();
    return results.map((r) => ({ action: r.action, content: parseJson(r.content, null) })).filter((r) => r.content);
  });
}

export async function putEventFallback(env, { botId, productKey, action, content, now = Date.now() }) {
  return withDb(env, async (db) => {
    await db
      .prepare(
        `INSERT INTO event_fallbacks (bot_id, product_key, action, content, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (bot_id, product_key, action) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .bind(botId, productKey, action, JSON.stringify(content), now)
      .run();
  });
}

/** @returns {Promise<boolean>} 有刪到 → true */
export async function deleteEventFallback(env, { botId, productKey, action }) {
  return withDb(env, async (db) => {
    const res = await db
      .prepare("DELETE FROM event_fallbacks WHERE bot_id = ?1 AND product_key = ?2 AND action = ?3")
      .bind(botId, productKey, action)
      .run();
    return res.meta.changes > 0;
  });
}

// ── LINE 身分（LM-4C，migration 0007）──
//
// identity_codes 刻意不存 LINE userId：只存雜湊與發碼當下解出的 ref／status。
// identity_channels.secret_enc 是密文，只給 identity.js 解開使用，不得放進回應、audit 或 log。

/** 身分碼有效時間：60 秒（草案 §C.2，比照授權碼） */
export const IDENTITY_CODE_TTL_MS = 60 * 1000;
const IDENTITY_CODE_PURGE_AFTER_MS = 60 * 60 * 1000;

/** @returns {Promise<null | {botId: string, channelId: string, secretEnc: string, liffId: string|null, liffUrl: string|null, verifiedAt: number|null, updatedAt: number}>} */
export async function getIdentityChannel(env, botId) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare("SELECT bot_id, channel_id, secret_enc, liff_id, liff_url, verified_at, updated_at FROM identity_channels WHERE bot_id = ?1")
      .bind(botId)
      .first();
    return row
      ? {
          botId: row.bot_id, channelId: row.channel_id, secretEnc: row.secret_enc, liffId: row.liff_id ?? null,
          liffUrl: row.liff_url ?? null, verifiedAt: row.verified_at ?? null, updatedAt: row.updated_at,
        }
      : null;
  });
}

/**
 * 寫入（或整組覆蓋）這個 OA 的 LINE Login channel。換 channel 或換 LIFF 時 verified_at 歸零，要重新驗證；
 * keepVerified = true（呼叫端確認 channel ID 與 LIFF 都沒變，只是換 secret）才保留。
 */
export async function putIdentityChannel(env, { botId, channelId, secretEnc, liffId = null, liffUrl = null, keepVerified = false, now = Date.now() }) {
  return withDb(env, async (db) => {
    await db
      .prepare(
        `INSERT INTO identity_channels (bot_id, channel_id, secret_enc, liff_id, liff_url, verified_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
         ON CONFLICT (bot_id) DO UPDATE SET channel_id = excluded.channel_id, secret_enc = excluded.secret_enc,
           liff_id = excluded.liff_id, liff_url = excluded.liff_url,
           verified_at = CASE WHEN ?7 = 1 THEN identity_channels.verified_at ELSE NULL END, updated_at = excluded.updated_at`
      )
      .bind(botId, channelId, secretEnc, liffId, liffUrl, now, keepVerified ? 1 : 0)
      .run();
  });
}

/** @returns {Promise<boolean>} 有這個 OA 的設定（且已建立 LIFF）並已記錄 → true */
export async function setIdentityVerified(env, { botId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const res = await db.prepare("UPDATE identity_channels SET verified_at = ?2 WHERE bot_id = ?1 AND liff_id IS NOT NULL").bind(botId, now).run();
    return res.meta.changes === 1;
  });
}

/** @returns {Promise<boolean>} */
export async function deleteIdentityChannel(env, botId) {
  return withDb(env, async (db) => {
    const res = await db.prepare("DELETE FROM identity_channels WHERE bot_id = ?1").bind(botId).run();
    return res.meta.changes > 0;
  });
}

/**
 * 這個 bot 上、product_key 對應的 active 連結與產品（身分碼的對象）。找不到 → null。
 *
 * @returns {Promise<null | {linkId: string, productId: string, linkScopes: string[], productDisabled: boolean, identityReturnUris: string[]}>}
 */
export async function getIdentityTarget(env, { botId, productKey }) {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT l.link_id AS link_id, l.scopes AS link_scopes, p.product_id AS product_id, p.disabled AS disabled,
                p.identity_return_uris AS uris
           FROM links l JOIN products p ON p.product_id = l.product_id
          WHERE l.bot_id = ?1 AND l.status = 'active' AND p.product_key = ?2
          LIMIT 1`
      )
      .bind(botId, productKey)
      .first();
    if (!row) return null;
    const list = (t) => { const v = parseJson(t, []); return Array.isArray(v) ? v : []; };
    return {
      linkId: row.link_id,
      productId: row.product_id,
      linkScopes: list(row.link_scopes),
      productDisabled: row.disabled === 1,
      identityReturnUris: list(row.uris),
    };
  });
}

/**
 * 存一組身分碼（只存雜湊），並順手清掉早已過期的舊碼。雜湊撞到既有列 → {created:false}。
 *
 * @returns {Promise<{created: boolean}>}
 */
export async function createIdentityCode(env, { codeHash, linkId, botId, ref = null, status = null, now = Date.now() }) {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("DELETE FROM identity_codes WHERE expires_at < ?1").bind(now - IDENTITY_CODE_PURGE_AFTER_MS),
      db
        .prepare(
          `INSERT INTO identity_codes (code_hash, link_id, bot_id, ref, status, created_at, expires_at, used_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL) ON CONFLICT (code_hash) DO NOTHING`
        )
        .bind(codeHash, linkId, botId, ref, status, now, now + IDENTITY_CODE_TTL_MS),
    ]);
    return { created: results[1].meta.changes === 1 };
  });
}

/**
 * 兌換身分碼：單次（UPDATE … WHERE used_at IS NULL，changes = 1 才算搶到）、未過期、而且必須是「發碼那條連結」。
 * 條件不符（不存在、用過、過期、別條連結、連結已撤銷、產品停用）一律回 null，呼叫端不得區分原因。
 *
 * @returns {Promise<null | {ref: string|null, status: string|null, botId: string, productId: string}>}
 */
export async function consumeIdentityCode(env, { codeHash, linkId, now = Date.now() }) {
  return withDb(env, async (db) => {
    const updated = await db
      .prepare(
        `UPDATE identity_codes SET used_at = ?3
          WHERE code_hash = ?1 AND link_id = ?2 AND used_at IS NULL AND expires_at > ?3
            AND EXISTS (SELECT 1 FROM links l JOIN products p ON p.product_id = l.product_id
                         WHERE l.link_id = identity_codes.link_id AND l.status = 'active' AND p.disabled = 0)`
      )
      .bind(codeHash, linkId, now)
      .run();
    if (updated.meta.changes !== 1) return null;
    const row = await db
      .prepare(
        `SELECT c.ref AS ref, c.status AS status, c.bot_id AS bot_id, l.product_id AS product_id
           FROM identity_codes c JOIN links l ON l.link_id = c.link_id WHERE c.code_hash = ?1`
      )
      .bind(codeHash)
      .first();
    return row ? { ref: row.ref ?? null, status: row.status ?? null, botId: row.bot_id, productId: row.product_id } : null;
  });
}

// ── 原子計數與旗標（M-01／M-02，migration 0004）──
//
// 缺 counters／flags 表（只套用到 0003）→ 查詢失敗 → BridgeDbError，呼叫端 fail-closed（不放行）。
// scope_key 裡的 ref／LINE userId 由呼叫端先雜湊；這裡不看也不存明文。

/** 計數列保留多久（視窗起點早於這個時間的列在機率性清理時刪除） */
export const COUNTER_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const FLAG_RETENTION_MS = 24 * 60 * 60 * 1000;
const PURGE_PROBABILITY = 0.02;

/**
 * 原子地從固定視窗的桶子拿一個名額：單句 UPSERT，`… DO UPDATE SET n = n + 1 WHERE n < cap`，
 * 有回傳列才算放行（並行的呼叫者不會超過 cap）。cap < 1 一律不放行。
 *
 * @param {Object} env
 * @param {{key: string, windowMs: number, cap: number, now?: number, purge?: boolean}} p
 *   purge：true／false 強制（測試用）；省略則約 2% 機率順手清理舊視窗（盡力而為，失敗只記 log）
 * @returns {Promise<{allowed: boolean, count: number, window: number, resetAt: number}>}
 *   count = 放行時是取用後的數字；不放行時是 cap
 */
export async function takeToken(env, { key, windowMs, cap, now = Date.now(), purge }) {
  if (typeof key !== "string" || key === "" || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(cap)) {
    throw new BridgeDbError("invalid counter arguments");
  }
  const window = Math.floor(now / windowMs) * windowMs;
  const resetAt = window + windowMs;
  return withDb(env, async (db) => {
    let row = null;
    if (cap >= 1) {
      row = await db
        .prepare(
          `INSERT INTO counters (scope_key, window, n) VALUES (?1, ?2, 1)
           ON CONFLICT (scope_key, window) DO UPDATE SET n = n + 1 WHERE n < ?3
           RETURNING n`
        )
        .bind(key, window, cap)
        .first();
    }
    if (purge === true || (purge === undefined && Math.random() < PURGE_PROBABILITY)) {
      try {
        await db.batch([
          db.prepare("DELETE FROM counters WHERE window < ?1").bind(now - COUNTER_RETENTION_MS),
          db.prepare("DELETE FROM flags WHERE until_at < ?1").bind(now - FLAG_RETENTION_MS),
        ]);
      } catch (err) {
        console.error("[BridgeDb] counter purge failed:", err && err.message);
      }
    }
    return row ? { allowed: true, count: row.n, window, resetAt } : { allowed: false, count: cap, window, resetAt };
  });
}

/**
 * 把先前 takeToken 拿到的名額還回去（被後面的限制擋下、或只是重送的請求，不該吃掉預算）。
 * 只會把 n 減 1 且不低於 0；盡力而為由呼叫端包 try/catch。
 *
 * @param {Object} env
 * @param {{key: string, window: number}[]} tokens
 */
export async function giveBackTokens(env, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  return withDb(env, async (db) => {
    await db.batch(
      tokens.map(({ key, window }) =>
        db.prepare("UPDATE counters SET n = n - 1 WHERE scope_key = ?1 AND window = ?2 AND n > 0").bind(key, window)
      )
    );
  });
}

/** 旗標是否仍有效（until_at > now） */
export async function getFlag(env, { key, now = Date.now() }) {
  return withDb(env, async (db) => {
    const row = await db.prepare("SELECT 1 AS on_ FROM flags WHERE flag_key = ?1 AND until_at > ?2").bind(key, now).first();
    return Boolean(row);
  });
}

/** 設定（或延長）旗標：until_at 只會往後 */
export async function setFlag(env, { key, untilAt }) {
  return withDb(env, async (db) => {
    await db
      .prepare(
        `INSERT INTO flags (flag_key, until_at) VALUES (?1, ?2)
         ON CONFLICT (flag_key) DO UPDATE SET until_at = max(flags.until_at, excluded.until_at)`
      )
      .bind(key, untilAt)
      .run();
  });
}

/**
 * 「只做一次」的旗標：沒有或已過期才設定並回 true；已有效回 false。原子（單句 UPSERT）。
 * 用在每連結每日一次、每 bot 每小時一次的稽核。
 */
export async function claimFlag(env, { key, untilAt, now = Date.now() }) {
  return withDb(env, async (db) => {
    const res = await db
      .prepare(
        `INSERT INTO flags (flag_key, until_at) VALUES (?1, ?2)
         ON CONFLICT (flag_key) DO UPDATE SET until_at = excluded.until_at WHERE flags.until_at <= ?3`
      )
      .bind(key, untilAt, now)
      .run();
    return res.meta.changes > 0;
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

const COUNT_FIELDS = ["recipients", "messages", "cost", "status", "count", "latency_ms"];
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const NAME_RE = /^[A-Za-z]{1,32}$/;
const SCOPE_RE = /^[a-z]{1,32}:[a-z]{1,32}$/;
const MAX_LIST = 10;
// LM-2A：產品與連結代號（程式產生：prd_／lnk_ + 小寫英數）；error_code 是 bridge-v1 的錯誤碼（大寫底線）
const PRODUCT_ID_RE = /^prd_[a-z0-9]{6,32}$/;
const LINK_ID_RE = /^lnk_[a-z0-9]{6,32}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z_]{1,31}$/;
// LM-3B：LM 產生的訊息關聯代號（msg_ + 16 個小寫 hex）。稽核只收這個格式的字串
const MESSAGE_ID_RE = /^msg_[0-9a-f]{16}$/;

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
  if (typeof detail.cleared === "boolean") out.cleared = detail.cleared;
  if (typeof detail.has_contact === "boolean") out.has_contact = detail.has_contact;
  if (typeof detail.outcome === "string" && CODE_RE.test(detail.outcome)) out.outcome = detail.outcome;
  if (typeof detail.event_id === "string" && /^evt_[0-9a-f]{32}$/.test(detail.event_id)) out.event_id = detail.event_id;
  if (typeof detail.event_action === "string" && /^[a-z][a-z0-9_.-]{0,31}$/.test(detail.event_action)) out.event_action = detail.event_action;
  for (const [k, re] of [["product_id", PRODUCT_ID_RE], ["link_id", LINK_ID_RE], ["error_code", ERROR_CODE_RE], ["message_id", MESSAGE_ID_RE]]) {
    const v = detail[k];
    if (typeof v === "string" && re.test(v)) out[k] = v;
  }
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
