/**
 * token_crypto — LINE channel access token 的靜態加密
 *
 * 為什麼需要：access token 是一個 LINE 官方帳號的完全控制權。只保管自己的
 * 帳號是一回事；一旦開放給別人用，KV 裡躺的就是別人帳號的控制權，外洩等於
 * 所有人的帳號被接管。
 *
 * 格式：`enc.v1.<iv>.<ciphertext>`，兩段都是 base64url。
 *
 *   - 密文是**字串**，不是物件。access_tokens 的結構是
 *     `{ [project]: { token, destination, displayName } }`，維持 token 欄位為
 *     字串，資料形狀就完全不變。
 *   - 帶版本號，將來換演算法或輪替金鑰時還讀得懂舊資料。
 *   - AES-GCM：除了保密還附完整性保護，密文被動過會解密失敗而不是回垃圾。
 *   - 每次加密用新的隨機 IV（96 bit，GCM 的標準長度）。同一個明文重複加密
 *     得到相同密文會洩漏「這兩個帳號用同一把 token」這類資訊。
 *
 * 金鑰：`env.TOKEN_ENCRYPTION_KEY`，32 bytes 的 base64。產生方式：
 *
 *     openssl rand -base64 32
 *     npx wrangler secret put TOKEN_ENCRYPTION_KEY
 *
 * fail-closed：加密時缺金鑰一律丟錯，絕不默默存明文 —— 那會讓「已加密」
 * 變成一個沒有根據的假設。解密遇到密文卻缺金鑰也丟錯，那是設定錯誤。
 *
 * 明文向下相容：`decryptToken` 收到不帶前綴的值就原樣回傳。正式環境已經有
 * 明文 token，少了這條路，加密上線的那一刻所有既有帳號立刻失效。
 */

const PREFIX = 'enc';
const VERSION = 'v1';
/** 本模組負責的整個命名空間。`enc.` 開頭的值一律不是明文。 */
const NAMESPACE = `${PREFIX}.`;
const SEALED_PREFIX = `${PREFIX}.${VERSION}.`;
const IV_BYTES = 12;          // GCM 建議的 96 bit
const KEY_BYTES = 32;         // AES-256

function b64urlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function decodeBase64(text) {
    const binary = atob(String(text).trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * 從 env 取出金鑰。缺少或長度不對一律丟錯。
 *
 * @param {Object} env
 * @returns {Promise<CryptoKey>}
 */
async function importKey(env) {
    const raw = env && env.TOKEN_ENCRYPTION_KEY;
    if (typeof raw !== 'string' || raw === '') {
        throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    }

    let bytes;
    try {
        bytes = decodeBase64(raw);
    } catch {
        throw new Error('TOKEN_ENCRYPTION_KEY is not valid base64');
    }
    if (bytes.length !== KEY_BYTES) {
        throw new Error(`TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${bytes.length}`);
    }

    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * 這個值是不是本模組加密過的密文。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/**
 * 這個值落在加密的命名空間裡（不管版本）。
 *
 * 分成兩個函式，是為了讓「未知版本」能被當成錯誤而不是明文：
 * `enc.v2.…` 是比這份程式新的版本寫的資料，把它當明文原樣回傳，就會把一段
 * 密文當成 token 送去 LINE。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function looksSealed(value) {
    return typeof value === 'string' && value.startsWith(NAMESPACE);
}

/**
 * 加密一個 token。
 *
 * @param {Object} env - 需含 TOKEN_ENCRYPTION_KEY
 * @param {string} plaintext
 * @returns {Promise<string>} `enc.v1.<iv>.<ct>`
 * @throws 金鑰缺少、格式不對，或 plaintext 非字串
 */
export async function encryptToken(env, plaintext) {
    if (typeof plaintext !== 'string' || plaintext === '') {
        throw new TypeError('encryptToken: plaintext must be a non-empty string');
    }

    const key = await importKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plaintext)
    );

    return `${SEALED_PREFIX}${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * 解密一個 token，明文則原樣回傳。
 *
 * @param {Object} env
 * @param {string} stored - KV 裡存的值，密文或明文
 * @returns {Promise<string>}
 * @throws 是密文但金鑰缺少、格式壞掉、或完整性驗證失敗
 */
export async function decryptToken(env, stored) {
    if (typeof stored !== 'string') {
        throw new TypeError('decryptToken: stored value must be a string');
    }

    // 不在加密命名空間裡 = 加密上線前就存在的明文，原樣回傳
    if (!looksSealed(stored)) return stored;

    // 在命名空間裡但版本不是本模組認得的 —— 可能是更新版的程式寫的。
    // 絕不可當明文放行。
    if (!isEncrypted(stored)) {
        throw new Error(`decryptToken: unsupported ciphertext version in ${stored.slice(0, 8)}…`);
    }

    const parts = stored.split('.');
    if (parts.length !== 4 || parts[2] === '' || parts[3] === '') {
        throw new Error('decryptToken: malformed ciphertext');
    }

    const key = await importKey(env);

    let plaintext;
    try {
        plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: b64urlDecode(parts[2]) },
            key,
            b64urlDecode(parts[3])
        );
    } catch {
        // 金鑰不對、或密文被動過 —— GCM 的驗證失敗。不可回傳任何東西。
        throw new Error('decryptToken: decryption failed (wrong key or tampered value)');
    }

    return new TextDecoder().decode(plaintext);
}
