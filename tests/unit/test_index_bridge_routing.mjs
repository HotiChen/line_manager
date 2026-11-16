/**
 * Integration Tests — index.js 對 /bridge/v1/* 的分派（安全邊界）
 *
 * index.js 依賴 Workers 的 `__STATIC_CONTENT_MANIFEST`，Node 解析不到，
 * 所以用 module hook 把它換成空 manifest，再直接呼叫 worker.fetch。
 *
 * 要釘住的事：
 *   - 系統路由（/bridge/v1/raw/*）走 service key 認證，不是 LIFF
 *   - /bridge/v1/systems*（發 key）只接受人主體：service key 打不進去（key 不能發 key）
 *   - 既有的 /api/send-message 仍然要 LIFF，沒被新路由影響
 *   - 前綴相似的路徑不會誤入
 */
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedKey, seedSystem, count } from '../helpers/bridge_seed.mjs';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === '__STATIC_CONTENT_MANIFEST') {
    return { url: 'data:text/javascript,export default "{}"', shortCircuit: true };
  }
  return next(specifier, context);
}`));

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const KEY = 'sk_test_key_value_000000000000000000000000';
const originalFetch = globalThis.fetch;

let worker;
let d1;
let env;
let lineCalls;

before(async () => {
    worker = (await import('../../worker_src/index.js')).default;
    d1 = await createTestD1();
});
after(async () => { await d1.dispose(); });

beforeEach(async () => {
    await d1.reset();
    env = {
        KV_LINE_STORAGE: createMockKV(),
        BRIDGE_DB: d1.db,
        __STATIC_CONTENT: {},
        LIFF_CHANNEL_ID: '1234567890',
        LIFF_ID: '1234567890-abcd',
        BRIDGE_ENABLED: '1',
    };
    await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', name: 'IP' });
    await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: KEY });

    lineCalls = [];
    globalThis.fetch = async (url) => {
        lineCalls.push(String(url));
        // LIFF token 驗證一律失敗：sk_ 開頭的 key 不是 LIFF token
        return new Response('{"error":"invalid_request"}', { status: 400 });
    };
});
afterEach(() => { globalThis.fetch = originalFetch; });

const call = (method, path, headers = {}, body) =>
    worker.fetch(
        new Request(`https://example.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
        env,
        { waitUntil() {} }
    );

describe('系統路由 /bridge/v1/raw/*', () => {
    it('壞 key → 401 且是橋接認證的訊息（證明沒走 LIFF）', async () => {
        const res = await call('POST', '/bridge/v1/raw/push', { Authorization: 'Bearer sk_wrong', 'X-Bot-Id': BOT }, { to: 'U1', messages: [] });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error, 'Invalid or revoked service key');
        assert.equal(lineCalls.length, 0, '不應該拿 service key 去問 LINE 的 LIFF 驗證');
    });

    it('合法 key 通過認證後才進 handler（這裡因 body 無效而 400，不是 401）', async () => {
        const res = await call('POST', '/bridge/v1/raw/push', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, { to: 'U1', messages: [] });
        assert.equal(res.status, 400);
    });

    it('不帶任何認證 → 401', async () => {
        const res = await call('POST', '/bridge/v1/raw/push', {}, {});
        assert.equal(res.status, 401);
    });

    it('legacy 的 X-User-Id 在這條路徑完全無效', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await call('POST', '/bridge/v1/raw/push', { 'X-User-Id': 'Usomeone', 'X-Bot-Id': BOT }, {});
        assert.equal(res.status, 401);
    });

    it('未知的 /bridge/v1/ 路徑 → 404', async () => {
        const res = await call('POST', '/bridge/v1/unknown', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, {});
        assert.equal(res.status, 404);
    });
});

