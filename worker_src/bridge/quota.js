/**
 * LINE 訊息額度對帳（ARCHITECTURE_PLATFORM.md 第九節）
 *
 * 以 LINE 的數字為準，自己記的只是快取。平台自己數的 pushed 必然偏低：
 * 從官方帳號後台手動群發的、別的工具發的，都不會進我們的計數器。
 *
 * 判斷流程：
 *   1. 平常看 quota:${botId}:${YYYYMM} 快取
 *   2. 快取不存在、超過 15 分鐘、或剩餘低於 20% → 先問 LINE 對帳再決定。
 *      低於 20%（含已耗盡）時最短 60 秒才再問一次 —— 對帳雖不計費，但有自己的
 *      rate limit，不能每則 push 都查。
 *   3. 回報的 remaining 是 LINE 的數字（對帳後我們自己送出的會從中扣掉）
 *   4. LINE 擋下來時 markExhausted 直接寫 0，不等下次對帳
 *   5. 對帳失敗：有舊快取就沿用（source: "stale"）；完全沒資料就放行
 *      （source: "unknown"）—— 擋不擋交給 LINE，我們不憑空拒絕客人的 push
 *
 * 限制：KV 沒有原子操作，快取的扣減是 best-effort；高併發下可能短暫多放幾則，
 * 下一次對帳會校正。嚴格額度需要 Durable Object，目前 repo 沒有。
 */
import { BotKeys } from "../lib/kv_schema.js";
import { getMessageQuota, getMessageQuotaConsumption } from "../lib/line_api.js";

const STALE_MS = 15 * 60 * 1000;
const LOW_STALE_MS = 60 * 1000;
const LOW_RATIO = 0.2;
const CACHE_TTL_SEC = 40 * 24 * 60 * 60;
/** 月份以 UTC+8 切。LINE 實際的重置時區若不同，影響只是快取分桶，下一次對帳就會校正 */
const PERIOD_OFFSET_MS = 8 * 60 * 60 * 1000;

/** @returns {string} YYYYMM */
export function currentPeriod(now = Date.now()) {
    const d = new Date(now + PERIOD_OFFSET_MS);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function readCache(env, botId, now) {
    if (!env?.KV_LINE_STORAGE) return null;
    try {
        return await env.KV_LINE_STORAGE.get(BotKeys.quota(botId, currentPeriod(now)), { type: "json" });
    } catch (err) {
        console.error("[Quota] cache read failed:", err && err.message);
        return null;
    }
}

async function writeCache(env, botId, value, now) {
    if (!env?.KV_LINE_STORAGE) return;
    try {
        await env.KV_LINE_STORAGE.put(BotKeys.quota(botId, currentPeriod(now)), JSON.stringify(value), {
            expirationTtl: CACHE_TTL_SEC,
        });
    } catch (err) {
        console.error("[Quota] cache write failed:", err && err.message);
    }
}

function isLow(cache) {
    if (cache.unlimited) return false;
    if (cache.lineRemaining <= 0) return true;
    return cache.lineLimit > 0 && cache.lineRemaining < cache.lineLimit * LOW_RATIO;
}

function needsReconcile(cache, now) {
    if (!cache || typeof cache.lineCheckedAt !== "number") return true;
    const maxAge = isLow(cache) ? LOW_STALE_MS : STALE_MS;
    return now - cache.lineCheckedAt >= maxAge;
}

function view(cache, cost, source) {
    if (cache.unlimited) {
        return { allowed: true, remaining: null, limit: null, unlimited: true, source };
    }
    return {
        allowed: cache.lineRemaining >= cost,
        remaining: cache.lineRemaining,
        limit: cache.lineLimit,
        unlimited: false,
        source,
    };
}

/**
 * 這次要送出 `cost` 則（收件人數 × 則數）夠不夠。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} token - 該 bot 的 LINE access token（對帳用）
 * @param {number} [cost=1]
 * @param {number} [now]
 * @returns {Promise<{allowed: boolean, remaining: number|null, limit: number|null, unlimited: boolean, source: "cache"|"line"|"stale"|"unknown"}>}
 */
export async function checkQuota(env, botId, token, cost = 1, now = Date.now()) {
    const cache = await readCache(env, botId, now);

    if (cache && typeof cache.lineCheckedAt === "number" && !needsReconcile(cache, now)) {
        return view(cache, cost, "cache");
    }

    try {
        const [quota, consumption] = await Promise.all([
            getMessageQuota(token),
            getMessageQuotaConsumption(token),
        ]);
        const unlimited = quota.type === "none";
        const limit = unlimited ? null : Number(quota.value);
        const used = Number(consumption.totalUsage) || 0;
        const fresh = {
            pushed: cache?.pushed || 0,
            unlimited,
            lineLimit: limit,
            lineRemaining: unlimited ? null : Math.max(0, limit - used),
            lineCheckedAt: now,
        };
        await writeCache(env, botId, fresh, now);
        return view(fresh, cost, "line");
    } catch (err) {
        console.error("[Quota] reconcile failed:", err && err.message);
        if (cache && typeof cache.lineCheckedAt === "number") {
            return view(cache, cost, "stale");
        }
        return { allowed: true, remaining: null, limit: null, unlimited: false, source: "unknown" };
    }
}

/** 成功送出 `cost` 則之後呼叫。記帳失敗不可讓已經送出的 push 變成錯誤。 */
export async function recordUsage(env, botId, cost, now = Date.now()) {
    try {
        const cache = (await readCache(env, botId, now)) || {};
        const next = { ...cache, pushed: (cache.pushed || 0) + cost };
        if (typeof cache.lineRemaining === "number") {
            next.lineRemaining = Math.max(0, cache.lineRemaining - cost);
        }
        await writeCache(env, botId, next, now);
    } catch (err) {
        console.error("[Quota] recordUsage failed:", err && err.message);
    }
}

/** LINE 回報額度用盡（429 等）時呼叫：直接寫 0，不等下次對帳。 */
export async function markExhausted(env, botId, now = Date.now()) {
    try {
        const cache = (await readCache(env, botId, now)) || {};
        await writeCache(env, botId, {
            pushed: cache.pushed || 0,
            unlimited: false,
            lineLimit: cache.lineLimit ?? null,
            lineRemaining: 0,
            lineCheckedAt: now,
        }, now);
    } catch (err) {
        console.error("[Quota] markExhausted failed:", err && err.message);
    }
}
