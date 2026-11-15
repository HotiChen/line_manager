/**
 * Unit Tests — middleware/bridge_auth.js（系統主體認證）
 *
 * 系統（垂直後端）用 `Authorization: Bearer <service key>` + `X-Bot-Id` 呼叫。
 * 安全性質：
 *   - 只存雜湊；查不到 / 已撤銷一律回同一個 401（不洩漏 key 是否存在）
 *   - X-Bot-Id 是「宣稱」，必須等於 key 記錄裡的 botId，不符 403
 *   - 系統被停用立即生效
 *   - scope 不足 403
 *   - 缺 KV binding 時 fail-closed（拒絕，不是放行）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { BotKeys, ServiceKeyKeys } from '../../worker_src/lib/kv_schema.js';
import { authenticateBridge, withService } from '../../worker_src/middleware/bridge_auth.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const SYSTEM = 'imgpicker';
const KEY = 'sk_test_key_value_000000000000000000000000';

let env;

async function seedKey({ botId = BOT, system = SYSTEM, scopes = ['messages:push'], revokedAt = null, key = KEY } = {}) {
    const hash = await sha256Hex(key);
    await env.KV_LINE_STORAGE.put(
        ServiceKeyKeys.byHash(hash),
        JSON.stringify({ botId, system, scopes, createdAt: 1, revokedAt })
    );
}

async function seedSystem({ botId = BOT, system = SYSTEM, disabled = false } = {}) {
    await env.KV_LINE_STORAGE.put(
        BotKeys.system(botId, system),
        JSON.stringify({ system, name: 'Image Picker', disabled })
    );
}

function req({ key = KEY, botId = BOT, auth } = {}) {
    const headers = {};
    if (auth !== undefined) headers.Authorization = auth;
    else if (key) headers.Authorization = `Bearer ${key}`;
    if (botId) headers['X-Bot-Id'] = botId;
    return new Request('https://example.com/api/v1/messages/push', { method: 'POST', headers });
}

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV() };
});

describe('authenticateBridge', () => {
    it('合法 key + 對的 botId → 通過，回傳主體', async () => {
        await seedKey();
        await seedSystem();
        const r = await authenticateBridge(req(), env);
        assert.equal(r.authenticated, true);
        assert.equal(r.principal.botId, BOT);
        assert.equal(r.principal.system, SYSTEM);
        assert.deepEqual(r.principal.scopes, ['messages:push']);
    });

    it('沒有 Authorization → 401', async () => {
        const r = await authenticateBridge(req({ key: null }), env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 401);
    });

    it('不是 Bearer → 401', async () => {
        const r = await authenticateBridge(req({ auth: `Basic ${KEY}` }), env);
        assert.equal(r.status, 401);
    });

    it('沒有 X-Bot-Id → 400', async () => {
        await seedKey();
        await seedSystem();
        const r = await authenticateBridge(req({ botId: null }), env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 400);
    });

    it('X-Bot-Id 含 ":" → 400（不拿去組 key）', async () => {
        await seedKey();
        const r = await authenticateBridge(req({ botId: 'bot:evil' }), env);
        assert.equal(r.status, 400);
    });

    it('不存在的 key → 401', async () => {
        const r = await authenticateBridge(req({ key: 'sk_nope' }), env);
        assert.equal(r.status, 401);
    });

    it('已撤銷的 key → 401，且訊息與「不存在」相同', async () => {
        await seedKey({ revokedAt: 123 });
        await seedSystem();
        const revoked = await authenticateBridge(req(), env);
        const missing = await authenticateBridge(req({ key: 'sk_nope' }), env);
        assert.equal(revoked.status, 401);
        assert.equal(revoked.error, missing.error);
    });

    it('X-Bot-Id 與 key 記錄的 botId 不符 → 403（橫向越權）', async () => {
        await seedKey({ botId: BOT });
        await seedSystem({ botId: BOT });
        const r = await authenticateBridge(req({ botId: OTHER_BOT }), env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 403);
    });

    it('系統被停用 → 403', async () => {
        await seedKey();
        await seedSystem({ disabled: true });
        const r = await authenticateBridge(req(), env);
        assert.equal(r.status, 403);
    });

    it('系統紀錄不存在（被刪除）→ 403，即使 key 還在', async () => {
        await seedKey();
        const r = await authenticateBridge(req(), env);
        assert.equal(r.status, 403);
    });

    it('缺 KV binding → fail-closed', async () => {
        const r = await authenticateBridge(req(), {});
        assert.equal(r.authenticated, false);
        assert.ok(r.status >= 500);
    });

    it('LIFF 用的 X-User-Id 對這條路徑完全無效', async () => {
        const request = new Request('https://example.com/api/v1/messages/push', {
            headers: { 'X-User-Id': 'Usomeone', 'X-Bot-Id': BOT },
        });
        const r = await authenticateBridge(request, env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 401);
    });
});

describe('withService', () => {
    it('scope 足夠 → 呼叫 handler，帶主體', async () => {
        await seedKey({ scopes: ['messages:push'] });
        await seedSystem();
        let seen;
        const h = withService(async (request, e, principal) => {
            seen = principal;
            return new Response('ok');
        }, 'messages:push');
        const res = await h(req(), env);
        assert.equal(res.status, 200);
        assert.equal(seen.system, SYSTEM);
    });

    it('scope 不足 → 403，handler 不會被呼叫', async () => {
        await seedKey({ scopes: ['members:read'] });
        await seedSystem();
        let called = false;
        const h = withService(async () => { called = true; return new Response('ok'); }, 'messages:push');
        const res = await h(req(), env);
        assert.equal(res.status, 403);
        assert.equal(called, false);
    });

    it('認證失敗 → 回認證的狀態碼，body 沒有 stack', async () => {
        const h = withService(async () => new Response('ok'), 'messages:push');
        const res = await h(req({ key: 'sk_nope' }), env);
        assert.equal(res.status, 401);
        const text = await res.text();
        assert.ok(!text.includes('stack'));
    });
});
