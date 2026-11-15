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
 * @param {string} [prefix] 例如 "sk_"
 */
export function randomToken(prefix = '') {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return prefix + b64url;
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
