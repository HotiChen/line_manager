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
