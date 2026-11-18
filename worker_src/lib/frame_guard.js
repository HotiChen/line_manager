/**
 * 防點擊劫持：授權同意頁（pages/link_authorize.html）是 Worker 以靜態檔提供的，
 * 頁面內的 top === self 檢查在 JS 被停用或繞過時擋不住嵌入。這裡在伺服器端補
 * X-Frame-Options 與 CSP frame-ancestors。只動這一頁，其他頁面（含 LIFF 頁面）行為不變。
 */

/** 需要禁止被嵌入的靜態頁（已去掉掛載前綴後的路徑，正規化後精確比對） */
const PROTECTED_PATHS = new Set(["/pages/link_authorize.html"]);

/**
 * 把路徑正規化成靜態資源查找實際會用的形狀：百分比解碼、合併重複斜線、解開 `.` 與 `..` 段、不分大小寫。
 * 解不開的百分比序列回 null（那種路徑查不到任何資源，也就沒有東西需要保護）。
 */
function normalizePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const out = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg.toLowerCase());
  }
  return `/${out.join("/")}`;
}

const FRAME_ANCESTORS = "frame-ancestors 'none'";

/** @param {unknown} pathname */
export function isFrameProtectedPath(pathname) {
  if (typeof pathname !== "string") return false;
  const normalized = normalizePath(pathname);
  return normalized !== null && PROTECTED_PATHS.has(normalized);
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
