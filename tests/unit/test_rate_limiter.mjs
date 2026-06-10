/**
 * Unit Tests - middleware/rate_limiter.js
 * 測試速率限制邏輯
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, rateLimitMiddleware } from '../../worker_src/middleware/rate_limiter.js';

describe('checkRateLimit', () => {
    const env = {};

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

        assert.equal(r1.remaining, 99); // 100 - 1
        assert.equal(r2.remaining, 98); // 100 - 2
        assert.equal(r3.remaining, 97); // 100 - 3
    });

    it('should block after exceeding limit', async () => {
        const userId = `test_block_${Date.now()}`;
        const limit = 5;
        const opts = { limit, windowSec: 60 };

        // Use up all requests
        for (let i = 0; i < limit; i++) {
            const r = await checkRateLimit(env, userId, opts);
            assert.equal(r.allowed, true);
        }

        // Next request should be blocked
        const blocked = await checkRateLimit(env, userId, opts);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.remaining, 0);
    });

    it('should track different users independently', async () => {
        const ts = Date.now();
        const user1 = `test_indep1_${ts}`;
        const user2 = `test_indep2_${ts}`;
        const opts = { limit: 3, windowSec: 60 };

        // Exhaust user1
        for (let i = 0; i < 3; i++) {
            await checkRateLimit(env, user1, opts);
        }
        const blocked1 = await checkRateLimit(env, user1, opts);
        assert.equal(blocked1.allowed, false);

        // user2 should still be allowed
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
        assert.ok(result.resetAt >= before + 120 * 1000 - 100); // allow small timing variance
        assert.ok(result.resetAt <= Date.now() + 120 * 1000 + 100);
    });
});

describe('rateLimitMiddleware', () => {
    const env = {};

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

        // Exhaust with low limit via direct checkRateLimit calls
        for (let i = 0; i < 101; i++) {
            await checkRateLimit(env, userId);
        }

        const result = await rateLimitMiddleware(env, userId);
        assert.notEqual(result, null);
        assert.equal(result.status, 429);

        const body = await result.json();
        assert.ok(body.error.includes('Too many requests'));
        assert.ok(typeof body.retryAfter === 'number');
    });
});
