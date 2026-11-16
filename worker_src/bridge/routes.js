/**
 * Bridge 路由分類（只決定「該走哪一種認證」，不是放行）
 *
 *   /bridge/v1/health                  公開（不經過這裡）
 *   /bridge/v1/systems 與其子路徑       人主體（LIFF）+ owner 權限
 *                                      —— 發 key 只能由人操作，key 不能發 key
 *   其他 /bridge/v1/*                  系統主體（Bearer service key + X-Bot-Id）
 *
 * 兩種都不是公開路由：auth_routes.js 的 PROTECTED_PREFIXES 含 /bridge（fail-closed），
 * 唯一的公開例外是 /bridge/v1/health。
 */

export const SYSTEMS_PATH = "/bridge/v1/systems";
export const HEALTH_PATH = "/bridge/v1/health";

/**
 * 是否為人主體的 systems 路由（/bridge/v1/systems 或其子路徑）。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isSystemsRoute(pathname) {
  if (typeof pathname !== "string") return false;
  return pathname === SYSTEMS_PATH || pathname.startsWith(`${SYSTEMS_PATH}/`);
}

/**
 * 這個路徑是否該用 service key 認證。
 *
 * @param {string} pathname
 * @returns {boolean} true = 該用 service key 認證
 */
export function isBridgeServiceRoute(pathname) {
  if (typeof pathname !== "string") return false;
  if (!pathname.startsWith("/bridge/v1/")) return false;
  if (isSystemsRoute(pathname)) return false;
  if (pathname === HEALTH_PATH) return false;
  return true;
}
