/**
 * 防點擊劫持：授權同意頁（pages/link_authorize.html）是 Worker 以靜態檔提供的，
 * 頁面內的 top === self 檢查在 JS 被停用或繞過時擋不住嵌入。這裡在伺服器端補
 * X-Frame-Options 與 CSP frame-ancestors。只動這一頁，其他頁面（含 LIFF 頁面）行為不變。
 */

/** 需要禁止被嵌入的靜態頁（已去掉掛載前綴後的路徑，精確比對） */
const PROTECTED_PATHS = new Set(["/pages/link_authorize.html"]);

const FRAME_ANCESTORS = "frame-ancestors 'none'";

/** @param {unknown} pathname */
export function isFrameProtectedPath(pathname) {
  return typeof pathname === "string" && PROTECTED_PATHS.has(pathname);
}

/**
 * 受保護的路徑：回傳加了標頭的新 Response（保留狀態與其他標頭；錯誤頁也保護）；其他路徑原樣回傳。
 *
 * @param {Response} response
 * @param {string} pathname
 * @returns {Response}
 */
export function withFrameProtection(response, pathname) {
  if (!isFrameProtectedPath(pathname)) return response;

  const headers = new Headers(response.headers);
  headers.set("X-Frame-Options", "DENY");

  const existing = headers.get("Content-Security-Policy");
  if (!existing) {
    headers.set("Content-Security-Policy", FRAME_ANCESTORS);
  } else {
    // 保留既有指令，但 frame-ancestors 一律以我們的為準
    const kept = existing
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d !== "" && !/^frame-ancestors(\s|$)/i.test(d));
    headers.set("Content-Security-Policy", [...kept, FRAME_ANCESTORS].join("; "));
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
