/**
 * 認證中間件 - 驗證使用者身份
 *
 * 支援兩種模式：
 * 1. LIFF Token 驗證（預設，正式環境）：透過 LINE API 驗證 access token，
 *    並確認 token 是發給本專案的 Channel（client_id 比對 LIFF_CHANNEL_ID）
 * 2. User ID 直接傳遞（僅本機開發）：必須明確設定 AUTH_MODE = "legacy" 才會啟用，
 *    未設定時一律視為 liff（預設拒絕）
 */
import { jsonResponse } from "../lib/utils.js";

/**
 * 驗證 LIFF Access Token，取得真實的 userId
 *
 * @param {string} accessToken - LIFF access token
 * @param {Object} env - 需包含 LIFF_CHANNEL_ID
 * @returns {Promise<{valid: boolean, userId?: string, error?: string}>}
 */
async function verifyLiffToken(accessToken, env) {
    // 沒設定 Channel ID 就無法確認 token 的發行對象，寧可拒絕也不放行
    if (!env.LIFF_CHANNEL_ID) {
        return { valid: false, error: "Server misconfigured: LIFF_CHANNEL_ID missing" };
    }
    try {
        // 使用 LINE 的 verify API 驗證 access token
        const verifyRes = await fetch(
            `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
        );

        if (!verifyRes.ok) {
            return { valid: false, error: "Invalid or expired access token" };
        }

        const verifyData = await verifyRes.json();

        // 檢查 token 是否過期
        if (verifyData.expires_in <= 0) {
            return { valid: false, error: "Access token expired" };
        }

        // 確認 token 是發給本專案的 Channel，避免其他 LINE 應用的 token 被接受
        if (String(verifyData.client_id) !== String(env.LIFF_CHANNEL_ID)) {
            return { valid: false, error: "Access token was issued for a different channel" };
        }

        // 使用 access token 取得用戶 profile（包含 userId）
        const profileRes = await fetch("https://api.line.me/v2/profile", {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });

        if (!profileRes.ok) {
            return { valid: false, error: "Failed to get user profile" };
        }

        const profile = await profileRes.json();

        if (!profile.userId) {
            return { valid: false, error: "No userId in profile" };
        }

        return { valid: true, userId: profile.userId };
    } catch (err) {
        return { valid: false, error: `Token verification failed: ${err.message}` };
    }
}

/**
 * 認證中間件
 *
 * - 正式環境（AUTH_MODE === 'liff'）：從 Authorization header 讀取 LIFF token 並驗證
 * - 其他情況（含未設定）一律走 liff；只有 AUTH_MODE === 'legacy' 才允許 X-User-Id（僅限本機開發）
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<{authenticated: boolean, userId?: string, error?: string}>}
 */
export async function authenticate(request, env) {
    // 預設 liff（安全預設）；只有明確設定 "legacy" 才會信任 X-User-Id
    const authMode = env.AUTH_MODE === "legacy" ? "legacy" : "liff";

    // 檢查 Authorization header（LIFF token）
    const authHeader = request.headers.get("Authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const result = await verifyLiffToken(token, env);

        if (result.valid) {
            return { authenticated: true, userId: result.userId };
        }

        // 如果提供了 token 但驗證失敗，直接拒絕
        return { authenticated: false, error: result.error };
    }

    // 沒有 Authorization header 的情況
    if (authMode === "liff") {
        // 正式模式：必須提供 LIFF token，不允許任何回退（SEC-002）
        return { authenticated: false, error: "Authorization header required" };
    }

    // Legacy 模式：接受 X-User-Id（開發/過渡期間）
    const url = new URL(request.url);
    const userId = request.headers.get("X-User-Id") || url.searchParams.get("userId");

    if (userId) {
        return { authenticated: true, userId };
    }

    return { authenticated: false, error: "Missing authentication" };
}

/**
 * 高階函數：包裝需要認證的 handler
 *
 * @param {Function} handler - (request, env, userId, ...args) => Response
 * @returns {Function} 包裝後的 handler
 */
export function withAuth(handler) {
    return async (request, env, ...args) => {
        const auth = await authenticate(request, env);

        if (!auth.authenticated) {
            return jsonResponse({ error: auth.error || "Unauthorized" }, 401);
        }

        return handler(request, env, auth.userId, ...args);
    };
}
