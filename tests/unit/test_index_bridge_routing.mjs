/**
 * Integration Tests — index.js 對 /api/v1/* 的分派（安全邊界）
 *
 * index.js 依賴 Workers 的 `__STATIC_CONTENT_MANIFEST`，Node 解析不到，
 * 所以用 module hook 把它換成空 manifest，再直接呼叫 worker.fetch。
 *
 * 要釘住的事：
 *   - 系統路由（/api/v1/messages/*）走 service key 認證，不是 LIFF
 *   - /api/v1/systems*（發 key）只接受人主體：service key 打不進去（key 不能發 key）
 *   - 既有的 /api/send-message 仍然要 LIFF，沒被新路由影響
 *   - 前綴相似的路徑不會誤入
 */
import { describe, it, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { BotKeys, ServiceKeyKeys } from '../../worker_src/lib/kv_schema.js';

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
let env;
let lineCalls;

before(async () => {
    worker = (await import('../../worker_src/index.js')).default;
});

beforeEach(async () => {
    env = {
        KV_LINE_STORAGE: createMockKV(),
        __STATIC_CONTENT: {},
        LIFF_CHANNEL_ID: '1234567890',
        LIFF_ID: '1234567890-abcd',
    };
    const kv = env.KV_LINE_STORAGE;
    await kv.put(ServiceKeyKeys.byHash(await sha256Hex(KEY)), JSON.stringify({ botId: BOT, system: 'imgpicker', scopes: ['messages:push'], createdAt: 1, revokedAt: null }));
    await kv.put(BotKeys.system(BOT, 'imgpicker'), JSON.stringify({ system: 'imgpicker', name: 'IP', disabled: false }));

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

describe('系統路由 /api/v1/messages/*', () => {
    it('壞 key → 401 且是橋接認證的訊息（證明沒走 LIFF）', async () => {
        const res = await call('POST', '/api/v1/messages/push', { Authorization: 'Bearer sk_wrong', 'X-Bot-Id': BOT }, { to: 'U1', messages: [] });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error, 'Invalid or revoked service key');
        assert.equal(lineCalls.length, 0, '不應該拿 service key 去問 LINE 的 LIFF 驗證');
    });

    it('合法 key 通過認證後才進 handler（這裡因 body 無效而 400，不是 401）', async () => {
        const res = await call('POST', '/api/v1/messages/push', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, { to: 'U1', messages: [] });
        assert.equal(res.status, 400);
    });

    it('不帶任何認證 → 401', async () => {
        const res = await call('POST', '/api/v1/messages/push', {}, {});
        assert.equal(res.status, 401);
    });

    it('legacy 的 X-User-Id 在這條路徑完全無效', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await call('POST', '/api/v1/messages/push', { 'X-User-Id': 'Usomeone', 'X-Bot-Id': BOT }, {});
        assert.equal(res.status, 401);
    });

    it('未知的 /api/v1/ 路徑 → 404', async () => {
        const res = await call('POST', '/api/v1/unknown', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, {});
        assert.equal(res.status, 404);
    });
});

describe('系統註冊 /api/v1/systems* 只接受人主體（key 不能發 key）', () => {
    for (const [method, path] of [
        ['POST', '/api/v1/systems'],
        ['GET', '/api/v1/systems'],
        ['PATCH', '/api/v1/systems/imgpicker'],
        ['DELETE', '/api/v1/systems/imgpicker'],
        ['POST', '/api/v1/systems/imgpicker/keys/rotate'],
    ]) {
        it(`service key 打 ${method} ${path} → 401`, async () => {
            const before = env.KV_LINE_STORAGE._store.size;
            const res = await call(method, path, { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT }, method === 'POST' || method === 'PATCH' ? { system: 'evil', name: 'x' } : undefined);
            assert.equal(res.status, 401);
            assert.equal(env.KV_LINE_STORAGE._store.size, before, '不可寫入任何東西');
        });
    }

    it('完全沒有認證 → 401', async () => {
        const res = await call('POST', '/api/v1/systems', {}, { system: 'evil', name: 'x' });
        assert.equal(res.status, 401);
    });

    it('legacy 模式的 X-User-Id 可以通過人主體認證，但還是要有 owner 權限 → 403', async () => {
        env.AUTH_MODE = 'legacy';
        const res = await call('POST', '/api/v1/systems', { 'X-User-Id': 'Unobody', 'X-Bot-Id': BOT }, { system: 'evil', name: 'x' });
        assert.equal(res.status, 403);
    });
});

describe('前綴相似的路徑', () => {
    it('/api/v1systems 不是橋接路由，仍落在既有的 LIFF 認證 → 401', async () => {
        const res = await call('GET', '/api/v1systems', {}, undefined);
        assert.equal(res.status, 401);
    });

    it('/api/v1/systemsX 會被當成系統路由，沒有這個端點 → 404', async () => {
        const res = await call('GET', '/api/v1/systemsX', { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT });
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
