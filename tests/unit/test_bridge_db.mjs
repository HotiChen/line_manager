/**
 * Unit Tests — bridge/db.js（Bridge 的資料層，D1）
 *
 * 用 Miniflare 的真 D1。重點是 KV 做不到的原子性：
 *   - 冪等搶佔：10 個並行只有 1 個贏；過期的紀錄可被接手
 *   - 註冊：同 (bot, system) 並行只有 1 個成功，且只有 1 把 key
 *   - 輪替：batch 失敗整批回滾；並行輪替後只剩 1 把有效
 *   - 刪除：撤銷金鑰＋刪系統同一批；撤銷過的 key 紀錄保留
 * 以及：所有值都走 bound parameter（SQL injection 字串只會被當資料存起來）。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedSystem, seedKey, all, count } from '../helpers/bridge_seed.mjs';
import * as bdb from '../../worker_src/bridge/db.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const H = (c) => c.repeat(64);

let d1;
let env;
const originalError = console.error;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { BRIDGE_DB: d1.db };
    console.error = () => {};
});
afterEach(() => { console.error = originalError; });

/** 讓每個 batch 多帶一句會違反 NOT NULL 的敘述：整批必須回滾 */
function failingBatchDb(real) {
    return {
        prepare: (s) => real.prepare(s),
        batch: (stmts) => real.batch([...stmts, real.prepare('INSERT INTO systems (bot_id) VALUES (NULL)')]),
    };
}

const newSystem = (over = {}) => ({
    botId: BOT, system: 'imgpicker', name: 'Image Picker', scopes: ['messages:push'], events: [],
    webhookUrl: null, createdBy: 'Uowner', keyHash: H('a'), now: 1000, ...over,
});

describe('binding 與 fail-closed', () => {
    it('沒有 BRIDGE_DB → BridgeDbError', async () => {
        await assert.rejects(() => bdb.getSystem({}, BOT, 's'), bdb.BridgeDbError);
        await assert.rejects(() => bdb.pingDb({}), bdb.BridgeDbError);
        await assert.rejects(() => bdb.getKeyWithSystem(undefined, H('a')), bdb.BridgeDbError);
    });

    it('查詢丟錯（例如缺表）→ 包成 BridgeDbError，不洩漏 SQL 細節給呼叫端的回應', async () => {
        await d1.db.prepare('ALTER TABLE systems RENAME TO systems_hidden').run();
        try {
            await assert.rejects(() => bdb.getSystem(env, BOT, 's'), bdb.BridgeDbError);
        } finally {
            await d1.db.prepare('ALTER TABLE systems_hidden RENAME TO systems').run();
        }
    });

    it('bridgeUnavailable() 是 503 {success:false,error:"bridge_not_configured"}', async () => {
        const res = bdb.bridgeUnavailable();
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { success: false, error: 'bridge_not_configured' });
    });

    it('pingDb 成功時不丟錯', async () => {
        await bdb.pingDb(env);
    });
});

