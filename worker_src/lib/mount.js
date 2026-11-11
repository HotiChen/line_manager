/**
 * mount — 讓這個 worker 可以掛在網域的子路徑底下
 *
 * 原本只掛在 `pinti-line.hotichen.workers.dev` 的根，路由表比對的是
 * `/member`、`/richmenu` 這種路徑。掛到 `imhoti.tw/lm/` 之後，Cloudflare
 * 送進來的 pathname 是 `/lm/member/list`，於是：
 *
 *   - 每個 API 請求都比對不到，掉進靜態資源分支
 *   - 每個靜態資源的 key 也對不上（site bucket 裡存的是 `css/a.css`）
 *
 * 所以在最外層把前綴切掉一次，底下所有程式碼都還是看到 `/member/list`。
 * 這樣做而不是去改那張路由表，是因為路由表有十幾條，漏掉一條不會報錯 ——
 * 只會有某一個頁面安靜地 404。
 *
 * 前綴從 `env.MOUNT_PATH` 來。沒設定時等於掛在根，行為與加這個模組之前
 * 完全相同，所以本機開發與 workers.dev 的網址都不受影響。
 */

/**
 * 把 MOUNT_PATH 正規化成「有開頭斜線、沒有結尾斜線」或空字串。
 *
 * `'/'` 要回空字串：它代表「掛在根」，但如果照字面當成前綴，每個路徑都會
 * 被多切掉一個斜線。
 *
 * @param {unknown} raw - env.MOUNT_PATH
 * @returns {string} 例如 '/lm'，或 '' 表示掛在根
 */
export function normalizeMount(raw) {
    if (typeof raw !== 'string') return '';

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '/') return '';

    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

/**
 * 把掛載前綴從 pathname 切掉。
 *
 * 命中的定義是「完全等於前綴」或「以前綴加一個斜線開頭」。寫成
 * `startsWith(mount)` 的話 `/lmx` 會被切成 `x`，而那是個沒有人認得的路徑。
 *
 * 只等於前綴（`/lm`）時回一個重導目標。前端的資源參照全部是相對路徑
 * （`css/a.css`、`./js/main.js`、`fetch('./pages/x.html')`），而相對路徑是
 * 對「當前目錄」解析的：在 `/lm` 底下 `css/a.css` 會變成 `/css/a.css`，
 * 那是別人的地盤；要 `/lm/` 才會變成 `/lm/css/a.css`。
 *
 * @param {string} pathname
 * @param {string} mount - 已經過 normalizeMount
 * @returns {{pathname: string, redirect: string|null}}
 */
export function stripMount(pathname, mount) {
    if (mount === '') return { pathname, redirect: null };

    if (pathname === mount) {
        return { pathname: '/', redirect: `${mount}/` };
    }

    if (pathname.startsWith(`${mount}/`)) {
        return { pathname: pathname.slice(mount.length), redirect: null };
    }

    // 前綴以外的路徑原樣放過。route 設錯時應該是「這個 worker 不處理」，
    // 不是默默把路徑改寫成另一個東西。
    return { pathname, redirect: null };
}
