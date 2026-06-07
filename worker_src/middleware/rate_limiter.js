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
    const limit = options.limit || DEFAULT_LIMIT;
    const windowSec = options.windowSec || DEFAULT_WINDOW_SEC;
    const now = Date.now();

    if (!env?.KV_LINE_STORAGE) {
        // No KV binding in this environment (e.g., local dev) — skip rate limiting
        return { allowed: true, remaining: limit, resetAt: now + windowSec * 1000 };
    }

    const windowIndex = Math.floor(now / (windowSec * 1000));
    const kvKey = `rl_${userId}_${windowIndex}`;
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
        return jsonResponse({
            error: "Too many requests. Please try again later.",
            retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
        }, 429);
    }

    return null;
}
