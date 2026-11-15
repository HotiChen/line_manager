/**
 * 認證路由閘門 — 判斷一個 pathname 是否必須通過 authenticate()
 *
 * 從 index.js 抽出來的原因：這份清單是整個後端的安全邊界，漏一條
 * 就等於開一個無認證端點（/api/* 就是這樣漏了一年）。index.js 因為
 * import 了 __STATIC_CONTENT_MANIFEST，在 node 下無法載入，所以那段
 * 判斷永遠測不到。抽成純函式之後可以直接斷言每條路由的歸屬。
 *
 * 新增端點時：預設把它加進 PROTECTED_PREFIXES，只有確定不需要身分
 * （或有其他驗證機制，例如 webhook 的 LINE 簽章）才放進 PUBLIC_PATHS。
 */

/** 需要認證的路徑前綴 */
const PROTECTED_PREFIXES = [
  "/token",
  "/richmenu",
  "/alias",
  "/flex",
  "/imagemap",
  "/profile",
  "/member",
  "/keyword",
  "/tag",
  "/quickreply",
  "/quick_reply",
  "/tier",
  "/flow",
  "/stats",
  "/user/bot",
  "/image",
  "/team",
  // /api/* 會打到 push_message.route，它用 userId 去 KV 取該使用者的
  // LINE Channel access token。未認證時 userId 來自呼叫者自報的
  // X-User-Id，等於任何人知道一個 userId 就能借用那人的 token 發訊息。
  "/api",
];

/**
 * 落在受保護前綴底下、但本身是公開端點的例外。
 * - /team/invite/preview：受邀者在加入前就要能看邀請內容，此時還沒有身分
 * - /api/webhook：LINE 平台呼叫，身分由 x-line-signature HMAC 驗證（見 lib/signature.js）
 */
const PUBLIC_PATHS = new Set([
  "/team/invite/preview",
  "/api/webhook",
]);

/**
 * 這個路徑是否必須通過認證。
 *
 * @param {string} pathname - URL 的 pathname（不含 query string）
 * @returns {boolean}
 */
export function requiresAuthentication(pathname) {
  if (typeof pathname !== "string" || pathname === "") return false;
  if (PUBLIC_PATHS.has(pathname)) return false;
  return PROTECTED_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * 橋接 API（/api/v1/*）的兩種主體：
 *
 *   /api/v1/systems 與其子路徑   人主體（LIFF）+ owner 權限
 *                               —— 發 key 只能由人操作，key 不能發 key
 *   其他 /api/v1/*               系統主體（Bearer service key + X-Bot-Id）
 *
 * 這個函式只決定「該走哪一種認證」，不是放行：兩種都不公開，
 * requiresAuthentication 對整個 /api/v1 仍回 true（fail-closed）。
 * index.js 必須在 LIFF 認證區塊之前先用它分派，否則 service key 會被當成
 * LIFF token 驗證而一律 401。
 *
 * @param {string} pathname
 * @returns {boolean} true = 該用 service key 認證
 */
export function isBridgeServiceRoute(pathname) {
  if (typeof pathname !== "string") return false;
  if (!pathname.startsWith("/api/v1/")) return false;
  if (pathname === "/api/v1/systems" || pathname.startsWith("/api/v1/systems/")) return false;
  return true;
}
