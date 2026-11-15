/**
 * KV-backed distributed Rate Limiter (fixed-window)
 *
 * Uses Cloudflare KV (KV_LINE_STORAGE) for cross-isolate request counting.
 * Each counter key is scoped to a userId + time window index so that all
 * edge nodes see the same shared state.
 *
 * Graceful degradation: if KV is unavailable (e.g., local dev), the limiter
 * fails open (allows all requests) rather than blocking legitimate traffic.
 */
import { jsonResponse } from "../lib/utils.js";
import { BotKeys } from "../lib/kv_schema.js";

const DEFAULT_LIMIT = 100;       // 預設：每分鐘 100 次
const DEFAULT_WINDOW_SEC = 60;   // 時間窗口：60 秒

/**
 * 檢查是否超過 rate limit（KV fixed-window 實作）
 *
 * NOTE — Known race condition at window boundaries:
 * KV does not support atomic read-modify-write, so multiple concurrent
 * requests arriving in the same window may all read count=0 before any
 * write lands, momentarily allowing up to (concurrency - 1) extra requests.
 * This is a well-known limitation of KV-based rate limiting and is acceptable
 * here: the window resets quickly, the overage is bounded, and adding
 * distributed locking would add unacceptable latency on every request.
 *
 * @param {Object} env - Worker 環境（需含 KV_LINE_STORAGE binding）
 * @param {string} userId - 使用者 ID
 * @param {Object} [options] - 設定選項
 * @param {number} [options.limit] - 請求上限（預設 100）
 * @param {number} [options.windowSec] - 時間窗口（秒，預設 60）
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
export async function checkRateLimit(env, userId, options = {}) {
    return checkBucket(env, (windowIndex) => `rl_${userId}_${windowIndex}`, options);
}

/**
 * 共用的 fixed-window 計數核心。
 *
 * @param {Object} env
 * @param {(windowIndex: number) => string} keyFor - 由時間窗索引產生 KV key
 * @param {Object} [options] - { limit, windowSec }
 */
async function checkBucket(env, keyFor, options = {}) {
    const limit = options.limit || DEFAULT_LIMIT;
    const windowSec = options.windowSec || DEFAULT_WINDOW_SEC;
    const now = Date.now();

    if (!env?.KV_LINE_STORAGE) {
        // No KV binding in this environment (e.g., local dev) — skip rate limiting
        return { allowed: true, remaining: limit, resetAt: now + windowSec * 1000 };
    }

    const windowIndex = Math.floor(now / (windowSec * 1000));
    const kvKey = keyFor(windowIndex);
    const resetAt = (windowIndex + 1) * windowSec * 1000;

    try {
        const raw = await env.KV_LINE_STORAGE.get(kvKey);
        const count = raw ? parseInt(raw, 10) : 0;

        if (count >= limit) {
            return { allowed: false, remaining: 0, resetAt };
        }

        // Increment the counter. TTL = windowSec * 2 so KV auto-expires the key
        // shortly after the window closes — no manual cleanup needed.
        // See race-condition note in JSDoc above for why this is fire-and-forget.
        await env.KV_LINE_STORAGE.put(kvKey, String(count + 1), {
            expirationTtl: windowSec * 2,
        });

        return { allowed: true, remaining: limit - count - 1, resetAt };
    } catch (err) {
        // KV failure — fail-open so legitimate traffic is never blocked by infra issues
        console.error("⚠️ [RateLimit] KV error, failing open:", err);
        return { allowed: true, remaining: limit, resetAt };
    }
}

function tooManyRequests(message, resetAt) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    const res = jsonResponse({ error: message, retryAfter }, 429);
    res.headers.set("Retry-After", String(retryAfter));
    return res;
}

/**
 * Rate limit middleware — 可在 index.js 中使用
 *
 * @param {Object} env - Worker 環境（需含 KV_LINE_STORAGE binding）
 * @param {string} userId - 使用者 ID
 * @returns {Promise<Response|null>} 超過限制時回傳 429 Response，否則回傳 null
 */
export async function rateLimitMiddleware(env, userId) {
    if (!userId) return null;

    const result = await checkRateLimit(env, userId);

    if (!result.allowed) {
        return tooManyRequests("Too many requests. Please try again later.", result.resetAt);
    }

    return null;
}

// ── 系統主體（橋接 API）──

const BRIDGE_DEFAULT_LIMITS = { write: 60, read: 120 }; // 每分鐘

function sanitizeLimit(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 系統主體的限流。
 *
 * 桶是 per (botId, system)：不是 per key，所以輪替 key 不會重置額度；
 * 也不是全域共用，所以一個寫壞的垂直後端打爆的只是自己的桶。
 * 寫入類（push 等）與讀取類分開計算。上限可在系統紀錄的 rateLimit 調整。
 *
 * @param {Object} env
 * @param {{botId: string, system: string, rateLimit?: {write?: number, read?: number}}} principal
 * @param {"write"|"read"} kind
 * @returns {Promise<Response|null>} 超過限制回 429（帶 Retry-After），否則 null
 */
export async function bridgeRateLimit(env, principal, kind) {
    const limit = sanitizeLimit(principal.rateLimit?.[kind], BRIDGE_DEFAULT_LIMITS[kind]);
    // system 名稱只含 [a-z0-9_-]，所以用 "." 分隔 kind 不會與別的 system 撞名
    const bucket = `${principal.system}.${kind}`;
    const result = await checkBucket(
        env,
        (windowIndex) => BotKeys.systemRateLimit(principal.botId, bucket, windowIndex),
        { limit, windowSec: DEFAULT_WINDOW_SEC }
    );
    if (!result.allowed) {
        return tooManyRequests("Rate limit exceeded for this system. Please retry later.", result.resetAt);
    }
    return null;
}