describe('createSystemWithKey / getSystem / listSystems', () => {
    it('一次寫入系統與 key；key 只存雜湊與 scopes', async () => {
        const r = await bdb.createSystemWithKey(env, newSystem({ webhookUrl: 'https://x.example.com/h', events: ['a'] }));
        assert.equal(r.created, true);
        const sys = await bdb.getSystem(env, BOT, 'imgpicker');
        assert.equal(sys.name, 'Image Picker');
        assert.equal(sys.webhookUrl, 'https://x.example.com/h');
        assert.deepEqual(sys.events, ['a']);
        assert.deepEqual(sys.scopes, ['messages:push']);
        assert.equal(sys.disabled, false);
        assert.equal(sys.createdAt, 1000);
        assert.equal(sys.createdBy, 'Uowner');
        const keys = await all(d1.db, 'SELECT * FROM service_keys');
        assert.equal(keys.length, 1);
        assert.equal(keys[0].key_hash, H('a'));
        assert.equal(keys[0].revoked_at, null);
    });

    it('同 (bot, system) 第二次 → {created:false, conflict:true}，不留第二把 key', async () => {
        await bdb.createSystemWithKey(env, newSystem());
        const r = await bdb.createSystemWithKey(env, newSystem({ keyHash: H('b') }));
        assert.equal(r.created, false);
        assert.equal(r.conflict, true);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('不同 bot 可以同名', async () => {
        await bdb.createSystemWithKey(env, newSystem());
        const r = await bdb.createSystemWithKey(env, newSystem({ botId: OTHER_BOT, keyHash: H('b') }));
        assert.equal(r.created, true);
    });

    it('非約束類的錯誤（例如 NOT NULL）不會被當成 409，而是 BridgeDbError', async () => {
        await assert.rejects(() => bdb.createSystemWithKey(env, newSystem({ createdBy: null })), bdb.BridgeDbError);
        assert.equal(await count(d1.db, 'service_keys'), 0);
    });

    it('listSystems 只列自己 bot 的，依建立時間排序', async () => {
        await bdb.createSystemWithKey(env, newSystem({ system: 'bb', keyHash: H('1'), now: 2000 }));
        await bdb.createSystemWithKey(env, newSystem({ system: 'aa', keyHash: H('2'), now: 1000 }));
        await bdb.createSystemWithKey(env, newSystem({ botId: OTHER_BOT, system: 'zz', keyHash: H('3') }));
        const list = await bdb.listSystems(env, BOT);
        assert.deepEqual(list.map((s) => s.system), ['aa', 'bb']);
        assert.deepEqual(await bdb.listSystems(env, 'Unone'), []);
    });

    it('getSystem 不存在 → null；別的 bot 的看不到', async () => {
        await bdb.createSystemWithKey(env, newSystem());
        assert.equal(await bdb.getSystem(env, BOT, 'ghost'), null);
        assert.equal(await bdb.getSystem(env, OTHER_BOT, 'imgpicker'), null);
    });

    it('值一律走 bound parameter：SQL injection 字串只是資料', async () => {
        const evil = "x'); DROP TABLE systems; --";
        await bdb.createSystemWithKey(env, newSystem({ name: evil }));
        assert.equal((await bdb.getSystem(env, BOT, 'imgpicker')).name, evil);
        assert.equal(await bdb.getSystem(env, evil, evil), null);
        assert.equal(await count(d1.db, 'systems'), 1);
    });
});

describe('getKeyWithSystem', () => {
    it('key 與系統都在 → 兩者都回', async () => {
        await bdb.createSystemWithKey(env, newSystem({ scopes: ['messages:push', 'members:read'] }));
        const r = await bdb.getKeyWithSystem(env, H('a'));
        assert.equal(r.key.botId, BOT);
        assert.equal(r.key.system, 'imgpicker');
        assert.deepEqual(r.key.scopes, ['messages:push', 'members:read']);
        assert.equal(r.key.revokedAt, null);
        assert.equal(r.system.disabled, false);
        assert.equal(r.system.rateLimit, undefined);
    });

    it('查無 key → null（與「key 在但系統不在」可區分）', async () => {
        assert.equal(await bdb.getKeyWithSystem(env, H('f')), null);
    });

    it('key 在、系統不在 → {key, system:null}', async () => {
        await seedKey(d1.db, { botId: BOT, key: 'sk_orphan' });
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        const r = await bdb.getKeyWithSystem(env, await sha256Hex('sk_orphan'));
        assert.ok(r.key);
        assert.equal(r.system, null);
    });

    it('rate_limit 欄位解析成物件；壞掉的 JSON 當作沒設', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'a1', rateLimit: { write: 3 } });
        await seedKey(d1.db, { botId: BOT, system: 'a1', key: 'k1' });
        await d1.db.prepare("INSERT INTO systems (bot_id, system, name, scopes, rate_limit, created_by, created_at, updated_at) VALUES (?1,'bad','n','[]','{oops','u',1,1)").bind(BOT).run();
        await seedKey(d1.db, { botId: BOT, system: 'bad', key: 'k2' });
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        assert.deepEqual((await bdb.getKeyWithSystem(env, await sha256Hex('k1'))).system.rateLimit, { write: 3 });
        assert.equal((await bdb.getKeyWithSystem(env, await sha256Hex('k2'))).system.rateLimit, undefined);
    });
});

