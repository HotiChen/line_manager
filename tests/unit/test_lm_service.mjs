/**
 * Unit Tests — lm_service.js（Bridge 使用 LM 內部的唯一窄介面）
 *
 *   getBotAccessToken(env, botId)              -> string | null（任何失敗都是 null，不丟錯）
 *   hasMember(env, botId, lineUserId)          -> boolean
 *   markMemberInactive(env, botId, lineUserId) -> void（盡力而為，不丟錯，保留其他欄位）
 *   authenticateUser(request, env)             -> {authenticated:true,userId} | {authenticated:false,status,error}
 *   withPermission                             -> middleware/permission.js 的 re-export
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { withPermission as realWithPermission } from '../../worker_src/middleware/permission.js';
import {
    getBotAccessToken,
    hasMember,
    markMemberInactive,
    authenticateUser,
    withPermission,
} from '../../worker_src/lm_service.js';
import * as lmService from '../../worker_src/lm_service.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';
const originalFetch = globalThis.fetch;
let env;

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV(), LIFF_CHANNEL_ID: '1234567890' };
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('介面形狀', () => {
    it('只匯出約定的五個名字', () => {
        assert.deepEqual(
            Object.keys(lmService).sort(),
            ['authenticateUser', 'getBotAccessToken', 'hasMember', 'markMemberInactive', 'withPermission']
        );
    });

    it('withPermission 就是 middleware/permission.js 的那個', () => {
        assert.equal(withPermission, realWithPermission);
    });
});

describe('getBotAccessToken', () => {
    it('取得 bot 的 token', async () => {
        const kv = env.KV_LINE_STORAGE;
        await kv.put(BotKeys.owner(BOT), OWNER);
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: 'TOKEN_X', destination: BOT } }));
        assert.equal(await getBotAccessToken(env, BOT), 'TOKEN_X');
    });

    it('沒有 owner → null', async () => {
        assert.equal(await getBotAccessToken(env, BOT), null);
    });

    it('有 owner 但沒有對應的 token → null', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.owner(BOT), OWNER);
        assert.equal(await getBotAccessToken(env, BOT), null);
    });

    it('解密失敗（密文但沒有金鑰）→ null，不丟錯', async () => {
        const kv = env.KV_LINE_STORAGE;
        await kv.put(BotKeys.owner(BOT), OWNER);
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: 'enc.v1.AAAA.BBBB', destination: BOT } }));
        const orig = console.error;
        console.error = () => {};
        try {
            assert.equal(await getBotAccessToken(env, BOT), null);
        } finally {
            console.error = orig;
        }
    });

    it('KV 本身壞掉 → null，不丟錯', async () => {
        const broken = { KV_LINE_STORAGE: { get: async () => { throw new Error('kv down'); } } };
        const orig = console.error;
        console.error = () => {};
        try {
            assert.equal(await getBotAccessToken(broken, BOT), null);
        } finally {
            console.error = orig;
        }
    });

    it('沒有 KV binding → null', async () => {
        assert.equal(await getBotAccessToken({}, BOT), null);
    });
});

describe('hasMember', () => {
    it('會員存在 → true；不存在 → false', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.owner(BOT), OWNER);
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER, name: 'Amy' }));
        assert.equal(await hasMember(env, BOT, MEMBER), true);
        assert.equal(await hasMember(env, BOT, 'Unobody0000000000000000000000009'), false);
    });

    it('其他 bot 的會員看不到', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER }));
        assert.equal(await hasMember(env, 'Uotherbot000000000000000000000001', MEMBER), false);
    });
});

describe('markMemberInactive', () => {
    it('寫入 inactiveAt，保留其他欄位', async () => {
        const kv = env.KV_LINE_STORAGE;
        await kv.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER, name: 'Amy', tier: 'gold' }));
        const before = Date.now();
        await markMemberInactive(env, BOT, MEMBER);
        const m = JSON.parse(await kv.get(BotKeys.member(BOT, MEMBER)));
        assert.equal(m.name, 'Amy');
        assert.equal(m.tier, 'gold');
        assert.equal(m.userId, MEMBER);
        assert.ok(m.inactiveAt >= before);
    });

    it('會員不存在 → 什麼都不寫', async () => {
        await markMemberInactive(env, BOT, MEMBER);
        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.member(BOT, MEMBER)), null);
    });

    it('KV 寫入失敗 → 不丟錯（盡力而為）', async () => {
        const kv = env.KV_LINE_STORAGE;
        await kv.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER }));
        kv.put = async () => { throw new Error('kv put down'); };
        const orig = console.error;
        console.error = () => {};
        try {
            await assert.doesNotReject(() => markMemberInactive(env, BOT, MEMBER));
        } finally {
            console.error = orig;
        }
    });
});

describe('authenticateUser', () => {
    function mockLiff(userId = 'Uverified123') {
        globalThis.fetch = async (url) => {
            const u = String(url);
            if (u.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ client_id: '1234567890', expires_in: 3600 }), { status: 200 });
            }
            if (u.includes('/v2/profile')) return new Response(JSON.stringify({ userId }), { status: 200 });
            return new Response('{}', { status: 404 });
        };
    }
    const req = (headers = {}) => new Request('https://x.example.com/bridge/v1/systems', { headers });

    it('合法 LIFF token → {authenticated:true,userId}', async () => {
        mockLiff('Ualice');
        assert.deepEqual(await authenticateUser(req({ Authorization: 'Bearer good' }), env), { authenticated: true, userId: 'Ualice' });
    });

    it('沒有任何認證 → 401 + error', async () => {
        const r = await authenticateUser(req(), env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 401);
        assert.equal(typeof r.error, 'string');
    });

    it('壞 token → 401', async () => {
        globalThis.fetch = async () => new Response('{}', { status: 400 });
        const r = await authenticateUser(req({ Authorization: 'Bearer bad' }), env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 401);
    });

    it('通過認證但超過人類 rate limit → 429（含 retryAfter）', async () => {
        mockLiff('Ualice');
        let last;
        for (let i = 0; i < 101; i++) last = await authenticateUser(req({ Authorization: 'Bearer good' }), env);
        assert.equal(last.authenticated, false);
        assert.equal(last.status, 429);
        assert.equal(typeof last.error, 'string');
        assert.ok(last.retryAfter >= 1);
    });

    it('authenticated:false 的結果不帶 userId', async () => {
        const r = await authenticateUser(req(), env);
        assert.equal('userId' in r, false);
    });
});
