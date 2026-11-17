/**
 * Unit Tests — bridge/systems.js（系統註冊與 service key，人主體操作）
 *
 *   POST   /bridge/v1/systems                       註冊，回傳 apiKey（只回這一次）
 *   GET    /bridge/v1/systems                       列出（不含任何 key 資訊）
 *   PATCH  /bridge/v1/systems/{system}              改 webhookUrl / events / disabled
 *   POST   /bridge/v1/systems/{system}/keys/rotate  輪替 key，舊 key 立即失效
 *   DELETE /bridge/v1/systems/{system}              刪除，key 立即失效
 *
 * 安全性質：
 *   - D1 裡找不到 key 原文（只有 SHA-256）
 *   - 註冊／輪替／刪除是原子的（D1 唯一約束與 batch）；每個動作寫 audit_log
 *   - 缺 BRIDGE_DB 或查詢失敗 → 503 bridge_not_configured，不退回 KV
 *   - 只有 owner 能操作；member 與 service key 都不行（key 不能發 key）
 *   - 輸入驗證：system 名稱、scopes、webhookUrl
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { authenticateBridge } from '../../worker_src/bridge/auth.js';
import {
    handleCreateSystem,
    handleListSystems,
    handleUpdateSystem,
    handleRotateKey,
    handleDeleteSystem,
    route,
} from '../../worker_src/bridge/systems.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';

let d1;
let env;

function req(body, method = 'POST', path = '/bridge/v1/systems', headers = {}) {
    const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined) init.body = JSON.stringify(body);
    return new Request(`https://worker.example.com${path}`, init);
}

async function seedBot() {
    await env.KV_LINE_STORAGE.put(
        BotKeys.permissions(BOT),
        JSON.stringify({ users: [{ userId: OWNER, role: 'owner' }, { userId: MEMBER, role: 'member' }] })
    );
    await env.KV_LINE_STORAGE.put(BotKeys.info(BOT), JSON.stringify({ name: 'Bot' }));
}

async function create(body = { system: 'imgpicker', name: 'Image Picker' }) {
    const res = await handleCreateSystem(req(body), env, OWNER, BOT, 'owner');
    return { res, body: await res.json() };
}

function bridgeReq(key) {
    return new Request('https://worker.example.com/bridge/v1/raw/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'X-Bot-Id': BOT },
    });
}

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { KV_LINE_STORAGE: createMockKV(), BRIDGE_DB: d1.db };
    await seedBot();
});

describe('POST /systems', () => {
    it('201，回傳 apiKey（brk_ 開頭），預設 scope 是 raw:push', async () => {
        const { res, body } = await create();
        assert.equal(res.status, 201);
        assert.equal(body.success, true);
        assert.match(body.apiKey, /^brk_[0-9a-f]{6}_[A-Za-z0-9_-]{43}$/);
        assert.equal(body.system, 'imgpicker');
        assert.deepEqual(body.scopes, ['raw:push']);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
    });

    it('舊 scope 名 messages:push 在註冊時正規化成 raw:push，D1 不寫舊名', async () => {
        const { res, body } = await create({ system: 's1', name: 'S', scopes: ['messages:push', 'members:read'] });
        assert.equal(res.status, 201);
        assert.deepEqual(body.scopes, ['raw:push', 'members:read']);
        for (const table of ['systems', 'service_keys']) {
            for (const row of await all(d1.db, `SELECT scopes FROM ${table}`)) {
                assert.ok(!row.scopes.includes('messages:push'), `${table}: ${row.scopes}`);
                assert.ok(row.scopes.includes('raw:push'), `${table}: ${row.scopes}`);
            }
        }
        const log = await all(d1.db, "SELECT detail FROM audit_log WHERE action = 'system_created'");
        assert.deepEqual(JSON.parse(log[0].detail), { scopes: ['raw:push', 'members:read'] });
    });

    it('messages:push 與 raw:push 同時帶 → 去重成一個 raw:push', async () => {
        const { res, body } = await create({ system: 's1', name: 'S', scopes: ['messages:push', 'raw:push'] });
        assert.equal(res.status, 201);
        assert.deepEqual(body.scopes, ['raw:push']);
    });

    it('只帶 messages:push → 通過驗證並以 raw:push 運作（能過 raw/push 的 scope 檢查）', async () => {
        const { body } = await create({ system: 's1', name: 'S', scopes: ['messages:push'] });
        const auth = await authenticateBridge(bridgeReq(body.apiKey), env);
        assert.deepEqual(auth.principal.scopes, ['raw:push']);
    });

    it('未知 scope 仍然 400', async () => {
        assert.equal((await create({ system: 's2', name: 'S', scopes: ['admin:everything'] })).res.status, 400);
    });

    it('D1 裡找不到 key 原文（只存雜湊）；KV 也沒有', async () => {
        const { body } = await create();
        for (const table of ['systems', 'service_keys', 'idempotency', 'audit_log']) {
            for (const row of await all(d1.db, `SELECT * FROM ${table}`)) {
                assert.ok(!JSON.stringify(row).includes(body.apiKey), `${table} 含原文: ${JSON.stringify(row)}`);
            }
        }
        for (const [k, v] of env.KV_LINE_STORAGE._store) {
            assert.ok(!k.includes(body.apiKey), `key 名稱含原文: ${k}`);
            assert.ok(!String(v).includes(body.apiKey), `值含原文: ${k}`);
        }
        const [row] = await all(d1.db, 'SELECT key_hash FROM service_keys');
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        assert.equal(row.key_hash, await sha256Hex(body.apiKey));
    });

    it('註冊不再寫 KV（系統與 key 都在 D1）', async () => {
        const before = env.KV_LINE_STORAGE._store.size;
        await create();
        assert.equal(env.KV_LINE_STORAGE._store.size, before);
        assert.equal(await count(d1.db, 'systems'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('回傳的 key 可以通過 authenticateBridge', async () => {
        const { body } = await create();
        const auth = await authenticateBridge(bridgeReq(body.apiKey), env);
        assert.equal(auth.authenticated, true);
        assert.equal(auth.principal.botId, BOT);
        assert.equal(auth.principal.system, 'imgpicker');
    });

    it('指定的 scopes 會生效', async () => {
        const { res, body } = await create({ system: 's1', name: 'S', scopes: ['raw:push', 'members:read'] });
        assert.equal(res.status, 201);
        assert.deepEqual(body.scopes, ['raw:push', 'members:read']);
    });

    it('webhookUrl 與 events 會存起來', async () => {
        await create({
            system: 's1', name: 'S',
            webhookUrl: 'https://img.example.com/hook', events: ['message.received'],
        });
        const list = await (await handleListSystems(req(undefined, 'GET'), env, OWNER, BOT, 'owner')).json();
        assert.equal(list.systems[0].webhookUrl, 'https://img.example.com/hook');
        assert.deepEqual(list.systems[0].events, ['message.received']);
    });

    it('重複註冊同一個 system → 409，且不會發出第二把 key', async () => {
        await create();
        const { res, body } = await create();
        assert.equal(res.status, 409);
        assert.equal(body.apiKey, undefined);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('同一個 (bot, system) 並行註冊 2 次 → 恰好 1 個 201、1 個 409，且只有 1 把 key', async () => {
        const [a, b] = await Promise.all([create(), create()]);
        assert.deepEqual([a.res.status, b.res.status].sort(), [201, 409]);
        assert.equal(await count(d1.db, 'systems'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 1);
        const winner = a.res.status === 201 ? a.body : b.body;
        assert.equal((await authenticateBridge(bridgeReq(winner.apiKey), env)).authenticated, true);
    });

    it('並行註冊 8 次 → 恰好 1 個成功', async () => {
        const rs = await Promise.all(Array.from({ length: 8 }, () => create()));
        assert.equal(rs.filter((r) => r.res.status === 201).length, 1);
        assert.equal(rs.filter((r) => r.res.status === 409).length, 7);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('不同 bot 可以用相同的 system 名稱', async () => {
        await create();
        const OTHER = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        const res = await handleCreateSystem(req({ system: 'imgpicker', name: 'X' }), env, OWNER, OTHER, 'owner');
        assert.equal(res.status, 201);
    });

    for (const bad of ['', 'A', 'Upper', 'has space', 'a:b', 'a/b', 'x'.repeat(33), '-start', 123, null]) {
        it(`拒絕不合法的 system 名稱 ${JSON.stringify(bad)}`, async () => {
            const { res } = await create({ system: bad, name: 'S' });
            assert.equal(res.status, 400);
        });
    }

    it('缺 name → 400', async () => {
        const { res } = await create({ system: 'abc' });
        assert.equal(res.status, 400);
    });

    it('未知的 scope → 400', async () => {
        const { res } = await create({ system: 'abc', name: 'S', scopes: ['admin:everything'] });
        assert.equal(res.status, 400);
    });

    it('scopes 不是陣列或是空陣列 → 400', async () => {
        assert.equal((await create({ system: 'abc', name: 'S', scopes: 'messages:push' })).res.status, 400);
        assert.equal((await create({ system: 'abc', name: 'S', scopes: [] })).res.status, 400);
    });

    it('webhookUrl 必須是 https', async () => {
        const { res } = await create({ system: 'abc', name: 'S', webhookUrl: 'http://img.example.com/hook' });
        assert.equal(res.status, 400);
    });

    it('webhookUrl 不能指向 localhost / 內網', async () => {
        for (const u of ['https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://192.168.1.1/h']) {
            const { res } = await create({ system: 'abc', name: 'S', webhookUrl: u });
            assert.equal(res.status, 400, u);
        }
    });

    it('body 不是合法 JSON → 400，不是 500', async () => {
        const bad = new Request('https://worker.example.com/bridge/v1/systems', { method: 'POST', body: '{nope' });
        const res = await handleCreateSystem(bad, env, OWNER, BOT, 'owner');
        assert.equal(res.status, 400);
    });
});

describe('GET /systems', () => {
    it('空清單', async () => {
        const res = await handleListSystems(req(undefined, 'GET'), env, OWNER, BOT, 'owner');
        assert.deepEqual((await res.json()).systems, []);
    });

    it('列出已註冊的系統，且不含任何 key 資訊', async () => {
        const { body } = await create();
        const res = await handleListSystems(req(undefined, 'GET'), env, OWNER, BOT, 'owner');
        const text = JSON.stringify(await res.json());
        assert.ok(text.includes('imgpicker'));
        assert.ok(!text.includes(body.apiKey));
        assert.ok(!/keyHash|key_hash|apiKey|revokedAt|revoked_at/.test(text));
    });

    it('只看得到自己 bot 的系統', async () => {
        await create();
        const OTHER = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        const res = await handleListSystems(req(undefined, 'GET'), env, OWNER, OTHER, 'owner');
        assert.deepEqual((await res.json()).systems, []);
    });
});

describe('PATCH /systems/{system}', () => {
    it('disabled=true 後，原本有效的 key 立即被拒', async () => {
        const { body } = await create();
        const res = await handleUpdateSystem(req({ disabled: true }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal(res.status, 200);
        const auth = await authenticateBridge(bridgeReq(body.apiKey), env);
        assert.equal(auth.authenticated, false);
        assert.equal(auth.status, 403);
    });

    it('disabled=false 可恢復', async () => {
        const { body } = await create();
        await handleUpdateSystem(req({ disabled: true }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        await handleUpdateSystem(req({ disabled: false }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal((await authenticateBridge(bridgeReq(body.apiKey), env)).authenticated, true);
    });

    it('可以改 webhookUrl / events', async () => {
        await create();
        const res = await handleUpdateSystem(
            req({ webhookUrl: 'https://new.example.com/h', events: ['postback'] }, 'PATCH'),
            env, OWNER, BOT, 'owner', 'imgpicker'
        );
        assert.equal(res.status, 200);
        const list = await (await handleListSystems(req(undefined, 'GET'), env, OWNER, BOT, 'owner')).json();
        assert.equal(list.systems[0].webhookUrl, 'https://new.example.com/h');
    });

    it('scopes 不可經由 PATCH 變更（要換權限請重新註冊）', async () => {
        const { body } = await create();
        await handleUpdateSystem(req({ scopes: ['members:read'] }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        const auth = await authenticateBridge(bridgeReq(body.apiKey), env);
        assert.deepEqual(auth.principal.scopes, ['raw:push']);
    });

    it('不存在的 system → 404', async () => {
        const res = await handleUpdateSystem(req({ disabled: true }, 'PATCH'), env, OWNER, BOT, 'owner', 'ghost');
        assert.equal(res.status, 404);
    });

    it('不合法的 webhookUrl → 400', async () => {
        await create();
        const res = await handleUpdateSystem(req({ webhookUrl: 'ftp://x' }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal(res.status, 400);
    });

    it('不能改別的 bot 的 system', async () => {
        await create();
        const OTHER = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        const res = await handleUpdateSystem(req({ disabled: true }, 'PATCH'), env, OWNER, OTHER, 'owner', 'imgpicker');
        assert.equal(res.status, 404);
    });
});

describe('POST /systems/{system}/keys/rotate', () => {
    it('發新 key，舊 key 立即失效，新 key 可用', async () => {
        const { body: first } = await create();
        const res = await handleRotateKey(req({}, 'POST'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal(res.status, 200);
        const second = await res.json();
        assert.match(second.apiKey, /^brk_[0-9a-f]{6}_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(second.apiKey, first.apiKey);

        assert.equal((await authenticateBridge(bridgeReq(first.apiKey), env)).authenticated, false);
        assert.equal((await authenticateBridge(bridgeReq(second.apiKey), env)).authenticated, true);
    });

    it('輪替後 scopes 保持不變', async () => {
        await create({ system: 's1', name: 'S', scopes: ['raw:push', 'members:read'] });
        const second = await (await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 's1')).json();
        const auth = await authenticateBridge(bridgeReq(second.apiKey), env);
        assert.deepEqual(auth.principal.scopes, ['raw:push', 'members:read']);
    });

    it('不存在的 system → 404，沒有留下孤兒 key', async () => {
        const res = await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'ghost');
        assert.equal(res.status, 404);
        assert.equal(await count(d1.db, 'service_keys'), 0);
    });

    it('並行輪替 5 次 → 恰好 1 把有效；回傳的 key 只有最後勝出的那把能用', async () => {
        await create();
        const rs = await Promise.all(Array.from({ length: 5 }, () => handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker')));
        assert.ok(rs.every((r) => r.status === 200));
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        const keys = await Promise.all(rs.map(async (r) => (await r.json()).apiKey));
        const valid = [];
        for (const k of keys) if ((await authenticateBridge(bridgeReq(k), env)).authenticated) valid.push(k);
        assert.equal(valid.length, 1);
    });

    it('輪替中途失敗 → 回滾：503，舊 key 仍有效，沒有新 key', async () => {
        const { body: first } = await create();
        const origError = console.error;
        console.error = () => {};
        try {
            const broken = { ...env, BRIDGE_DB: {
                prepare: (q) => d1.db.prepare(q),
                batch: (stmts) => d1.db.batch([...stmts, d1.db.prepare('INSERT INTO systems (bot_id) VALUES (NULL)')]),
            } };
            const res = await handleRotateKey(req({}), broken, OWNER, BOT, 'owner', 'imgpicker');
            assert.equal(res.status, 503);
            assert.deepEqual(await res.json(), { success: false, error: 'bridge_not_configured' });
        } finally {
            console.error = origError;
        }
        assert.equal(await count(d1.db, 'service_keys'), 1);
        assert.equal((await authenticateBridge(bridgeReq(first.apiKey), env)).authenticated, true);
        assert.equal(await count(d1.db, 'audit_log', "action = 'key_rotated'"), 0);
    });

    it('連續輪替多次，只有最新那把有效', async () => {
        const { body: k1 } = await create();
        const k2 = await (await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker')).json();
        const k3 = await (await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker')).json();
        assert.equal((await authenticateBridge(bridgeReq(k1.apiKey), env)).authenticated, false);
        assert.equal((await authenticateBridge(bridgeReq(k2.apiKey), env)).authenticated, false);
        assert.equal((await authenticateBridge(bridgeReq(k3.apiKey), env)).authenticated, true);
    });
});

describe('DELETE /systems/{system}', () => {
    it('刪除後 key 立即失效，清單也看不到', async () => {
        const { body } = await create();
        const res = await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal(res.status, 200);
        assert.equal((await authenticateBridge(bridgeReq(body.apiKey), env)).authenticated, false);
        const list = await (await handleListSystems(req(undefined, 'GET'), env, OWNER, BOT, 'owner')).json();
        assert.deepEqual(list.systems, []);
    });

    it('刪除後可以用同名重新註冊，發新 key', async () => {
        await create();
        await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'imgpicker');
        const { res } = await create();
        assert.equal(res.status, 201);
    });

    it('刪除後 key 紀錄保留但已撤銷（稽核用），系統那列不在了', async () => {
        const { body } = await create();
        await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'imgpicker');
        assert.equal(await count(d1.db, 'systems'), 0);
        const keys = await all(d1.db, 'SELECT revoked_at FROM service_keys');
        assert.equal(keys.length, 1);
        assert.equal(typeof keys[0].revoked_at, 'number');
        assert.equal((await authenticateBridge(bridgeReq(body.apiKey), env)).status, 401);
    });

    it('刪除中途失敗 → 回滾：系統與 key 都還在', async () => {
        const { body } = await create();
        const origError = console.error;
        console.error = () => {};
        try {
            const broken = { ...env, BRIDGE_DB: {
                prepare: (q) => d1.db.prepare(q),
                batch: (stmts) => d1.db.batch([...stmts, d1.db.prepare('INSERT INTO systems (bot_id) VALUES (NULL)')]),
            } };
            const res = await handleDeleteSystem(req(undefined, 'DELETE'), broken, OWNER, BOT, 'owner', 'imgpicker');
            assert.equal(res.status, 503);
        } finally {
            console.error = origError;
        }
        assert.equal(await count(d1.db, 'systems'), 1);
        assert.equal((await authenticateBridge(bridgeReq(body.apiKey), env)).authenticated, true);
    });

    it('不存在的 system → 404', async () => {
        const res = await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'ghost');
        assert.equal(res.status, 404);
    });
});

describe('route — 權限', () => {
    function routed(method, path, body, userId) {
        return route(req(body, method, path, { 'X-Bot-Id': BOT }), env, userId, path);
    }

    it('owner 可以註冊', async () => {
        const res = await routed('POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }, OWNER);
        assert.equal(res.status, 201);
    });

    it('member 不可以註冊 → 403，且沒有留下任何 key', async () => {
        const before = env.KV_LINE_STORAGE._store.size;
        const res = await routed('POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }, MEMBER);
        assert.equal(res.status, 403);
        assert.equal(env.KV_LINE_STORAGE._store.size, before);
        assert.equal(await count(d1.db, 'service_keys'), 0);
        assert.equal(await count(d1.db, 'systems'), 0);
        assert.equal(await count(d1.db, 'audit_log'), 0);
    });

    it('member 不可以列出 / 改 / 輪替 / 刪除', async () => {
        await routed('POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }, OWNER);
        assert.equal((await routed('GET', '/bridge/v1/systems', undefined, MEMBER)).status, 403);
        assert.equal((await routed('PATCH', '/bridge/v1/systems/abc', { disabled: true }, MEMBER)).status, 403);
        assert.equal((await routed('POST', '/bridge/v1/systems/abc/keys/rotate', {}, MEMBER)).status, 403);
        assert.equal((await routed('DELETE', '/bridge/v1/systems/abc', undefined, MEMBER)).status, 403);
    });

    it('不在這個 bot 的人 → 403', async () => {
        const res = await routed('GET', '/bridge/v1/systems', undefined, 'Ustranger000000000000000000000009');
        assert.equal(res.status, 403);
    });

    it('owner 走完整路由：註冊 → 列出 → 輪替 → 刪除', async () => {
        assert.equal((await routed('POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }, OWNER)).status, 201);
        assert.equal((await routed('GET', '/bridge/v1/systems', undefined, OWNER)).status, 200);
        assert.equal((await routed('POST', '/bridge/v1/systems/abc/keys/rotate', {}, OWNER)).status, 200);
        assert.equal((await routed('DELETE', '/bridge/v1/systems/abc', undefined, OWNER)).status, 200);
    });

    it('未知路徑 → 404', async () => {
        const res = await routed('GET', '/bridge/v1/systems/abc/nope', undefined, OWNER);
        assert.equal(res.status, 404);
    });

    it('system 名稱含 URL 編碼的 ":" 也不能鑽進別的 key', async () => {
        const res = await routed('DELETE', '/bridge/v1/systems/a%3Ab', undefined, OWNER);
        assert.ok(res.status === 400 || res.status === 404);
    });
});

describe('稽核紀錄（audit_log）', () => {
    const rows = () => all(d1.db, 'SELECT * FROM audit_log ORDER BY id');

    it('註冊／修改／輪替／刪除各一筆，actor 是 LIFF userId', async () => {
        await create({ system: 'imgpicker', name: 'Image Picker', scopes: ['raw:push', 'members:read'] });
        await handleUpdateSystem(req({ disabled: true, events: ['x'] }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker');
        await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'imgpicker');
        const log = await rows();
        assert.deepEqual(log.map((r) => r.action), ['system_created', 'system_updated', 'key_rotated', 'system_deleted']);
        for (const r of log) {
            assert.equal(r.actor_type, 'user');
            assert.equal(r.actor_id, OWNER);
            assert.equal(r.bot_id, BOT);
            assert.equal(r.system, 'imgpicker');
            assert.equal(r.result, 'ok');
            assert.equal(typeof r.at, 'number');
        }
        assert.deepEqual(JSON.parse(log[0].detail), { scopes: ['raw:push', 'members:read'] });
        assert.deepEqual(JSON.parse(log[1].detail), { fields: ['events', 'disabled'], disabled: true });
        assert.equal(log[2].detail, null);
    });

    it('失敗的操作不寫稽核（409、404、400）', async () => {
        await create();
        await create();
        await handleUpdateSystem(req({ disabled: true }, 'PATCH'), env, OWNER, BOT, 'owner', 'ghost');
        await handleUpdateSystem(req({ webhookUrl: 'ftp://x' }, 'PATCH'), env, OWNER, BOT, 'owner', 'imgpicker');
        await handleDeleteSystem(req(undefined, 'DELETE'), env, OWNER, BOT, 'owner', 'ghost');
        assert.deepEqual((await rows()).map((r) => r.action), ['system_created']);
    });

    it('稽核寫入失敗不會讓成功的請求變成錯誤', async () => {
        const origError = console.error;
        console.error = () => {};
        try {
            await d1.db.prepare('ALTER TABLE audit_log RENAME TO audit_log_x').run();
            const { res, body } = await create();
            assert.equal(res.status, 201);
            assert.match(body.apiKey, /^brk_/);
            const rot = await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker');
            assert.equal(rot.status, 200);
        } finally {
            await d1.db.prepare('ALTER TABLE audit_log_x RENAME TO audit_log').run();
            console.error = origError;
        }
    });

    it('稽核裡沒有 apiKey、雜湊，也沒有 webhookUrl', async () => {
        const { body } = await create({ system: 'imgpicker', name: 'N', webhookUrl: 'https://x.example.com/secret-path' });
        await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'imgpicker');
        const text = JSON.stringify(await rows());
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        assert.ok(!text.includes(body.apiKey));
        assert.ok(!text.includes(await sha256Hex(body.apiKey)));
        assert.ok(!text.includes('secret-path'));
    });
});

describe('fail-closed：資料庫缺失或壞掉 → 503 bridge_not_configured', () => {
    const originalError = console.error;
    beforeEach(() => { console.error = () => {}; });
    afterEach(() => { console.error = originalError; });

    const NOT_CONFIGURED = { success: false, error: 'bridge_not_configured' };
    const routed = (method, path, body, e) => route(req(body, method, path, { 'X-Bot-Id': BOT }), e, OWNER, path);

    it('沒有 BRIDGE_DB：每一條人主體的 systems 路由都是 503，不退回 KV', async () => {
        const noDb = { KV_LINE_STORAGE: env.KV_LINE_STORAGE };
        for (const [m, p, b] of [
            ['POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }],
            ['GET', '/bridge/v1/systems'],
            ['PATCH', '/bridge/v1/systems/abc', { disabled: true }],
            ['POST', '/bridge/v1/systems/abc/keys/rotate', {}],
            ['DELETE', '/bridge/v1/systems/abc'],
        ]) {
            const res = await routed(m, p, b, noDb);
            assert.equal(res.status, 503, `${m} ${p}`);
            assert.deepEqual(await res.json(), NOT_CONFIGURED);
        }
        assert.equal(await count(d1.db, 'systems'), 0);
    });

    it('查詢丟錯 → 503，回應不含錯誤細節或 stack', async () => {
        const broken = { ...env, BRIDGE_DB: { prepare() { throw new Error('d1 exploded SECRET_SQL_DETAIL'); } } };
        const res = await routed('POST', '/bridge/v1/systems', { system: 'abc', name: 'S' }, broken);
        assert.equal(res.status, 503);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), NOT_CONFIGURED);
        assert.doesNotMatch(text, /exploded|SECRET_SQL_DETAIL|stack|\.js:/);
    });

    it('缺表（遷移沒套用）→ 503', async () => {
        await d1.db.prepare('ALTER TABLE systems RENAME TO systems_x').run();
        try {
            const res = await routed('GET', '/bridge/v1/systems', undefined, env);
            assert.equal(res.status, 503);
            assert.deepEqual(await res.json(), NOT_CONFIGURED);
        } finally {
            await d1.db.prepare('ALTER TABLE systems_x RENAME TO systems').run();
        }
    });
});
