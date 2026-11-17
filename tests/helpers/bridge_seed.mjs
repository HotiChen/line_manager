/**
 * Bridge 測試用的 D1 種子資料（直接寫 SQL，不經過被測的 bridge/db.js）
 */
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';

export async function seedSystem(db, {
    botId, system = 'imgpicker', name = 'Image Picker', scopes = ['messages:push'],
    disabled = false, rateLimit = null, webhookUrl = null, events = [], createdBy = 'Uowner', at = 1,
} = {}) {
    await db.prepare(
        `INSERT INTO systems (bot_id, system, name, scopes, webhook_url, events, disabled, rate_limit, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`
    ).bind(botId, system, name, JSON.stringify(scopes), webhookUrl, JSON.stringify(events),
        disabled ? 1 : 0, rateLimit ? JSON.stringify(rateLimit) : null, createdBy, at).run();
}

export async function seedKey(db, {
    botId, system = 'imgpicker', key, scopes = ['messages:push'], revokedAt = null, at = 1,
} = {}) {
    await db.prepare(
        'INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(await sha256Hex(key), botId, system, JSON.stringify(scopes), at, revokedAt).run();
}

export async function all(db, sql, ...binds) {
    const { results } = await db.prepare(sql).bind(...binds).all();
    return results;
}

export async function count(db, table, where = '1=1', ...binds) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first();
    return r.n;
}

/**
 * 種一條連結（產品、連結、連結金鑰），不經過被測的 bridge/db.js。
 * 產品已存在就沿用（INSERT OR IGNORE），所以同一個產品可以種多條連結（不同 bot）。
 */
export async function seedLink(db, {
    linkId = 'lnk_aaaaaaaaaaaaaaaa', productId = 'prd_aaaaaaaaaaaa', botId, key,
    scopes = ['link:manage', 'contacts:bind', 'messages:send'], status = 'active',
    productDisabled = false, keyRevokedAt = null, at = 1,
} = {}) {
    await db.prepare(
        `INSERT OR IGNORE INTO products (product_id, name, secret_hash, redirect_uris, url_domains, scopes, disabled, created_at)
         VALUES (?1, 'Image Picker', 'h', '[]', '[]', ?2, ?3, ?4)`
    ).bind(productId, JSON.stringify(scopes), productDisabled ? 1 : 0, at).run();
    await db.prepare(
        `INSERT INTO links (link_id, product_id, bot_id, scopes, status, created_by, created_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'Uowner', ?6, ?7)`
    ).bind(linkId, productId, botId, JSON.stringify(scopes), status, at, status === 'revoked' ? at : null).run();
    if (key) {
        await db.prepare(
            'INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, revoked_at, link_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
        ).bind(await sha256Hex(key), botId, `link:${linkId}`, JSON.stringify(scopes), at, keyRevokedAt, linkId).run();
    }
}

/** 包住 D1：計算 prepare／batch 被呼叫幾次（驗證「零 D1 查詢」用） */
export function countingDb(db) {
    const counter = { prepare: 0, batch: 0, get total() { return this.prepare + this.batch; } };
    const wrapped = {
        prepare: (...a) => { counter.prepare++; return db.prepare(...a); },
        batch: (...a) => { counter.batch++; return db.batch(...a); },
    };
    return { db: wrapped, counter };
}
