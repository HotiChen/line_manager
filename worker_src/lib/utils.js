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
 * 是否為本機開發來源（localhost / 127.0.0.1，任意 port / scheme）。
 * @param {string} origin
 * @returns {boolean}
 */
function isLocalhostOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * 解析允許的 Access-Control-Allow-Origin 值（fail-closed，SEC-005）。
 *
 * 部署前提：前端與 worker 由同一個 worker（wrangler site bucket）提供服務，
 * 正式環境瀏覽器流量皆為同源，根本不需要 CORS。CORS 只在本機開發時需要
 * （前端 127.0.0.1:5500 → worker localhost:8787）。
 *
 * 規則:
 * 1. 若 env.ALLOWED_ORIGIN 有設定，只允許白名單內的 origin；
 *    - 若請求 origin 在白名單內，反射該 origin（支援 credentials）
 *    - 否則回傳白名單第一個 origin（防止洩漏資訊）
 * 2. 若 env.ALLOWED_ORIGIN 未設定（fail-closed）：
 *    - 僅當請求 origin 是 localhost / 127.0.0.1 時才反射該 origin（本機開發）
 *    - 否則回傳 worker 自身的 origin（同源，等同不開放跨域）
 *
 * @param {Request|null} request
 * @param {Object|null} env
 * @returns {string}
 */
function resolveAllowedOrigin(request, env) {
  const requestOrigin = request && request.headers.get("Origin");
  const allowedOriginEnv = env && env.ALLOWED_ORIGIN;

  if (allowedOriginEnv) {
    const allowedOrigins = allowedOriginEnv.split(",").map(o => o.trim()).filter(Boolean);
    if (allowedOrigins.length > 0) {
      if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      // Origin not in whitelist — return the first configured origin as a safe default
      return allowedOrigins[0];
    }
  }

  // Fail-closed：未設定白名單時只放行本機開發來源，其餘回退至同源（worker 自身 origin）
  if (requestOrigin && isLocalhostOrigin(requestOrigin)) {
    return requestOrigin;
  }

  try {
    if (request) return new URL(request.url).origin;
  } catch {
    // ignore
  }
  return "null";
}

/**
 * CORS headers
 * 依據 ALLOWED_ORIGIN 與請求來源解析允許的 origin（fail-closed，SEC-005）。
 * 詳見 resolveAllowedOrigin 的說明。
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