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

let d1;
before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => { await d1.reset(); });

async function names(type) {
    const { results } = await d1.db.prepare('SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name').bind(type).all();
    return results.map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_'));
}

describe('遷移檔', () => {
    it('至少有 0001_bridge_init.sql，且檔名排序穩定', () => {
        const files = readMigrations().map((m) => m.name);
        assert.ok(files.includes('0001_bridge_init.sql'));
        assert.deepEqual(files, [...files].sort());
    });

    it('建立計畫書的四張表', async () => {
        assert.deepEqual(await names('table'), ['audit_log', 'idempotency', 'service_keys', 'systems']);
    });

    it('建立計畫書的索引', async () => {
        const idx = await names('index');
        for (const i of ['idx_audit_log_bot_at', 'idx_idempotency_expiry', 'idx_service_keys_system']) {
            assert.ok(idx.includes(i), `缺索引 ${i}`);
        }
    });

    it('沒有外鍵（刪系統時 batch 撤銷金鑰，撤銷紀錄保留）', async () => {
        for (const t of ['systems', 'service_keys', 'idempotency', 'audit_log']) {
            const { results } = await d1.db.prepare(`PRAGMA foreign_key_list(${t})`).all();
            assert.equal(results.length, 0, t);
        }
    });

    it('全部套用第二次會失敗（表已存在），第一次的結果不受影響', async () => {
        await assert.rejects(() => d1.applyMigrations(), /already exists/i);
        assert.deepEqual(await names('table'), ['audit_log', 'idempotency', 'service_keys', 'systems']);
    });

    it('在全新的資料庫上套用全部遷移檔：成功一次，表齊全', async () => {
        const fresh = await createTestD1();
        try {
            const { results } = await fresh.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
            assert.deepEqual(results.map((r) => r.name), ['audit_log', 'idempotency', 'service_keys', 'systems']);
        } finally {
            await fresh.dispose();
        }
    });

    it('splitStatements 不會把註解當成敘述', () => {
        const stmts = splitStatements('-- hi\nCREATE TABLE a (x INT); -- tail\nCREATE INDEX i ON a (x);');
        assert.deepEqual(stmts, ['CREATE TABLE a (x INT)', 'CREATE INDEX i ON a (x)']);
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