describe('updateSystem', () => {
    beforeEach(async () => { await bdb.createSystemWithKey(env, newSystem({ webhookUrl: 'https://a.example.com/h', events: ['e1'] })); });

    it('只改有給的欄位，updated_at 更新，其餘不動', async () => {
        const r = await bdb.updateSystem(env, BOT, 'imgpicker', { disabled: true }, 5000);
        assert.equal(r.disabled, true);
        assert.equal(r.webhookUrl, 'https://a.example.com/h');
        assert.deepEqual(r.events, ['e1']);
        const row = (await all(d1.db, 'SELECT updated_at, created_at FROM systems'))[0];
        assert.equal(row.updated_at, 5000);
        assert.equal(row.created_at, 1000);
    });

    it('webhookUrl 可設為 null；events 可換', async () => {
        const r = await bdb.updateSystem(env, BOT, 'imgpicker', { webhookUrl: null, events: ['x', 'y'] }, 5000);
        assert.equal(r.webhookUrl, null);
        assert.deepEqual(r.events, ['x', 'y']);
    });

    it('scopes 不是可更新欄位（傳了也被忽略）', async () => {
        await bdb.updateSystem(env, BOT, 'imgpicker', { disabled: false, scopes: ['members:read'] }, 5000);
        assert.deepEqual((await bdb.getSystem(env, BOT, 'imgpicker')).scopes, ['messages:push']);
        assert.equal((await all(d1.db, 'SELECT scopes FROM service_keys'))[0].scopes, '["messages:push"]');
    });

    it('不存在 → null；別的 bot 的改不到', async () => {
        assert.equal(await bdb.updateSystem(env, BOT, 'ghost', { disabled: true }, 1), null);
        assert.equal(await bdb.updateSystem(env, OTHER_BOT, 'imgpicker', { disabled: true }, 1), null);
        assert.equal((await bdb.getSystem(env, BOT, 'imgpicker')).disabled, false);
    });
});

