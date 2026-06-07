/**
 * 認證中間件 - 驗證使用者身份
 *
 * 支援兩種模式：
 * 1. LIFF Token 驗證（正式環境）：透過 LINE LIFF API 驗證 access token
 * 2. User ID 直接傳遞（開發環境）：僅在 AUTH_MODE !== 'liff' 時允許
 */
import { jsonResponse } from "../lib/utils.js";

/**
 * 驗證 LIFF Access Token，取得真實的 userId
 *
 * @param {string} accessToken - LIFF access token
 * @returns {Promise<{valid: boolean, userId?: string, error?: string}>}
 */
async function verifyLiffToken(accessToken) {
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
 * - 開發環境：允許 X-User-Id header 直接傳遞（僅限開發）
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<{authenticated: boolean, userId?: string, error?: string}>}
 */
export async function authenticate(request, env) {
    const authMode = env.AUTH_MODE || "legacy";

    // 檢查 Authorization header（LIFF token）
    const authHeader = request.headers.get("Authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const result = await verifyLiffToken(token);

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
