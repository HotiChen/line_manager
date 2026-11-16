/**
 * Unit Tests — bridge/index.js（feature flag、health、例外隔離）
 *
 *   BRIDGE_ENABLED 只有字串 "1" 才開；其他（"true"、"0"、""、undefined、1）一律關。
 *   關閉時整個 /bridge/* 與不存在的路由一樣 404，不認證、不碰 KV。
 *   開啟時任何丟出的例外都變成 500 internal_error（不含 stack），不往外拋。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { isBridgePath, isBridgeEnabled, handleBridge } from '../../worker_src/bridge/index.js';

const NOT_FOUND = { success: false, error: 'Not Found' };
let env;
let kv;

beforeEach(() => {
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_ENABLED: '1' };
});

const call = (method, path, headers = {}, e = env) =>
    handleBridge(new Request(`https://worker.example.com${path}`, { method, headers }), e, path);

describe('isBridgePath', () => {
    it('只認 /bridge 與 /bridge/ 底下', () => {
        assert.equal(isBridgePath('/bridge'), true);
        assert.equal(isBridgePath('/bridge/'), true);
        assert.equal(isBridgePath('/bridge/v1/health'), true);
        assert.equal(isBridgePath('/bridgeX'), false);
        assert.equal(isBridgePath('/api/v1/systems'), false);
        assert.equal(isBridgePath('/'), false);
        assert.equal(isBridgePath(undefined), false);
    });
});

describe('isBridgeEnabled', () => {
    it('只有字串 "1" 是開', () => {
        assert.equal(isBridgeEnabled({ BRIDGE_ENABLED: '1' }), true);
        for (const v of ['true', 'TRUE', '0', '', ' 1', '1 ', 'yes', 1, true, null, undefined]) {
            assert.equal(isBridgeEnabled({ BRIDGE_ENABLED: v }), false, JSON.stringify(v));
        }
        assert.equal(isBridgeEnabled({}), false);
        assert.equal(isBridgeEnabled(undefined), false);
    });
});

describe('flag 關閉', () => {
    for (const v of [undefined, 'true', '0', '', 'yes', ' 1']) {
        it(`BRIDGE_ENABLED=${JSON.stringify(v)} → 每個 /bridge/* 都是 404，shape 與未知路由相同`, async () => {
            const e = { KV_LINE_STORAGE: kv, BRIDGE_ENABLED: v };
            for (const [m, p] of [
                ['GET', '/bridge/v1/health'],
                ['POST', '/bridge/v1/raw/push'],
                ['POST', '/bridge/v1/raw/multicast'],
                ['GET', '/bridge/v1/systems'],
                ['POST', '/bridge/v1/systems'],
                ['DELETE', '/bridge/v1/systems/imgpicker'],
                ['GET', '/bridge/nothing'],
            ]) {
                const res = await call(m, p, { Authorization: 'Bearer sk_whatever', 'X-Bot-Id': 'Ubot' }, e);
                assert.equal(res.status, 404, `${m} ${p}`);
                assert.deepEqual(await res.json(), NOT_FOUND);
            }
            assert.equal(kv._ops.total, 0, '關閉時不可碰 KV');
        });
    }

    it('關閉時不做認證：沒有 KV binding 的 env 也不會出事', async () => {
        const res = await call('GET', '/bridge/v1/systems', {}, {});
        assert.equal(res.status, 404);
    });

    it('關閉時不會對 fetch 發任何請求（沒有 LIFF 驗證）', async () => {
        const orig = globalThis.fetch;
        let fetched = 0;
        globalThis.fetch = async () => { fetched++; return new Response('{}'); };
        try {
            await call('GET', '/bridge/v1/systems', { Authorization: 'Bearer abc' }, {});
            assert.equal(fetched, 0);
        } finally {
            globalThis.fetch = orig;
        }
    });
});

describe('flag 開啟', () => {
    it('GET /bridge/v1/health → 200 {ok:true}，免認證、不碰 KV', async () => {
        const res = await call('GET', '/bridge/v1/health');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
        assert.equal(kv._ops.total, 0);
    });

    it('health 只收 GET', async () => {
        const res = await call('POST', '/bridge/v1/health');
        assert.equal(res.status, 405);
    });

    it('/bridge 底下沒有的路徑 → 404 {success:false,error:"Not Found"}', async () => {
        for (const p of ['/bridge', '/bridge/', '/bridge/v1', '/bridge/v2/health', '/bridge/v1/raw', '/bridge/v1/raw/other', '/bridge/v1/messages/push', '/bridge/v1/healthz', '/bridge/v1/systemsX']) {
            const res = await call('POST', p, { Authorization: 'Bearer x', 'X-Bot-Id': 'Ubot' });
            assert.equal(res.status, 404, p);
            assert.deepEqual(await res.json(), NOT_FOUND);
        }
    });

    it('raw/push 走 service key 認證（沒帶 → 401）', async () => {
        const res = await call('POST', '/bridge/v1/raw/push');
        assert.equal(res.status, 401);
    });

    it('/bridge/v1/systems 走人主體認證（沒帶 → 401）', async () => {
        const res = await call('GET', '/bridge/v1/systems');
        assert.equal(res.status, 401);
    });
});

describe('例外隔離', () => {
    const originalError = console.error;
    let logged;
    beforeEach(() => {
        logged = [];
        console.error = (...a) => logged.push(a.map(String).join(' '));
    });
    afterEach(() => { console.error = originalError; });

    it('內部丟錯 → 500 {success:false,error:"internal_error"}，不含 stack，不往外拋', async () => {
        const bad = {
            get BRIDGE_ENABLED() { return '1'; },
            get KV_LINE_STORAGE() { throw new Error('kv exploded SECRET_DETAIL'); },
        };
        const res = await call('POST', '/bridge/v1/raw/push', { Authorization: 'Bearer x', 'X-Bot-Id': 'U1' }, bad);
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { success: false, error: 'internal_error' });
        assert.doesNotMatch(text, /exploded|SECRET_DETAIL|at |\.js:/);
    });

    it('log 只記 message，不記 stack', async () => {
        const bad = { BRIDGE_ENABLED: '1', get KV_LINE_STORAGE() { throw new Error('kv exploded'); } };
        await call('POST', '/bridge/v1/raw/push', { Authorization: 'Bearer x', 'X-Bot-Id': 'U1' }, bad);
        const joined = logged.join('\n');
        assert.match(joined, /kv exploded/);
        assert.doesNotMatch(joined, /\n\s+at /);
        assert.doesNotMatch(joined, /\.js:\d+/);
    });

    it('request 物件本身壞掉（method getter 丟錯）也不會往外拋', async () => {
        const evilRequest = { get method() { throw new Error('boom'); }, headers: new Headers() };
        const res = await handleBridge(evilRequest, env, '/bridge/v1/raw/push');
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { success: false, error: 'internal_error' });
    });
});
