/**
 * Bridge 路由分類（只決定「該走哪一種認證」，不是放行）
 *
 *   /bridge/v1/health                  公開（不經過這裡）
 *   /bridge/v1/systems 與其子路徑       人主體（LIFF）+ owner 權限
 *                                      —— 發 key 只能由人操作，key 不能發 key
 *   其他 /bridge/v1/*                  系統主體（Bearer service key + X-Bot-Id）
 *
 *   /bridge/v1/contacts/*              聯絡人綁定（LM-3A）：contacts.js，連結金鑰＋contacts:bind，不走 service key
 *   /bridge/v1/messages                受限通知（LM-3B）：notify.js，連結金鑰＋messages:send，不走 service key
 *   /bridge/v1/admin/*、/link/*、/links/*  連結流程（LM-2A）：links.js 依端點各自認證
 *                                      （營運密鑰、瀏覽器、LIFF 人主體、產品密鑰、連結金鑰），不走 service key
 *
 * 這些都不是公開路由：auth_routes.js 的 PROTECTED_PREFIXES 含 /bridge（fail-closed），
 * 唯一的公開例外是 /bridge/v1/health。
 */

export const SYSTEMS_PATH = "/bridge/v1/systems";
export const HEALTH_PATH = "/bridge/v1/health";

/** 連結流程的路徑根（精確到「段」，所以 /bridge/v1/linksX 不算） */
const LINK_ROOTS = ["/bridge/v1/admin", "/bridge/v1/link", "/bridge/v1/links"];

/** 聯絡人綁定的路徑根（LM-3A，由 contacts.js 處理；一律用連結金鑰認證） */
const CONTACTS_ROOT = "/bridge/v1/contacts";

/** 受限通知端點（LM-3B，由 notify.js 處理；精確比對，/messages/ 之下沒有任何端點） */
export const NOTIFY_PATH = "/bridge/v1/messages";

/**
 * 是否為受限通知路由（LM-3B，POST /bridge/v1/messages；連結金鑰＋messages:send，bridgeError 格式）。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isNotifyRoute(pathname) {
  return pathname === NOTIFY_PATH;
}

/**
 * 是否為聯絡人綁定路由（LM-3A，/bridge/v1/contacts 或其子路徑；連結金鑰＋contacts:bind，bridgeError 格式）。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isContactsRoute(pathname) {
  if (typeof pathname !== "string") return false;
  return pathname === CONTACTS_ROOT || pathname.startsWith(`${CONTACTS_ROOT}/`);
}

/**
 * 是否為連結流程路由（LM-2A，由 links.js 處理；各端點自己決定認證方式）。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isLinkRoute(pathname) {
  if (typeof pathname !== "string") return false;
  return LINK_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

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
  if (isLinkRoute(pathname)) return false;
  if (isContactsRoute(pathname)) return false;
  if (isNotifyRoute(pathname)) return false;
  if (pathname === HEALTH_PATH) return false;
  return true;
}
