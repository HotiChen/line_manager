// lib/utils.js

/**
 * 統一回傳 JSON 格式
 * @param {*} data
 * @param {number} status
 * @param {Request|null} request  - 可選，用於 CORS origin 反射
 * @param {Object|null} env       - 可選，讀取 ALLOWED_ORIGIN 環境變數
 */
export function jsonResponse(data, status = 200, request = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * 解析 ALLOWED_ORIGIN 環境變數（逗號分隔），回傳允許的 Origin 字串。
 *
 * 規則（SEC-005）:
 * 1. 若 env.ALLOWED_ORIGIN 有設定，只允許白名單內的 origin；
 *    - 若請求 origin 在白名單內，反射該 origin（支援 credentials）
 *    - 否則回傳白名單第一個 origin（防止洩漏資訊）
 * 2. 若 env.ALLOWED_ORIGIN 未設定，回傳 "*"（保留開發環境行為）
 *
 * @param {Request|null} request
 * @param {Object|null} env
 * @returns {string}
 */
function resolveAllowedOrigin(request, env) {
  const allowedOriginEnv = env && env.ALLOWED_ORIGIN;
  if (!allowedOriginEnv) return "*";

  const allowedOrigins = allowedOriginEnv.split(",").map(o => o.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) return "*";

  const requestOrigin = request && request.headers.get("Origin");
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Origin not in whitelist — return the first configured origin as a safe default
  return allowedOrigins[0];
}

/**
 * CORS headers
 * 當 request 和 env 傳入時，依據 ALLOWED_ORIGIN 白名單反射 origin（SEC-005）。
 * 否則回傳 "*"（開發環境向下相容）。
 *
 * @param {Request|null} request
 * @param {Object|null} env
 */
export function getCorsHeaders(request = null, env = null) {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(request, env),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-User-Id, X-Bot-Id, Authorization",
  };
}