/**
 * Unit Tests — migrations/ 與 D1 測試工具（LM-1B）
 *
 * 結構只有一份來源（migrations/*.sql）。這裡確認：
 *   - 測試工具真的套用了全部遷移檔，計畫書第 3 節的表與索引都在
 *   - 套用兩次會失敗（wrangler 靠 d1_migrations 表只套一次；不是 IF NOT EXISTS）
 *   - 約束：PK、CHECK、NOT NULL
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1, readMigrations, splitStatements } from '../helpers/mock_d1.mjs';

const ALL_TABLES = ['audit_log', 'auth_codes', 'bind_codes', 'contacts', 'idempotency', 'links', 'products', 'service_keys', 'systems'];

let d1;
before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => { await d1.reset(); });

async function names(type) {
    const { results } = await d1.db.prepare('SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name').bind(type).all();
    return results.map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_'));
}

describe('遷移檔', () => {
    it('至少有 0001、0002、0003 遷移檔，且檔名排序穩定', () => {
        const files = readMigrations().map((m) => m.name);
        assert.ok(files.includes('0001_bridge_init.sql'));
        assert.ok(files.includes('0002_bridge_links.sql'));
        assert.ok(files.includes('0003_bridge_contacts.sql'));
        assert.deepEqual(files, [...files].sort());
    });

    it('建立計畫書的九張表（0001 的四張＋0002 的 products、links、auth_codes＋0003 的 bind_codes、contacts）', async () => {
        assert.deepEqual(await names('table'), ALL_TABLES);
    });

    it('建立計畫書的索引', async () => {
        const idx = await names('index');
        for (const i of [
            'idx_audit_log_bot_at', 'idx_idempotency_expiry', 'idx_service_keys_system',
            'uq_links_active', 'idx_links_bot', 'idx_auth_codes_expiry', 'idx_service_keys_link',
            'idx_bind_codes_ref', 'idx_bind_codes_expiry', 'idx_contacts_user',
        ]) {
            assert.ok(idx.includes(i), `缺索引 ${i}`);
        }
    });

    it('沒有外鍵（刪系統時 batch 撤銷金鑰，撤銷紀錄保留）', async () => {
        for (const t of ['systems', 'service_keys', 'idempotency', 'audit_log', 'products', 'links', 'auth_codes', 'bind_codes', 'contacts']) {
            const { results } = await d1.db.prepare(`PRAGMA foreign_key_list(${t})`).all();
            assert.equal(results.length, 0, t);
        }
    });

    it('全部套用第二次會失敗（表已存在），第一次的結果不受影響', async () => {
        await assert.rejects(() => d1.applyMigrations(), /already exists/i);
        assert.deepEqual(await names('table'), ALL_TABLES);
    });

    it('在全新的資料庫上套用全部遷移檔：成功一次，表齊全', async () => {
        const fresh = await createTestD1();
        try {
            const { results } = await fresh.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
            assert.deepEqual(results.map((r) => r.name), ALL_TABLES);
        } finally {
            await fresh.dispose();
        }
    });

    it('splitStatements 不會把註解當成敘述', () => {
        const stmts = splitStatements('-- hi\nCREATE TABLE a (x INT); -- tail\nCREATE INDEX i ON a (x);');
        assert.deepEqual(stmts, ['CREATE TABLE a (x INT)', 'CREATE INDEX i ON a (x)']);
    });
});

describe('0002 遷移（LM-2A）', () => {
    const file = () => readMigrations().find((m) => m.name === '0002_bridge_links.sql');

    it('service_keys 多了可為 NULL 的 link_id 欄位（既有系統金鑰此欄為 NULL）', async () => {
        const { results } = await d1.db.prepare('PRAGMA table_info(service_keys)').all();
        const col = results.find((c) => c.name === 'link_id');
        assert.ok(col, '缺 link_id');
        assert.equal(col.notnull, 0);
        await d1.db.prepare("INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at) VALUES ('h','b','s','[]',1)").run();
        assert.equal((await d1.db.prepare("SELECT link_id FROM service_keys WHERE key_hash='h'").first()).link_id, null);
    });

    it('重複套用 0002 的每一句都失敗（ALTER TABLE 不可重複），既有資料完全不受影響', async () => {
        await d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at) VALUES ('prd_a','P','h','[]','[]',1)").run();
        await d1.db.prepare("INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, link_id) VALUES ('k','b','link:lnk_a','[]',1,'lnk_a')").run();
        const stmts = splitStatements(file().sql);
        assert.ok(stmts.some((s) => /^ALTER TABLE service_keys ADD COLUMN link_id/i.test(s)));
        for (const stmt of stmts) {
            await assert.rejects(() => d1.db.prepare(stmt).run(), /already exists|duplicate column/i, stmt.slice(0, 40));
        }
        assert.equal((await d1.db.prepare('SELECT COUNT(*) AS n FROM products').first()).n, 1);
        assert.equal((await d1.db.prepare("SELECT link_id FROM service_keys WHERE key_hash='k'").first()).link_id, 'lnk_a');
        assert.deepEqual(await names('table'), ALL_TABLES);
    });

    it('檔案內沒有 IF NOT EXISTS（重複套用必須明確失敗，而不是默默略過）', () => {
        assert.doesNotMatch(file().sql, /IF NOT EXISTS/i);
    });
});

describe('0002 約束', () => {
    const link = (id, status = 'active', product = 'prd_a', bot = 'bot1') => d1.db.prepare(
        "INSERT INTO links (link_id, product_id, bot_id, scopes, status, created_by, created_at) VALUES (?1, ?2, ?3, '[]', ?4, 'u', 1)"
    ).bind(id, product, bot, status).run();

    it('products.product_id 是主鍵：重複失敗', async () => {
        const q = () => d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at) VALUES ('prd_a','P','h','[]','[]',1)").run();
        await q();
        await assert.rejects(q, /UNIQUE constraint failed/i);
    });

    it('products.url_domains 預設 [] ，disabled 預設 0', async () => {
        await d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at) VALUES ('prd_a','P','h','[]','[]',1)").run();
        const row = await d1.db.prepare('SELECT url_domains, disabled FROM products').first();
        assert.equal(row.url_domains, '[]');
        assert.equal(row.disabled, 0);
    });

    it('links.status 只收 active / revoked', async () => {
        await assert.rejects(() => link('l1', 'weird'), /CHECK constraint failed/i);
    });

    it('同 (product, bot) 只能有一條 active；revoked 可以有多條；不同 bot 或產品不互相影響', async () => {
        await link('l1');
        await assert.rejects(() => link('l2'), /UNIQUE constraint failed/i);
        await link('l3', 'revoked');
        await link('l4', 'revoked');
        await link('l5', 'active', 'prd_a', 'bot2');
        await link('l6', 'active', 'prd_b', 'bot1');
    });

    it('auth_codes.code_hash 是主鍵；used_at 預設 NULL', async () => {
        const q = () => d1.db.prepare("INSERT INTO auth_codes (code_hash, product_id, bot_id, redirect_uri, scopes, created_by, expires_at) VALUES ('c','p','b','https://x.example.com/cb','[]','u',10)").run();
        await q();
        await assert.rejects(q, /UNIQUE constraint failed/i);
        assert.equal((await d1.db.prepare('SELECT used_at FROM auth_codes').first()).used_at, null);
    });

    it('products 必填欄位不可為 NULL', async () => {
        await assert.rejects(() => d1.db.prepare("INSERT INTO products (product_id) VALUES ('p')").run(), /NOT NULL/i);
    });
});

describe('0003 遷移（LM-3A）', () => {
    const file = () => readMigrations().find((m) => m.name === '0003_bridge_contacts.sql');

    it('檔案內沒有 IF NOT EXISTS，重複套用 0003 的每一句都失敗且不影響既有資料', async () => {
        assert.doesNotMatch(file().sql, /IF NOT EXISTS/i);
        await d1.db.prepare("INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES ('l','r','b','u','bound',1,1)").run();
        for (const stmt of splitStatements(file().sql)) {
            await assert.rejects(() => d1.db.prepare(stmt).run(), /already exists/i, stmt.slice(0, 40));
        }
        assert.equal((await d1.db.prepare('SELECT COUNT(*) AS n FROM contacts').first()).n, 1);
    });

    it('contacts：(link_id, external_contact_ref) 是複合主鍵；status 只收 bound / blocked；必填欄位 NOT NULL', async () => {
        const ins = (link, ref, status = 'bound') => d1.db.prepare(
            "INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1,?2,'b','u',?3,1,1)"
        ).bind(link, ref, status).run();
        await ins('l1', 'r1');
        await assert.rejects(() => ins('l1', 'r1'), /UNIQUE constraint failed/i);
        await ins('l2', 'r1'); // 不同連結同 ref：互不影響
        await assert.rejects(() => ins('l3', 'r1', 'weird'), /CHECK constraint failed/i);
        await assert.rejects(() => d1.db.prepare("INSERT INTO contacts (link_id) VALUES ('x')").run(), /NOT NULL/i);
    });

    it('bind_codes：code_hash 是主鍵；used_at 預設 NULL；必填欄位 NOT NULL', async () => {
        const q = () => d1.db.prepare("INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES ('h','l','b','r',1,2)").run();
        await q();
        await assert.rejects(q, /UNIQUE constraint failed/i);
        assert.equal((await d1.db.prepare('SELECT used_at FROM bind_codes').first()).used_at, null);
        await assert.rejects(() => d1.db.prepare("INSERT INTO bind_codes (code_hash) VALUES ('x')").run(), /NOT NULL/i);
    });
});

describe('約束', () => {
    const ins = (sys = 's') => d1.db.prepare(
        "INSERT INTO systems (bot_id, system, name, scopes, created_by, created_at, updated_at) VALUES ('b', ?1, 'n', '[]', 'u', 1, 1)"
    ).bind(sys).run();

    it('systems 的 (bot_id, system) 是主鍵：重複失敗', async () => {
        await ins();
        await assert.rejects(() => ins(), /UNIQUE constraint failed/i);
    });

    it('service_keys.key_hash 唯一', async () => {
        const q = () => d1.db.prepare("INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at) VALUES ('h','b','s','[]',1)").run();
        await q();
        await assert.rejects(q, /UNIQUE constraint failed/i);
    });

    it('idempotency.status 只收 in_progress / done', async () => {
        await assert.rejects(() => d1.db.prepare(
            "INSERT INTO idempotency (bot_id, system, key_hash, fingerprint, status, created_at, expires_at) VALUES ('b','s','k','f','weird',1,2)"
        ).run(), /CHECK constraint failed/i);
    });

    it('systems 必填欄位不可為 NULL', async () => {
        await assert.rejects(() => d1.db.prepare("INSERT INTO systems (bot_id) VALUES ('b')").run(), /NOT NULL/i);
    });
});

describe('harness reset()', () => {
    it('清空所有表並重設 audit_log 的 AUTOINCREMENT', async () => {
        const w = () => d1.db.prepare("INSERT INTO audit_log (at, actor_type, action, result) VALUES (1,'user','a','ok')").run();
        await w(); await w();
        await d1.reset();
        await w();
        const row = await d1.db.prepare('SELECT id FROM audit_log').first();
        assert.equal(row.id, 1);
    });
});