describe('rotateKey', () => {
    beforeEach(async () => { await bdb.createSystemWithKey(env, newSystem({ scopes: ['messages:push', 'members:read'] })); });

    it('撤銷舊 key、發新 key（scopes 沿用）、系統 updated_at 更新', async () => {
        const ok = await bdb.rotateKey(env, { botId: BOT, system: 'imgpicker', keyHash: H('b'), now: 9000 });
        assert.equal(ok, true);
        const rows = await all(d1.db, 'SELECT key_hash, scopes, revoked_at FROM service_keys ORDER BY created_at, key_hash');
        const old = rows.find((r) => r.key_hash === H('a'));
        const fresh = rows.find((r) => r.key_hash === H('b'));
        assert.equal(old.revoked_at, 9000);
        assert.equal(fresh.revoked_at, null);
        assert.equal(fresh.scopes, '["messages:push","members:read"]');
        assert.equal((await all(d1.db, 'SELECT updated_at FROM systems'))[0].updated_at, 9000);
    });

    it('系統不存在 → false，且沒有留下孤兒 key', async () => {
        assert.equal(await bdb.rotateKey(env, { botId: BOT, system: 'ghost', keyHash: H('c'), now: 1 }), false);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('batch 中途失敗 → 整批回滾：舊 key 仍有效，沒有新 key，updated_at 不變', async () => {
        const broken = { BRIDGE_DB: failingBatchDb(d1.db) };
        await assert.rejects(() => bdb.rotateKey(broken, { botId: BOT, system: 'imgpicker', keyHash: H('b'), now: 9000 }), bdb.BridgeDbError);
        const rows = await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys');
        assert.deepEqual(rows, [{ key_hash: H('a'), revoked_at: null }]);
        assert.equal((await all(d1.db, 'SELECT updated_at FROM systems'))[0].updated_at, 1000);
    });

    it('並行輪替 5 次 → 恰好 1 把有效，其餘都已撤銷', async () => {
        const results = await Promise.all(
            ['1', '2', '3', '4', '5'].map((c) => bdb.rotateKey(env, { botId: BOT, system: 'imgpicker', keyHash: H(c), now: 9000 }))
        );
        assert.ok(results.every((r) => r === true));
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 6);
    });
});

describe('deleteSystem', () => {
    beforeEach(async () => { await bdb.createSystemWithKey(env, newSystem()); });

    it('刪系統並撤銷金鑰；撤銷過的 key 紀錄保留（稽核用）', async () => {
        assert.equal(await bdb.deleteSystem(env, BOT, 'imgpicker', 7000), true);
        assert.equal(await count(d1.db, 'systems'), 0);
        const keys = await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys');
        assert.deepEqual(keys, [{ key_hash: H('a'), revoked_at: 7000 }]);
    });

    it('不存在 → false；不影響別人', async () => {
        assert.equal(await bdb.deleteSystem(env, BOT, 'ghost', 1), false);
        assert.equal(await bdb.deleteSystem(env, OTHER_BOT, 'imgpicker', 1), false);
        assert.equal(await count(d1.db, 'systems'), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });

    it('batch 失敗 → 回滾：系統還在、key 仍有效', async () => {
        const broken = { BRIDGE_DB: failingBatchDb(d1.db) };
        await assert.rejects(() => bdb.deleteSystem(broken, BOT, 'imgpicker', 7000), bdb.BridgeDbError);
        assert.equal(await count(d1.db, 'systems'), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });

    it('已經撤銷過的 key 的 revoked_at 不會被覆寫', async () => {
        await bdb.rotateKey(env, { botId: BOT, system: 'imgpicker', keyHash: H('b'), now: 3000 });
        await bdb.deleteSystem(env, BOT, 'imgpicker', 7000);
        const rows = await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys ORDER BY key_hash');
        assert.deepEqual(rows, [{ key_hash: H('a'), revoked_at: 3000 }, { key_hash: H('b'), revoked_at: 7000 }]);
    });

    it('同名重新註冊後，新 key 有效、舊 key 仍是撤銷', async () => {
        await bdb.deleteSystem(env, BOT, 'imgpicker', 7000);
        const r = await bdb.createSystemWithKey(env, newSystem({ keyHash: H('c'), now: 8000 }));
        assert.equal(r.created, true);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });
});

describe('冪等紀錄', () => {
    const claim = (over = {}) => bdb.claimIdempotency(env, {
        botId: BOT, system: 'imgpicker', keyHash: H('1'), fingerprint: 'fp1', now: 1000, ...over,
    });

    it('第一次搶到，寫入 in_progress，2 分鐘後到期', async () => {
        const r = await claim();
        assert.equal(r.won, true);
        const row = (await all(d1.db, 'SELECT * FROM idempotency'))[0];
        assert.equal(row.status, 'in_progress');
        assert.equal(row.fingerprint, 'fp1');
        assert.equal(row.created_at, 1000);
        assert.equal(row.expires_at, 1000 + 120_000);
    });

    it('第二次搶不到，回傳既有紀錄（in_progress）', async () => {
        await claim();
        const r = await claim({ now: 2000 });
        assert.equal(r.won, false);
        assert.equal(r.existing.status, 'in_progress');
        assert.equal(r.existing.fingerprint, 'fp1');
    });

    it('10 個並行搶同一把 → 恰好 1 個贏', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => claim()));
        assert.equal(results.filter((r) => r.won).length, 1);
        assert.equal(results.filter((r) => !r.won).length, 9);
        assert.equal(await count(d1.db, 'idempotency'), 1);
    });

    it('並行搶、內容不同：贏的只有 1 個，輸的看到贏家的 fingerprint', async () => {
        const results = await Promise.all(['a', 'b', 'c', 'd'].map((f) => claim({ fingerprint: f })));
        const winners = results.filter((r) => r.won);
        assert.equal(winners.length, 1);
        const stored = (await all(d1.db, 'SELECT fingerprint FROM idempotency'))[0].fingerprint;
        for (const r of results.filter((x) => !x.won)) assert.equal(r.existing.fingerprint, stored);
    });

    it('in_progress 過了 2 分鐘 → 可被接手（Worker 被回收不會把 key 鎖死）', async () => {
        await claim({ now: 1000 });
        assert.equal((await claim({ now: 1000 + 119_999 })).won, false);
        assert.equal((await claim({ now: 1000 + 120_001, fingerprint: 'fp2' })).won, true);
        const row = (await all(d1.db, 'SELECT * FROM idempotency'))[0];
        assert.equal(row.fingerprint, 'fp2');
        assert.equal(row.status, 'in_progress');
    });

    it('並行接手過期紀錄 → 仍然只有 1 個贏', async () => {
        await claim({ now: 1000 });
        const results = await Promise.all(Array.from({ length: 8 }, () => claim({ now: 1000 + 200_000 })));
        assert.equal(results.filter((r) => r.won).length, 1);
    });

    it('complete 後狀態是 done、帶回應，24 小時到期；之後搶不到並回放', async () => {
        await claim();
        await bdb.completeIdempotency(env, {
            botId: BOT, system: 'imgpicker', keyHash: H('1'), fingerprint: 'fp1',
            response: { status: 200, body: { success: true, quotaConsumed: 1 } }, now: 5000,
        });
        const row = (await all(d1.db, 'SELECT * FROM idempotency'))[0];
        assert.equal(row.status, 'done');
        assert.equal(row.response_status, 200);
        assert.equal(row.expires_at, 5000 + 24 * 3600 * 1000);
        const r = await claim({ now: 6000 });
        assert.equal(r.won, false);
        assert.equal(r.existing.status, 'done');
        assert.deepEqual(r.existing.response, { status: 200, body: { success: true, quotaConsumed: 1 } });
    });

    it('done 超過 24 小時 → 可被接手（重新執行）', async () => {
        await claim();
        await bdb.completeIdempotency(env, { botId: BOT, system: 'imgpicker', keyHash: H('1'), fingerprint: 'fp1', response: { status: 200, body: {} }, now: 5000 });
        assert.equal((await claim({ now: 5000 + 24 * 3600 * 1000 + 1 })).won, true);
    });

    it('release 刪掉 in_progress，之後可重新搶', async () => {
        await claim();
        await bdb.releaseIdempotency(env, { botId: BOT, system: 'imgpicker', keyHash: H('1') });
        assert.equal(await count(d1.db, 'idempotency'), 0);
        assert.equal((await claim()).won, true);
    });

    it('release 不會刪掉已完成的紀錄', async () => {
        await claim();
        await bdb.completeIdempotency(env, { botId: BOT, system: 'imgpicker', keyHash: H('1'), fingerprint: 'fp1', response: { status: 200, body: {} }, now: 5000 });
        await bdb.releaseIdempotency(env, { botId: BOT, system: 'imgpicker', keyHash: H('1') });
        assert.equal(await count(d1.db, 'idempotency'), 1);
    });

    it('不同 bot / system / key 互不影響', async () => {
        assert.equal((await claim()).won, true);
        assert.equal((await claim({ botId: OTHER_BOT })).won, true);
        assert.equal((await claim({ system: 'other' })).won, true);
        assert.equal((await claim({ keyHash: H('2') })).won, true);
    });

    it('response_body 含特殊字元也能原樣取回', async () => {
        await claim();
        const body = { error: "it's \"quoted\"; DROP TABLE x;--", n: [1, 2] };
        await bdb.completeIdempotency(env, { botId: BOT, system: 'imgpicker', keyHash: H('1'), fingerprint: 'fp1', response: { status: 409, body }, now: 5000 });
        assert.deepEqual((await claim({ now: 6000 })).existing.response, { status: 409, body });
    });
});

