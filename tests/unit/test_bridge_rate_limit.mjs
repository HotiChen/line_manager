/**
 * Unit Tests — 系統主體的限流（middleware/rate_limiter.js）
 *
 * 設計（ARCHITECTURE_PLATFORM.md 第十節）：
 *   - 桶是 per (botId, system)，不是 per key —— 輪替 key 不該順便重置額度
 *   - 寫入類（push）與讀取類分開計算
 *   - 超過回 429 並帶 Retry-After
 *   - 一個系統打爆自己的額度，不影響別的系統、別的 bot
 *   - 額度可存在系統紀錄的 rateLimit 調整
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import {
    bridgeRateLimit,
    rateLimitMiddleware,
    checkRateLimit,
} from '../../worker_src/middleware/rate_limiter.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';

let env;

function principal(over = {}) {
    return { botId: BOT, system: 'imgpicker', scopes: ['messages:push'], ...over };
}

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV() };
});

describe('bridgeRateLimit', () => {
    it('額度內回 null（放行）', async () => {
        assert.equal(await bridgeRateLimit(env, principal(), 'write'), null);
    });

    it('寫入類預設每分鐘 60 次，第 61 次回 429', async () => {
        for (let i = 0; i < 60; i++) {
            assert.equal(await bridgeRateLimit(env, principal(), 'write'), null, `第 ${i + 1} 次`);
        }
        const res = await bridgeRateLimit(env, principal(), 'write');
        assert.notEqual(res, null);
        assert.equal(res.status, 429);
    });

    it('429 帶 Retry-After（1~60 秒的整數）與 body.retryAfter', async () => {
        const p = principal({ rateLimit: { write: 1 } });
        await bridgeRateLimit(env, p, 'write');
        const res = await bridgeRateLimit(env, p, 'write');
        assert.equal(res.status, 429);
        const retry = Number(res.headers.get('Retry-After'));
        assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${retry}`);
        const body = await res.json();
        assert.equal(body.retryAfter, retry);
    });

    it('系統紀錄的 rateLimit.write 可以調整上限', async () => {
        const p = principal({ rateLimit: { write: 3 } });
        for (let i = 0; i < 3; i++) assert.equal(await bridgeRateLimit(env, p, 'write'), null);
        assert.equal((await bridgeRateLimit(env, p, 'write')).status, 429);
    });

    it('調高上限也生效（例如 200）', async () => {
        const p = principal({ rateLimit: { write: 200 } });
        for (let i = 0; i < 100; i++) assert.equal(await bridgeRateLimit(env, p, 'write'), null);
    });

    it('不合理的 rateLimit 值（0、負數、字串）退回預設，不會變成「全擋」或「不限」', async () => {
        for (const bogus of [0, -5, 'lots', NaN, null]) {
            const e = { KV_LINE_STORAGE: createMockKV() };
            const p = principal({ rateLimit: { write: bogus } });
            assert.equal(await bridgeRateLimit(e, p, 'write'), null, String(bogus));
        }
    });

    it('寫入與讀取分開計算', async () => {
        const p = principal({ rateLimit: { write: 1, read: 5 } });
        await bridgeRateLimit(env, p, 'write');
        assert.equal((await bridgeRateLimit(env, p, 'write')).status, 429);
        assert.equal(await bridgeRateLimit(env, p, 'read'), null);
    });

    it('不同 system 各自一個桶', async () => {
        const a = principal({ system: 'sys-a', rateLimit: { write: 1 } });
        const b = principal({ system: 'sys-b', rateLimit: { write: 1 } });
        await bridgeRateLimit(env, a, 'write');
        assert.equal((await bridgeRateLimit(env, a, 'write')).status, 429);
        assert.equal(await bridgeRateLimit(env, b, 'write'), null);
    });

    it('不同 bot 的同名 system 各自一個桶', async () => {
        const a = principal({ botId: BOT, rateLimit: { write: 1 } });
        const b = principal({ botId: OTHER_BOT, rateLimit: { write: 1 } });
        await bridgeRateLimit(env, a, 'write');
        assert.equal((await bridgeRateLimit(env, a, 'write')).status, 429);
        assert.equal(await bridgeRateLimit(env, b, 'write'), null);
    });

    it('桶綁 (bot, system) 而不是 key：同一主體換 key 之後額度仍延續', async () => {
        // principal 不含 key 資訊 —— 輪替只換 key，主體相同，計數就相同
        const p = principal({ rateLimit: { write: 2 } });
        await bridgeRateLimit(env, p, 'write');
        await bridgeRateLimit(env, p, 'write');
        const afterRotate = principal({ rateLimit: { write: 2 } });
        assert.equal((await bridgeRateLimit(env, afterRotate, 'write')).status, 429);
    });

    it('計數器放在 bot 前綴底下（租戶刪除時一併清掉），且不碰 rl_ 命名空間', async () => {
        await bridgeRateLimit(env, principal(), 'write');
        const keys = [...env.KV_LINE_STORAGE._store.keys()];
        assert.equal(keys.length, 1);
        assert.ok(keys[0].startsWith(BotKeys.prefix(BOT)), keys[0]);
        assert.ok(!keys[0].startsWith('rl_'));
    });

    it('計數器有 TTL（不會永遠留在 KV）', async () => {
        await bridgeRateLimit(env, principal(), 'write');
        const [key] = [...env.KV_LINE_STORAGE._store.keys()];
        env.KV_LINE_STORAGE._advanceTime(10 * 60 * 1000);
        assert.equal(await env.KV_LINE_STORAGE.get(key), null);
    });

    it('缺 KV binding 時放行（與人主體限流同為 fail-open；認證那一層已經 fail-closed）', async () => {
        assert.equal(await bridgeRateLimit({}, principal(), 'write'), null);
    });
});

describe('既有行為不變', () => {
    it('人主體的 rl_${userId}_${window} 形狀不變', async () => {
        await checkRateLimit(env, 'Uabc', { limit: 5, windowSec: 60 });
        const keys = [...env.KV_LINE_STORAGE._store.keys()];
        assert.ok(keys.some(k => /^rl_Uabc_\d+$/.test(k)), keys.join(','));
    });

    it('人主體 429 現在也帶 Retry-After', async () => {
        const windowIndex = Math.floor(Date.now() / 60000);
        await env.KV_LINE_STORAGE.put(`rl_Uabc_${windowIndex}`, '100', { expirationTtl: 120 });
        const res = await rateLimitMiddleware(env, 'Uabc');
        assert.equal(res.status, 429);
        const retry = Number(res.headers.get('Retry-After'));
        assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60);
    });
});