describe('系統註冊 /bridge/v1/systems* 只接受人主體（key 不能發 key）', () => {
    for (const [method, path] of [
        ['POST', '/bridge/v1/systems'],
        ['GET', '/bridge/v1/systems'],
        ['PATCH', '/bridge/v1/systems/imgpicker'],
        ['DELETE', '/bridge/v1/systems/imgpicker'],
        ['POST', '/bridge/v1/systems/imgpicker/keys/rotate'],
    ]) {
        it(`service key 打 ${method} ${path} → 401`, async () => {
            const before = env.KV_LINE_STORAGE._store.size;
            const rowsBefore = [await count(d1.db, 'systems'), await count(d1.db, 'service_keys'), await count(d1.db, 'audit_log')];
            const res = await call(method, path, { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, method === 'POST' || method === 'PATCH' ? { system: 'evil', name: 'x' } : undefined);
            assert.equal(res.status, 401);
            assert.equal(env.KV_LINE_STORAGE._store.size, before, '不可寫入任何東西');
            assert.deepEqual([await count(d1.db, 'systems'), await count(d1.db, 'service_keys'), await count(d1.db, 'audit_log')], rowsBefore, 'D1 也不可寫入任何東西');
        });
    }

    it('完全沒有認證 → 401', async () => {
        const res = await call('POST', '/bridge/v1/systems', {}, { system: 'evil', name: 'x' });
        assert.equal(res.status, 401);
    });

    it('legacy 模式的 X-User-Id 可以通過人主體認證，但還是要有 owner 權限 → 403', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await call('POST', '/bridge/v1/systems', { 'X-User-Id': 'Unobody', 'X-Bot-Id': BOT }, { system: 'evil', name: 'x' });
        assert.equal(res.status, 403);
        assert.equal(await count(d1.db, 'systems'), 1, '只有種子那一筆');
    });
});

describe('前綴相似的路徑', () => {
    it('/api/v1systems 不是橋接路由，仍落在既有的 LIFF 認證 → 401', async () => {
        const res = await call('GET', '/api/v1systems', {}, undefined);
        assert.equal(res.status, 401);
    });

    it('/bridge/v1/systemsX 不是 systems 路由，沒有這個端點 → 404', async () => {
        const res = await call('GET', '/bridge/v1/systemsX', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT });
        assert.equal(res.status, 404);
    });
});

describe('既有路由不受影響', () => {
    it('/api/send-message 仍要 LIFF：沒認證 → 401', async () => {
        const res = await call('POST', '/api/send-message', {}, { to: 'U1', messages: [] });
        assert.equal(res.status, 401);
    });

    it('/api/send-message 拿 service key 也不行（LIFF 驗證失敗）', async () => {
        const res = await call('POST', '/api/send-message', { Authorization: `Bearer ${KEY}` }, { to: 'U1', messages: [] });
        assert.equal(res.status, 401);
    });

    it('/api/webhook 仍公開（簽章驗證由 handler 負責，沒有 secret 時 fail-closed 500）', async () => {
        const res = await call('POST', '/api/webhook', {}, { events: [] });
        assert.notEqual(res.status, 404);
        assert.notEqual(res.status, 200);
    });
});

describe('舊路徑 /api/v1/* 已移除（沒有 alias）', () => {
    it('已認證的人打舊的 push 路徑 → 404（落到 /api 的 fallback，不是 bridge）', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await call('POST', '/api/v1/messages/push', { 'X-User-Id': 'Usomeone' }, { to: 'U1', messages: [] });
        assert.equal(res.status, 404);
    });

    for (const [method, path] of [
        ['POST', '/api/v1/messages/push'],
        ['POST', '/api/v1/messages/multicast'],
        ['GET', '/api/v1/systems'],
        ['POST', '/api/v1/systems'],
        ['POST', '/api/v1/systems/imgpicker/keys/rotate'],
    ]) {
        it(`service key 打舊的 ${method} ${path} → 不通（401，被 LIFF 認證擋下）`, async () => {
            const res = await call(method, path, { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, method === 'GET' ? undefined : {});
            assert.equal(res.status, 401);
            assert.equal(lineCalls.filter((u) => u.includes('/v2/bot/message')).length, 0);
        });
    }

    it('legacy 身分打舊的 systems 路徑 → 404，而且沒有建立任何東西', async () => {
        env.AUTH_MODE = 'legacy';
        const keysBefore = [...env.KV_LINE_STORAGE._store.keys()].filter((k) => !k.startsWith('rl_'));
        const systemsBefore = await count(d1.db, 'systems');
        const res = await call('POST', '/api/v1/systems', { 'X-User-Id': 'Unobody', 'X-Bot-Id': BOT }, { system: 'evil', name: 'x' });
        assert.equal(res.status, 404);
        const keysAfter = [...env.KV_LINE_STORAGE._store.keys()].filter((k) => !k.startsWith('rl_'));
        assert.deepEqual(keysAfter, keysBefore, '除了 rate limit 計數，不可寫入任何東西');
        assert.equal(await count(d1.db, 'systems'), systemsBefore);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });
});

