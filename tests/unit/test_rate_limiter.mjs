/**
 * Unit Tests - middleware/rate_limiter.js
 * 測試速率限制邏輯（KV-backed fixed-window 實作）
 *
 * 每個 describe 都使用獨立的 createMockKV() 實例，確保測試互不干擾。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, rateLimitMiddleware } from '../../worker_src/middleware/rate_limiter.js';
import { createMockKV } from '../helpers/mock_kv.mjs';

describe('checkRateLimit', () => {
    let kv;
    let env;

    beforeEach(() => {
        // 每個測試都使用全新的 KV 實例，避免計數器互相干擾
        kv = createMockKV();
        env = { KV_LINE_STORAGE: kv };
    });

    it('should allow first request', async () => {
        const userId = `test_first_${Date.now()}`;
        const result = await checkRateLimit(env, userId);
        assert.equal(result.allowed, true);
        assert.ok(result.remaining >= 0);
        assert.ok(result.resetAt > Date.now());
    });

    it('should track request count', async () => {
        const userId = `test_count_${Date.now()}`;
        const r1 = await checkRateLimit(env, userId);
        const r2 = await checkRateLimit(env, userId);
        const r3 = await checkRateLimit(env, userId);

        // KV-backed：計數器正確遞增，remaining 應依序減少
        assert.equal(r1.remaining, 99); // 100 - 1
        assert.equal(r2.remaining, 98); // 100 - 2
        assert.equal(r3.remaining, 97); // 100 - 3
    });

    it('should block after exceeding limit', async () => {
        const userId = `test_block_${Date.now()}`;
        const limit = 5;
        const opts = { limit, windowSec: 60 };

        // 用完所有配額
        for (let i = 0; i < limit; i++) {
            const r = await checkRateLimit(env, userId, opts);
            assert.equal(r.allowed, true);
        }

        // 下一個請求應被封鎖
        const blocked = await checkRateLimit(env, userId, opts);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.remaining, 0);
    });

    it('should track different users independently', async () => {
        const ts = Date.now();
        const user1 = `test_indep1_${ts}`;
        const user2 = `test_indep2_${ts}`;
        const opts = { limit: 3, windowSec: 60 };

        // 用完 user1 的配額
        for (let i = 0; i < 3; i++) {
            await checkRateLimit(env, user1, opts);
        }
        const blocked1 = await checkRateLimit(env, user1, opts);
        assert.equal(blocked1.allowed, false);

        // user2 不受影響，應仍可通過
        const allowed2 = await checkRateLimit(env, user2, opts);
        assert.equal(allowed2.allowed, true);
    });

    it('should respect custom limit', async () => {
        const userId = `test_custom_${Date.now()}`;
        const opts = { limit: 2, windowSec: 60 };

        await checkRateLimit(env, userId, opts);
        await checkRateLimit(env, userId, opts);
        const result = await checkRateLimit(env, userId, opts);
        assert.equal(result.allowed, false);
    });

    it('should return correct resetAt timestamp', async () => {
        const userId = `test_reset_${Date.now()}`;
        const opts = { limit: 100, windowSec: 120 };
        const before = Date.now();

        const result = await checkRateLimit(env, userId, opts);
        // resetAt は現在の固定ウィンドウの終わり：(windowIndex+1)*windowSec*1000
        // 必ず now > resetAt - windowSec*1000 かつ resetAt <= now + windowSec*1000
        assert.ok(result.resetAt > before, `resetAt ${result.resetAt} should be > before ${before}`);
        assert.ok(result.resetAt <= before + 120 * 1000 + 100, `resetAt ${result.resetAt} should be <= before+120s`);
    });

    // 失敗開放（fail-open）路徑：沒有 KV binding 時應允許所有請求
    it('should fail open when KV binding is absent', async () => {
        const noKvEnv = {}; // 沒有 KV_LINE_STORAGE
        const userId = `test_failopen_${Date.now()}`;

        const result = await checkRateLimit(noKvEnv, userId);
        // 沒有 KV 時應放行，不計數
        assert.equal(result.allowed, true);
        assert.ok(result.remaining >= 0);
        assert.ok(result.resetAt > Date.now());
    });

    // KV 錯誤時應失敗開放（fail-open），不阻擋合法流量
    it('should fail open when KV throws an error', async () => {
        // 建立一個 get() 會拋出錯誤的假 KV
        const brokenKv = {
            async get() { throw new Error('KV connection failed'); },
            async put() { throw new Error('KV connection failed'); },
            async delete() { throw new Error('KV connection failed'); },
            async list() { throw new Error('KV connection failed'); },
        };
        const brokenEnv = { KV_LINE_STORAGE: brokenKv };
        const userId = `test_kverror_${Date.now()}`;

        const result = await checkRateLimit(brokenEnv, userId);
        // KV 錯誤時應放行（fail-open），不拋出例外
        assert.equal(result.allowed, true);
        assert.ok(result.remaining >= 0);
    });
});

describe('rateLimitMiddleware', () => {
    let kv;
    let env;

    beforeEach(() => {
        kv = createMockKV();
        env = { KV_LINE_STORAGE: kv };
    });

    it('should return null (allow) for normal requests', async () => {
        const userId = `mw_normal_${Date.now()}`;
        const result = await rateLimitMiddleware(env, userId);
        assert.equal(result, null);
    });

    it('should return null for null userId', async () => {
        const result = await rateLimitMiddleware(env, null);
        assert.equal(result, null);
    });

    it('should return 429 Response when rate limited', async () => {
        const userId = `mw_limited_${Date.now()}`;
        const opts = { limit: 3, windowSec: 60 };

        // 直接用 checkRateLimit 把配額用完（limit=3）
        for (let i = 0; i < 3; i++) {
            await checkRateLimit(env, userId, opts);
        }

        // rateLimitMiddleware 使用預設 limit=100，所以這裡需要把 KV 計數設到 100
        // 改用另一個方式：用低 limit 的情境測試 middleware 的 429 路徑
        // 直接操作 KV：將計數器預先設為超過上限的值
        const now = Date.now();
        const windowIndex = Math.floor(now / (60 * 1000));
        const kvKey = `rl_${userId}_${windowIndex}`;
        // 把計數器設為 100（等於預設 limit），下一次請求就會被擋
        await kv.put(kvKey, '100', { expirationTtl: 120 });

        const result = await rateLimitMiddleware(env, userId);
        assert.notEqual(result, null);
        assert.equal(result.status, 429);

        const body = await result.json();
        assert.ok(body.error.includes('Too many requests'));
        assert.ok(typeof body.retryAfter === 'number');
    });
});