describe('writeAudit', () => {
    it('寫入一列；at 預設為現在', async () => {
        const before = Date.now();
        await bdb.writeAudit(env, { actorType: 'user', actorId: 'Uowner', botId: BOT, system: 's', action: 'system_created', result: 'ok', detail: { scopes: ['messages:push'] } });
        const row = (await all(d1.db, 'SELECT * FROM audit_log'))[0];
        assert.equal(row.actor_type, 'user');
        assert.equal(row.actor_id, 'Uowner');
        assert.equal(row.bot_id, BOT);
        assert.equal(row.action, 'system_created');
        assert.ok(row.at >= before);
        assert.deepEqual(JSON.parse(row.detail), { scopes: ['messages:push'] });
    });

    it('raw:push 通過 scopes 白名單（不會被當成不合法而丟掉）', async () => {
        await bdb.writeAudit(env, { actorType: 'user', actorId: 'Uowner', botId: BOT, system: 's', action: 'system_created', result: 'ok', detail: { scopes: ['raw:push', 'members:read', 'tags:write'] } });
        const row = (await all(d1.db, 'SELECT * FROM audit_log'))[0];
        assert.deepEqual(JSON.parse(row.detail), { scopes: ['raw:push', 'members:read', 'tags:write'] });
    });

    it('detail 只收白名單欄位：其他（訊息內文、金鑰、LINE userId）一律丟掉', async () => {
        await bdb.writeAudit(env, {
            actorType: 'service_key', actorId: 'imgpicker', botId: BOT, system: 'imgpicker', action: 'push', result: 'sent',
            detail: {
                recipients: 1, messages: 2, cost: 2, status: 200, error: 'target_inactive',
                text: 'secret message body', apiKey: 'sk_secret', keyHash: H('a'), to: 'U1234567890abcdef1234567890abcdef',
                messagesBody: [{ type: 'text', text: 'hi' }], nested: { a: 1 },
            },
        });
        const d = JSON.parse((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail);
        assert.deepEqual(d, { recipients: 1, messages: 2, cost: 2, status: 200, error: 'target_inactive' });
    });

    it('白名單欄位的型別也要對：字串欄位不收長字串／奇怪字元，數字欄位只收有限整數', async () => {
        await bdb.writeAudit(env, {
            actorType: 'service_key', actorId: 's', botId: BOT, system: 's', action: 'push', result: 'failed',
            detail: { error: 'Hello, this is a message text!', recipients: '3', messages: 1.5, cost: -1, status: 502 },
        });
        const d = JSON.parse((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail);
        assert.deepEqual(d, { status: 502 });
    });

    it('沒有 detail → detail 欄位是 NULL', async () => {
        await bdb.writeAudit(env, { actorType: 'user', actorId: 'U', botId: BOT, system: 's', action: 'system_deleted', result: 'ok' });
        assert.equal((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail, null);
    });

    it('best-effort：資料庫壞掉或沒綁定，不丟錯，只記 message', async () => {
        const logged = [];
        console.error = (...a) => logged.push(a.map(String).join(' '));
        await bdb.writeAudit({}, { actorType: 'user', actorId: 'U', action: 'x', result: 'ok' });
        await bdb.writeAudit({ BRIDGE_DB: { prepare() { throw new Error('d1 exploded'); } } }, { actorType: 'user', actorId: 'U', action: 'x', result: 'ok' });
        assert.ok(logged.length >= 1);
        assert.doesNotMatch(logged.join('\n'), /\n\s+at /);
    });

    it('缺必要欄位（action / result / actorType）→ 不寫、不丟錯', async () => {
        await bdb.writeAudit(env, { actorType: 'user', actorId: 'U' });
        assert.equal(await count(d1.db, 'audit_log'), 0);
    });
});
