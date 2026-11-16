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
 *   - KV 裡找不到 key 原文（只有 SHA-256）
 *   - 只有 owner 能操作；member 與 service key 都不行（key 不能發 key）
 *   - 輸入驗證：system 名稱、scopes、webhookUrl
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
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

beforeEach(async () => {
    env = { KV_LINE_STORAGE: createMockKV() };
    await seedBot();
});

describe('POST /systems', () => {
    it('201，回傳 apiKey（sk_ 開頭），預設 scope 是 messages:push', async () => {
        const { res, body } = await create();
        assert.equal(res.status, 201);
        assert.equal(body.success, true);
        assert.match(body.apiKey, /^sk_[A-Za-z0-9_-]{43}$/);
        assert.equal(body.system, 'imgpicker');
        assert.deepEqual(body.scopes, ['messages:push']);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
    });

    it('KV 裡找不到 key 原文（只存雜湊）', async () => {
        const { body } = await create();
        for (const [k, v] of env.KV_LINE_STORAGE._store) {
            assert.ok(!k.includes(body.apiKey), `key 名稱含原文: ${k}`);
            assert.ok(!String(v).includes(body.apiKey), `值含原文: ${k}`);
        }
    });

    it('回傳的 key 可以通過 authenticateBridge', async () => {
        const { body } = await create();
        const auth = await authenticateBridge(bridgeReq(body.apiKey), env);
        assert.equal(auth.authenticated, true);
        assert.equal(auth.principal.botId, BOT);
        assert.equal(auth.principal.system, 'imgpicker');
    });

    it('指定的 scopes 會生效', async () => {
        const { res, body } = await create({ system: 's1', name: 'S', scopes: ['messages:push', 'members:read'] });
        assert.equal(res.status, 201);
        assert.deepEqual(body.scopes, ['messages:push', 'members:read']);
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
        assert.ok(!/keyHash|apiKey|revokedAt/.test(text));
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
        assert.deepEqual(auth.principal.scopes, ['messages:push']);
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
        assert.match(second.apiKey, /^sk_/);
        assert.notEqual(second.apiKey, first.apiKey);

        assert.equal((await authenticateBridge(bridgeReq(first.apiKey), env)).authenticated, false);
        assert.equal((await authenticateBridge(bridgeReq(second.apiKey), env)).authenticated, true);
    });

    it('輪替後 scopes 保持不變', async () => {
        await create({ system: 's1', name: 'S', scopes: ['messages:push', 'members:read'] });
        const second = await (await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 's1')).json();
        const auth = await authenticateBridge(bridgeReq(second.apiKey), env);
        assert.deepEqual(auth.principal.scopes, ['messages:push', 'members:read']);
    });

    it('不存在的 system → 404', async () => {
        const res = await handleRotateKey(req({}), env, OWNER, BOT, 'owner', 'ghost');
        assert.equal(res.status, 404);
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
