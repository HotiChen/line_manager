/**
 * Unit Tests — lib/quota.js（LINE 訊息額度對帳）
 *
 * 規則（ARCHITECTURE_PLATFORM.md 第九節）：以 LINE 的數字為準，自己記的只是快取。
 *   1. 平常看快取，快速判斷
 *   2. 快取不存在、超過 15 分鐘、或剩餘低於 20% → 先問 LINE 對帳再決定
 *      （低於 20% 時最短 60 秒才再問一次，避免每則 push 都打 LINE 吃它的 rate limit）
 *   3. 回報的 remaining 一律是 LINE 的數字（扣掉對帳後我們自己送出的）
 *   4. LINE 擋下來時，快取直接寫成 0，不等下次對帳
 *   5. 對帳本身失敗（LINE 掛了）：有舊快取就用舊的；完全沒有就放行 —— LINE 自己會擋
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { checkQuota, recordUsage, markExhausted, currentPeriod } from '../../worker_src/lib/quota.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const T0 = Date.UTC(2026, 10, 15, 4, 0, 0); // 2026-11-15 12:00 (UTC+8)
const MIN = 60 * 1000;

const originalFetch = globalThis.fetch;
let env;
let line; // 可調整的「LINE 那邊的真實狀態」

function installLine() {
    line = { type: 'limited', value: 200, totalUsage: 50, fail: false, calls: [] };
    globalThis.fetch = async (url) => {
        const u = String(url);
        line.calls.push(u);
        if (line.fail) return new Response('{"message":"down"}', { status: 500 });
        if (u.endsWith('/v2/bot/message/quota/consumption')) {
            return new Response(JSON.stringify({ totalUsage: line.totalUsage }), { status: 200 });
        }
        if (u.endsWith('/v2/bot/message/quota')) {
            const body = line.type === 'none' ? { type: 'none' } : { type: 'limited', value: line.value };
            return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
}

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV() };
    installLine();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('checkQuota — 對帳', () => {
    it('沒有快取 → 問 LINE，remaining = 上限 - 已用', async () => {
        const r = await checkQuota(env, BOT, 'T', 1, T0);
        assert.equal(r.allowed, true);
        assert.equal(r.remaining, 150);
        assert.equal(r.limit, 200);
        assert.equal(r.source, 'line');
        assert.equal(line.calls.length, 2);
    });

    it('15 分鐘內且額度充裕 → 看快取，不打 LINE', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        line.calls.length = 0;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 14 * MIN);
        assert.equal(r.source, 'cache');
        assert.equal(r.remaining, 150);
        assert.equal(line.calls.length, 0);
    });

    it('超過 15 分鐘 → 再對帳，採用 LINE 新的數字', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        line.totalUsage = 80; // 有人從官方後台手動群發了 30 則
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 16 * MIN);
        assert.equal(r.source, 'line');
        assert.equal(r.remaining, 120);
    });

    it('剩餘低於 20%、距上次對帳超過 60 秒 → 對帳', async () => {
        line.totalUsage = 170; // 剩 30 = 15%
        await checkQuota(env, BOT, 'T', 1, T0);
        line.calls.length = 0;
        line.totalUsage = 175;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 61 * 1000);
        assert.equal(r.source, 'line');
        assert.equal(r.remaining, 25);
    });

    it('剩餘低於 20% 但 60 秒內 → 不重複打 LINE', async () => {
        line.totalUsage = 170;
        await checkQuota(env, BOT, 'T', 1, T0);
        line.calls.length = 0;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 30 * 1000);
        assert.equal(r.source, 'cache');
        assert.equal(line.calls.length, 0);
    });

    it('剛好 20%（剩 40）不算「低於」→ 15 分鐘內看快取', async () => {
        line.totalUsage = 160;
        await checkQuota(env, BOT, 'T', 1, T0);
        line.calls.length = 0;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 2 * MIN);
        assert.equal(r.source, 'cache');
        assert.equal(line.calls.length, 0);
    });
});

describe('checkQuota — 判斷', () => {
    it('剩餘足夠 → allowed', async () => {
        assert.equal((await checkQuota(env, BOT, 'T', 150, T0)).allowed, true);
    });

    it('成本大於剩餘 → 不允許，但仍回報剩餘（讓呼叫端決定降級）', async () => {
        const r = await checkQuota(env, BOT, 'T', 151, T0);
        assert.equal(r.allowed, false);
        assert.equal(r.remaining, 150);
    });

    it('剩餘為 0 → 不允許', async () => {
        line.totalUsage = 200;
        const r = await checkQuota(env, BOT, 'T', 1, T0);
        assert.equal(r.allowed, false);
        assert.equal(r.remaining, 0);
    });

    it('已用量超過上限（LINE 偶爾會這樣）→ remaining 不會是負數', async () => {
        line.totalUsage = 230;
        const r = await checkQuota(env, BOT, 'T', 1, T0);
        assert.equal(r.remaining, 0);
        assert.equal(r.allowed, false);
    });

    it('無上限方案（type: none）→ 永遠允許，remaining 是 null', async () => {
        line.type = 'none';
        const r = await checkQuota(env, BOT, 'T', 9999, T0);
        assert.equal(r.allowed, true);
        assert.equal(r.unlimited, true);
        assert.equal(r.remaining, null);
    });

    it('不同 bot 各自對帳、各自快取', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        line.totalUsage = 10;
        const other = await checkQuota(env, OTHER_BOT, 'T', 1, T0);
        assert.equal(other.remaining, 190);
        const first = await checkQuota(env, BOT, 'T', 1, T0 + MIN);
        assert.equal(first.remaining, 150);
    });
});

describe('recordUsage', () => {
    it('送出後扣掉快取的剩餘，下一次判斷看得到', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        await recordUsage(env, BOT, 10, T0 + MIN);
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 2 * MIN);
        assert.equal(r.source, 'cache');
        assert.equal(r.remaining, 140);
    });

    it('扣到 0 為止，不會變負數', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        await recordUsage(env, BOT, 500, T0 + MIN);
        const raw = await env.KV_LINE_STORAGE.get(BotKeys.quota(BOT, currentPeriod(T0)), { type: 'json' });
        assert.equal(raw.lineRemaining, 0);
    });

    it('自己數的 pushed 會累計（只是參考，不是判斷依據）', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        await recordUsage(env, BOT, 3, T0);
        await recordUsage(env, BOT, 4, T0);
        const raw = await env.KV_LINE_STORAGE.get(BotKeys.quota(BOT, currentPeriod(T0)), { type: 'json' });
        assert.equal(raw.pushed, 7);
    });

    it('沒有快取時不會炸（下一次 check 會對帳）', async () => {
        await recordUsage(env, BOT, 2, T0);
        const r = await checkQuota(env, BOT, 'T', 1, T0 + MIN);
        assert.equal(r.source, 'line');
    });
});

describe('markExhausted', () => {
    it('寫成 0，60 秒內不再問 LINE 就直接擋', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        await markExhausted(env, BOT, T0 + MIN);
        line.calls.length = 0;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + MIN + 10 * 1000);
        assert.equal(r.allowed, false);
        assert.equal(r.remaining, 0);
        assert.equal(line.calls.length, 0);
    });

    it('超過 60 秒後會再對帳（也許月初重置了、也許升級方案了）', async () => {
        await markExhausted(env, BOT, T0);
        line.totalUsage = 20;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 2 * MIN);
        assert.equal(r.source, 'line');
        assert.equal(r.allowed, true);
    });

    it('沒有既有快取也能寫', async () => {
        await markExhausted(env, BOT, T0);
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 5 * 1000);
        assert.equal(r.allowed, false);
    });
});

describe('LINE 對帳失敗', () => {
    it('有舊快取 → 沿用舊的', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        line.fail = true;
        const r = await checkQuota(env, BOT, 'T', 1, T0 + 20 * MIN);
        assert.equal(r.allowed, true);
        assert.equal(r.remaining, 150);
        assert.equal(r.source, 'stale');
    });

    it('完全沒有資料 → 放行，標記 unknown（LINE 自己會擋）', async () => {
        line.fail = true;
        const r = await checkQuota(env, BOT, 'T', 1, T0);
        assert.equal(r.allowed, true);
        assert.equal(r.source, 'unknown');
        assert.equal(r.remaining, null);
    });

    it('失敗時不會把壞資料寫進快取', async () => {
        line.fail = true;
        await checkQuota(env, BOT, 'T', 1, T0);
        assert.equal(env.KV_LINE_STORAGE._store.size, 0);
    });

    it('缺 KV binding → 不丟錯，放行', async () => {
        const r = await checkQuota({}, BOT, 'T', 1, T0);
        assert.equal(r.allowed, true);
    });
});

describe('快取 key', () => {
    it('在 bot 前綴底下，以 YYYYMM 分月', async () => {
        await checkQuota(env, BOT, 'T', 1, T0);
        const keys = [...env.KV_LINE_STORAGE._store.keys()];
        assert.deepEqual(keys, [BotKeys.quota(BOT, '202611')]);
        assert.ok(keys[0].startsWith(BotKeys.prefix(BOT)));
    });

    it('跨月就是另一份快取（月初額度重置，不能沿用上個月的 0）', async () => {
        await markExhausted(env, BOT, Date.UTC(2026, 10, 30, 3, 0, 0));
        line.totalUsage = 0;
        const r = await checkQuota(env, BOT, 'T', 1, Date.UTC(2026, 11, 1, 3, 0, 0));
        assert.equal(r.allowed, true);
        assert.equal(r.remaining, 200);
    });

    it('currentPeriod 以 UTC+8 的月份為準', () => {
        assert.equal(currentPeriod(Date.UTC(2026, 10, 30, 15, 59, 59)), '202611');
        assert.equal(currentPeriod(Date.UTC(2026, 10, 30, 16, 0, 0)), '202612');
    });
});
