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

const ALL_TABLES = ['audit_log', 'auth_codes', 'bind_codes', 'contacts', 'counters', 'event_fallbacks', 'flags', 'idempotency', 'identity_channels', 'identity_codes', 'links', 'products', 'service_keys', 'systems'];

let d1;
before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => { await d1.reset(); });

async function names(type) {
    const { results } = await d1.db.prepare('SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name').bind(type).all();
    return results.map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_'));
}

describe('遷移檔', () => {
    it('至少有 0001、0002、0003、0004 遷移檔，且檔名排序穩定', () => {
        const files = readMigrations().map((m) => m.name);
        assert.ok(files.includes('0001_bridge_init.sql'));
        assert.ok(files.includes('0002_bridge_links.sql'));
        assert.ok(files.includes('0003_bridge_contacts.sql'));
        assert.ok(files.includes('0004_bridge_counters.sql'));
        assert.deepEqual(files, [...files].sort());
    });

    it('建立計畫書的十四張表（0001 的四張＋0002 的 products、links、auth_codes＋0003 的 bind_codes、contacts＋0004 的 counters、flags＋0006 的 event_fallbacks＋0007 的 identity_channels、identity_codes）', async () => {
        assert.deepEqual(await names('table'), ALL_TABLES);
    });

    it('建立計畫書的索引', async () => {
        const idx = await names('index');
        for (const i of [
            'idx_audit_log_bot_at', 'idx_idempotency_expiry', 'idx_service_keys_system',
            'uq_links_active', 'idx_links_bot', 'idx_auth_codes_expiry', 'idx_service_keys_link',
            'idx_bind_codes_ref', 'idx_bind_codes_expiry', 'idx_contacts_user', 'idx_counters_window', 'uq_products_key',
        ]) {
            assert.ok(idx.includes(i), `缺索引 ${i}`);
        }
    });

    it('沒有外鍵（刪系統時 batch 撤銷金鑰，撤銷紀錄保留）', async () => {
        for (const t of ['systems', 'service_keys', 'idempotency', 'audit_log', 'products', 'links', 'auth_codes', 'bind_codes', 'contacts', 'counters', 'flags']) {
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

describe('0004 遷移（M-01／M-02）', () => {
    const file = () => readMigrations().find((m) => m.name === '0004_bridge_counters.sql');

    it('檔案內沒有 IF NOT EXISTS，重複套用 0004 的每一句都失敗且不影響既有資料', async () => {
        assert.doesNotMatch(file().sql, /IF NOT EXISTS/i);
        await d1.db.prepare("INSERT INTO counters (scope_key, window, n) VALUES ('k', 60000, 3)").run();
        await d1.db.prepare("INSERT INTO flags (flag_key, until_at) VALUES ('f', 9)").run();
        await d1.db.prepare("INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at, allow_rebind) VALUES ('h','l','b','r',1,2,1)").run();
        const stmts = splitStatements(file().sql);
        assert.equal(stmts.length, 4);
        for (const stmt of stmts) {
            await assert.rejects(() => d1.db.prepare(stmt).run(), /already exists|duplicate column/i, stmt.slice(0, 40));
        }
        assert.equal((await d1.db.prepare('SELECT n FROM counters').first()).n, 3);
        assert.equal((await d1.db.prepare('SELECT allow_rebind AS a FROM bind_codes').first()).a, 1);
    });

    it('counters：(scope_key, window) 是複合主鍵；n、window 不可為 NULL', async () => {
        const ins = (k, w) => d1.db.prepare('INSERT INTO counters (scope_key, window, n) VALUES (?1, ?2, 1)').bind(k, w).run();
        await ins('a', 1);
        await assert.rejects(() => ins('a', 1), /UNIQUE constraint failed/i);
        await ins('a', 2);
        await ins('b', 1);
        await assert.rejects(() => d1.db.prepare("INSERT INTO counters (scope_key) VALUES ('x')").run(), /NOT NULL/i);
    });

    it('flags：flag_key 是主鍵；until_at NOT NULL', async () => {
        await d1.db.prepare("INSERT INTO flags (flag_key, until_at) VALUES ('f', 1)").run();
        await assert.rejects(() => d1.db.prepare("INSERT INTO flags (flag_key, until_at) VALUES ('f', 2)").run(), /UNIQUE constraint failed/i);
        await assert.rejects(() => d1.db.prepare("INSERT INTO flags (flag_key) VALUES ('g')").run(), /NOT NULL/i);
    });

    it('bind_codes.allow_rebind：NOT NULL、預設 0（既有的碼視為不許覆蓋）', async () => {
        await d1.db.prepare("INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES ('h','l','b','r',1,2)").run();
        assert.equal((await d1.db.prepare('SELECT allow_rebind AS a FROM bind_codes').first()).a, 0);
        const { results } = await d1.db.prepare('PRAGMA table_info(bind_codes)').all();
        const col = results.find((c) => c.name === 'allow_rebind');
        assert.equal(col.notnull, 1);
    });

    it('測試工具的 upTo：只套用到 0003 的資料庫沒有 counters、flags、allow_rebind', async () => {
        const old = await createTestD1({ upTo: '0003' });
        try {
            const { results } = await old.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
            const have = results.map((r) => r.name);
            assert.ok(!have.includes('counters') && !have.includes('flags'));
            const cols = (await old.db.prepare('PRAGMA table_info(bind_codes)').all()).results.map((c) => c.name);
            assert.ok(!cols.includes('allow_rebind'));
        } finally {
            await old.dispose();
        }
    });
});

describe('0005 遷移（LM-4D 分眾、product_key）', () => {
    const file = () => readMigrations().find((m) => m.name === '0005_bridge_segments.sql');

    it('存在、沒有 IF NOT EXISTS；重複套用每一句都失敗且不影響資料', async () => {
        assert.ok(file(), '缺 0005_bridge_segments.sql');
        assert.doesNotMatch(file().sql, /IF NOT EXISTS/i);
        await d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at, product_key) VALUES ('p','n','h','[]','[]',1,'ip')").run();
        const stmts = splitStatements(file().sql);
        assert.equal(stmts.length, 3);
        for (const stmt of stmts) {
            await assert.rejects(() => d1.db.prepare(stmt).run(), /already exists|duplicate column/i, stmt.slice(0, 40));
        }
        assert.equal((await d1.db.prepare('SELECT product_key AS k FROM products').first()).k, 'ip');
    });

    it('contacts.segment 可為 NULL、預設 NULL', async () => {
        await d1.db.prepare("INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES ('l','r','b','u','bound',1,1)").run();
        assert.equal((await d1.db.prepare('SELECT segment FROM contacts').first()).segment, null);
    });

    it('products.product_key：非 NULL 時唯一；多個 NULL 可以並存', async () => {
        const ins = (id, key) => d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at, product_key) VALUES (?1,'n','h','[]','[]',1,?2)").bind(id, key).run();
        await ins('p1', null);
        await ins('p2', null);
        await ins('p3', 'ip');
        await assert.rejects(() => ins('p4', 'ip'), /UNIQUE constraint failed/i);
    });

    it('只套用到 0004 的資料庫沒有 segment、product_key', async () => {
        const old = await createTestD1({ upTo: '0004' });
        try {
            const cols = async (t) => (await old.db.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
            assert.ok(!(await cols('contacts')).includes('segment'));
            assert.ok(!(await cols('products')).includes('product_key'));
        } finally {
            await old.dispose();
        }
    });
});

describe('0006 遷移（LM-4B 事件轉發）', () => {
    const file = () => readMigrations().find((m) => m.name === '0006_bridge_events.sql');

    it('存在、沒有 IF NOT EXISTS；重複套用每一句都失敗且不影響資料', async () => {
        assert.ok(file(), '缺 0006_bridge_events.sql');
        assert.doesNotMatch(file().sql, /IF NOT EXISTS/i);
        await d1.db.prepare("INSERT INTO event_fallbacks (bot_id, product_key, action, content, updated_at) VALUES ('b','ip','plans','{}',1)").run();
        const stmts = splitStatements(file().sql);
        assert.equal(stmts.length, 3);
        for (const stmt of stmts) {
            await assert.rejects(() => d1.db.prepare(stmt).run(), /already exists|duplicate column/i, stmt.slice(0, 40));
        }
        assert.equal((await d1.db.prepare('SELECT COUNT(*) AS n FROM event_fallbacks').first()).n, 1);
    });

    it('products.event_url、event_secret_enc 可為 NULL、預設 NULL', async () => {
        await d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, created_at) VALUES ('p','n','h','[]','[]',1)").run();
        const row = await d1.db.prepare('SELECT event_url, event_secret_enc FROM products').first();
        assert.equal(row.event_url, null);
        assert.equal(row.event_secret_enc, null);
    });

    it('event_fallbacks：(bot_id, product_key, action) 是主鍵；content、updated_at 不可為 NULL', async () => {
        const ins = (a) => d1.db.prepare("INSERT INTO event_fallbacks (bot_id, product_key, action, content, updated_at) VALUES ('b','ip',?1,'{}',1)").bind(a).run();
        await ins('plans');
        await assert.rejects(() => ins('plans'), /UNIQUE constraint failed/i);
        await ins('status');
        await assert.rejects(() => d1.db.prepare("INSERT INTO event_fallbacks (bot_id, product_key, action) VALUES ('b','ip','x')").run(), /NOT NULL/i);
    });

    it('只套用到 0005 的資料庫沒有 event_url、event_fallbacks', async () => {
        const old = await createTestD1({ upTo: '0005' });
        try {
            const cols = (await old.db.prepare('PRAGMA table_info(products)').all()).results.map((c) => c.name);
            assert.ok(!cols.includes('event_url') && !cols.includes('event_secret_enc'));
            const t = (await old.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'event_fallbacks'").all()).results;
            assert.equal(t.length, 0);
        } finally {
            await old.dispose();
        }
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
