/**
 * 橋接 API 用的小型密碼工具（Web Crypto，Workers 與 Node 都可用）
 */

const encoder = new TextEncoder();

/** SHA-256 → 小寫 hex（64 字元）。service key 只存這個，不存原文。 */
export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 產生 32 bytes 隨機值，base64url 編碼（不含 ":"，可安全放進 KV key）。
 * @param {string} [prefix] 例如 "brk_"
 */
export function randomToken(prefix = '') {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return prefix + b64url;
}

/**
 * 產生 Bridge 金鑰：`brk_<6 位小寫 hex 前綴>_<32 bytes base64url 密鑰>`。
 * 前綴只是人眼辨識用（後台、日誌可顯示前綴而不洩漏密鑰），不是秘密，也不另外儲存；
 * 驗證一律只比對整把金鑰的 SHA-256。密鑰段來自 CSPRNG（crypto.getRandomValues）。
 */
export function generateBrokerKey() {
    const p = crypto.getRandomValues(new Uint8Array(3));
    const prefix = Array.from(p, b => b.toString(16).padStart(2, '0')).join('');
    return `brk_${prefix}_${randomToken()}`;
}

/** 定時間比較兩個 Uint8Array，長度不同直接 false。 */
export function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}