describe('/bridge/* 不會被當成靜態資源（isApiRequest）', () => {
    it('/bridge/v1/health 回 JSON，不是 index.html', async () => {
        const res = await call('GET', '/bridge/v1/health');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /json/);
        assert.deepEqual(await res.json(), { ok: true });
    });

    it('/bridge/anything 是 JSON 404，不是 SPA fallback', async () => {
        const res = await call('GET', '/bridge/whatever');
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { success: false, error: 'Not Found' });
    });

    it('flag 關閉時 /bridge/v1/health 也是 JSON 404（不是 index.html）', async () => {
        env.BRIDGE_ENABLED = undefined;
        const res = await call('GET', '/bridge/v1/health');
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { success: false, error: 'Not Found' });
    });

    it('沒有 BRIDGE_DB → health 是 503 bridge_not_configured（LM 的 /debug-ping 不受影響）', async () => {
        const noDb = { ...env, BRIDGE_DB: undefined };
        const res = await worker.fetch(new Request('https://example.com/bridge/v1/health'), noDb, { waitUntil() {} });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { success: false, error: 'bridge_not_configured' });
        const ping = await worker.fetch(new Request('https://example.com/debug-ping'), noDb, { waitUntil() {} });
        assert.equal(ping.status, 200);
    });

    it('掛載前綴（MOUNT_PATH）下一樣可用', async () => {
        env.MOUNT_PATH = '/lm';
        const res = await call('GET', '/lm/bridge/v1/health');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    });
});

describe('flag 關閉時整個 Bridge 不存在', () => {
    beforeEach(() => { env.BRIDGE_ENABLED = undefined; });

    it('每條 /bridge/* 都是 404，且不碰 KV、不碰 D1、不打 LINE', async () => {
        const kv = env.KV_LINE_STORAGE;
        const dbCalls = [];
        env.BRIDGE_DB = { prepare: () => { dbCalls.push('prepare'); throw new Error('must not touch D1'); }, batch: () => { dbCalls.push('batch'); } };
        kv._resetOps();
        lineCalls.length = 0;
        for (const [method, path] of [
            ['POST', '/bridge/v1/raw/push'],
            ['POST', '/bridge/v1/raw/multicast'],
            ['GET', '/bridge/v1/systems'],
            ['POST', '/bridge/v1/systems'],
            ['GET', '/bridge/v1/health'],
        ]) {
            const res = await call(method, path, { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, method === 'GET' ? undefined : {});
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.deepEqual(await res.json(), { success: false, error: 'Not Found' });
        }
        assert.equal(kv._ops.total, 0);
        assert.deepEqual(dbCalls, []);
        assert.equal(lineCalls.length, 0);
    });
});

describe('例外隔離：Bridge 丟錯不影響 LM core', () => {
    it('Bridge 內部丟錯 → 500 internal_error（無 stack），同一個 worker 的 /debug-ping 仍然 200', async () => {
        const origError = console.error;
        console.error = () => {};
        try {
            const bad = {
                BRIDGE_ENABLED: '1',
                __STATIC_CONTENT: {},
                get BRIDGE_DB() { throw new Error('kv exploded'); },
            };
            const res = await worker.fetch(
                new Request('https://example.com/bridge/v1/raw/push', { method: 'POST', headers: { Authorization: 'Bearer x', 'X-Bot-Id': BOT }, body: '{}' }),
                bad,
                { waitUntil() {} }
            );
            assert.equal(res.status, 500);
            const text = await res.text();
            assert.deepEqual(JSON.parse(text), { success: false, error: 'internal_error' });
            assert.doesNotMatch(text, /exploded|\.js:/);

            const ping = await worker.fetch(new Request('https://example.com/debug-ping'), bad, { waitUntil() {} });
            assert.equal(ping.status, 200);
            assert.equal((await ping.json()).success, true);
        } finally {
            console.error = origError;
        }
    });
});

describe('GET /features（前端功能探測）', () => {
    const features = (headers = {}) => call('GET', '/features', headers);

    it('沒有認證 → 401', async () => {
        const res = await features();
        assert.equal(res.status, 401);
    });

    it('service key 不是 LIFF token → 401', async () => {
        const res = await features({ Authorization: `Bearer ${KEY}` });
        assert.equal(res.status, 401);
    });

    it('已認證 + BRIDGE_ENABLED="1" → {bridge:true}', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await features({ 'X-User-Id': 'Usomeone' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { bridge: true });
    });

    for (const v of [undefined, '0', '', 'true']) {
        it(`已認證 + BRIDGE_ENABLED=${JSON.stringify(v)} → {bridge:false}`, async () => {
            env.AUTH_MODE = 'legacy';
            env.BRIDGE_ENABLED = v;
            const res = await features({ 'X-User-Id': 'Usomeone' });
            assert.equal(res.status, 200);
            assert.deepEqual(await res.json(), { bridge: false });
        });
    }

    it('不是靜態資源（回 JSON）', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await features({ 'X-User-Id': 'Usomeone' });
        assert.match(res.headers.get('content-type') || '', /json/);
    });
});
