/**
 * Unit Tests — bridge/auth.js（系統主體認證）
 *
 * 系統（垂直後端）用 `Authorization: Bearer <service key>` + `X-Bot-Id` 呼叫。
 * 安全性質：
 *   - 只存雜湊；查不到 / 已撤銷一律回同一個 401（不洩漏 key 是否存在）
 *   - X-Bot-Id 是「宣稱」，必須等於 key 記錄裡的 botId，不符 403
 *   - 系統被停用立即生效
 *   - scope 不足 403
 *   - 缺 BRIDGE_DB binding 或查詢失敗時 fail-closed（503 bridge_not_configured，不是放行，也不退回 KV）
 *
 * 資料在 D1（Miniflare 的真資料庫）；這裡的種子資料直接寫 SQL。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedKey as seedKeyRow, seedSystem as seedSystemRow } from '../helpers/bridge_seed.mjs';
import { authenticateBridge, withService } from '../../worker_src/bridge/auth.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const SYSTEM = 'imgpicker';
const KEY = 'sk_test_key_value_000000000000000000000000';

let d1;
let env;

async function seedKey({ botId = BOT, system = SYSTEM, scopes = ['messages:push'], revokedAt = null, key = KEY } = {}) {
    await seedKeyRow(d1.db, { botId, system, scopes, revokedAt, key });
}

async function seedSystem({ botId = BOT, system = SYSTEM, disabled = false } = {}) {
    await seedSystemRow(d1.db, { botId, system, disabled });
}

function req({ key = KEY, botId = BOT, auth } = {}) {
    const headers = {};
    if (auth !== undefined) headers.Authorization = auth;
    else if (key) headers.Authorization = `Bearer ${key}`;
    if (botId) headers['X-Bot-Id'] = botId;
    return new Request('https://example.com/bridge/v1/raw/push', { method: 'POST', headers });
}

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { BRIDGE_DB: d1.db };
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

    it('缺 BRIDGE_DB binding → fail-closed（503 bridge_not_configured）', async () => {
        const r = await authenticateBridge(req(), {});
        assert.equal(r.authenticated, false);
        assert.ok(r.status >= 500);
        assert.equal(r.status, 503);
        assert.equal(r.error, 'bridge_not_configured');
    });

    it('沒有 BRIDGE_DB 時不會退回 KV：KV 裡有合法的舊格式紀錄也一樣拒絕', async () => {
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        const kv = createMockKV();
        await kv.put(`service_key:${await sha256Hex(KEY)}`, JSON.stringify({ botId: BOT, system: SYSTEM, scopes: ['messages:push'], revokedAt: null }));
        await kv.put(`bot:${BOT}:system:${SYSTEM}`, JSON.stringify({ system: SYSTEM, disabled: false }));
        const r = await authenticateBridge(req(), { KV_LINE_STORAGE: kv });
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 503);
    });

    describe('查詢失敗 → 503 bridge_not_configured（不是 401/403，也不放行）', () => {
        const originalError = console.error;
        beforeEach(() => { console.error = () => {}; });
        afterEach(() => { console.error = originalError; });

        it('資料庫查詢丟錯', async () => {
            await seedKey();
            await seedSystem();
            const broken = { BRIDGE_DB: { prepare() { throw new Error('d1 exploded SECRET'); } } };
            const r = await authenticateBridge(req(), broken);
            assert.equal(r.authenticated, false);
            assert.equal(r.status, 503);
            assert.equal(r.error, 'bridge_not_configured');
        });

        it('缺表（遷移沒套用）', async () => {
            await seedKey();
            await seedSystem();
            await d1.db.prepare('ALTER TABLE service_keys RENAME TO service_keys_x').run();
            try {
                const r = await authenticateBridge(req(), env);
                assert.equal(r.status, 503);
                assert.equal(r.error, 'bridge_not_configured');
            } finally {
                await d1.db.prepare('ALTER TABLE service_keys_x RENAME TO service_keys').run();
            }
        });
    });

    it('key 在但系統被刪（key 已撤銷）→ 401；兩種「無效」訊息一致', async () => {
        await seedKey({ revokedAt: 5 });
        const r = await authenticateBridge(req(), env);
        assert.equal(r.status, 401);
    });

    it('scopes 取自 key 那一列，不是系統那一列', async () => {
        await seedKey({ scopes: ['members:read'] });
        await seedSystemRow(d1.db, { botId: BOT, system: SYSTEM, scopes: ['messages:push', 'members:read', 'tags:write'] });
        const r = await authenticateBridge(req(), env);
        assert.deepEqual(r.principal.scopes, ['members:read']);
    });

    it('系統的 rate_limit 會帶進主體', async () => {
        await seedKey();
        await seedSystemRow(d1.db, { botId: BOT, system: SYSTEM, rateLimit: { write: 7 } });
        const r = await authenticateBridge(req(), env);
        assert.deepEqual(r.principal.rateLimit, { write: 7 });
    });

    it('LIFF 用的 X-User-Id 對這條路徑完全無效', async () => {
        const request = new Request('https://example.com/bridge/v1/raw/push', {
            headers: { 'X-User-Id': 'Usomeone', 'X-Bot-Id': BOT },
        });
        const r = await authenticateBridge(request, env);
        assert.equal(r.authenticated, false);
        assert.equal(r.status, 401);
    });
});

describe('金鑰格式與 scope 相容（LM-1C）', () => {
    const BRK = 'brk_ab12cd_' + 'A'.repeat(43);

    it('brk_ 格式的金鑰可通過認證（只比對雜湊）', async () => {
        await seedKey({ key: BRK, scopes: ['raw:push'] });
        await seedSystem();
        const r = await authenticateBridge(req({ key: BRK }), env);
        assert.equal(r.authenticated, true);
        assert.deepEqual(r.principal.scopes, ['raw:push']);
    });

    it('舊 sk_ 格式的金鑰仍可通過認證', async () => {
        await seedKey({ key: 'sk_legacy_' + 'B'.repeat(43), scopes: ['messages:push'] });
        await seedSystem();
        const r = await authenticateBridge(req({ key: 'sk_legacy_' + 'B'.repeat(43) }), env);
        assert.equal(r.authenticated, true);
    });

    it('withService(raw:push)：金鑰有 raw:push → 通過', async () => {
        await seedKey({ key: BRK, scopes: ['raw:push'] });
        await seedSystem();
        const res = await withService(async () => new Response('ok'), 'raw:push')(req({ key: BRK }), env);
        assert.equal(res.status, 200);
    });

    it('withService(raw:push)：舊金鑰只有 messages:push → 等同 raw:push，通過', async () => {
        await seedKey({ scopes: ['messages:push'] });
        await seedSystem();
        const res = await withService(async () => new Response('ok'), 'raw:push')(req(), env);
        assert.equal(res.status, 200);
    });

    it('withService(raw:push)：只有 members:read / tags:write → 403', async () => {
        await seedKey({ scopes: ['members:read', 'tags:write'] });
        await seedSystem();
        let called = false;
        const res = await withService(async () => { called = true; return new Response('ok'); }, 'raw:push')(req(), env);
        assert.equal(res.status, 403);
        assert.equal(called, false);
    });

    it('相容是單向的：要求其他 scope 時，messages:push 不會冒充（例如 members:read）', async () => {
        await seedKey({ scopes: ['messages:push'] });
        await seedSystem();
        const res = await withService(async () => new Response('ok'), 'members:read')(req(), env);
        assert.equal(res.status, 403);
    });

    it('raw:push 的金鑰不會因此獲得 members:read', async () => {
        await seedKey({ scopes: ['raw:push'] });
        await seedSystem();
        const res = await withService(async () => new Response('ok'), 'members:read')(req(), env);
        assert.equal(res.status, 403);
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
