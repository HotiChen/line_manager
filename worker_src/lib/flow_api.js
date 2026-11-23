// worker_src/lib/flow_api.js
// flow 的「呼叫 API」節點：驗證設定 + 安全地發出請求。
//
// 這個節點等於讓 Worker 替使用者對任意網址發請求（SSRF 風險），所以：
//   - 只允許 https、預設連接埠、有網域名稱（擋 IP、localhost、內網常見後綴、帳密網址）
//   - 不跟隨轉址（轉址可以把請求導去內網）
//   - 3 秒逾時、回應最多讀 64KB、標頭 / body 有大小上限、禁用會破壞請求的標頭
//   - 一次回覆最多呼叫 MAX_API_CALLS 次
//   - 結果只轉成 (@api.xxx) 文字變數，且只收純量值

export const MAX_API_CALLS = 3;
const TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BODY_CHARS = 4096;
const MAX_HEADERS = 10;
const MAX_VARS = 50;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'cookie', 'te', 'expect']);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.private'];

function parseJsonObject(text, what) {
    let value;
    try { value = JSON.parse(text || '{}'); } catch { return { error: `${what}不是有效的 JSON` }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${what}必須是 JSON 物件` };
    return { value };
}

/** 主機名稱檢查：必須是網域名稱，不能是 IP / localhost / 內網常見名稱 */
export function isSafeHostname(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!h || !h.includes('.')) return false;
    if (h.startsWith('[') || h.includes(':')) return false;              // IPv6
    if (/^[\d.]+$/.test(h) || /^0x/i.test(h) || /^\d+$/.test(h)) return false; // IPv4 各種寫法
    if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return false;
    return /^[a-z0-9.-]+$/.test(h) || /^[\p{L}\p{N}.-]+$/u.test(h);
}

/**
 * 發布前檢查 API 節點設定
 * @returns {string|null} 錯誤訊息；沒問題回 null
 */
export function validateApiNode(data = {}) {
    let url;
    try { url = new URL(String(data.url || '')); } catch { return '網址格式不正確'; }
    if (url.protocol !== 'https:') return '網址必須是 https://';
    if (url.username || url.password) return '網址不可包含帳號密碼';
    if (url.port && url.port !== '443') return '只能使用預設的 443 連接埠';
    if (!isSafeHostname(url.hostname)) return '網址必須是公開的網域名稱（不可使用 IP 或內部網址）';

    const method = String(data.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return '請求方式只支援 GET 與 POST';

    const headers = parseJsonObject(data.headers, '標頭 (headers)');
    if (headers.error) return headers.error;
    const entries = Object.entries(headers.value);
    if (entries.length > MAX_HEADERS) return `標頭最多 ${MAX_HEADERS} 個`;
    for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return `標頭名稱「${name}」不合法`;
        if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')) return `不能自訂標頭 ${name}`;
        if (typeof value !== 'string' || value.length > 500 || /[\r\n]/.test(value)) return `標頭 ${name} 的值不合法`;
    }

    if (method === 'POST') {
        if (String(data.body || '').length > MAX_BODY_CHARS) return `請求內容超過 ${MAX_BODY_CHARS} 字`;
        const body = parseJsonObject(data.body, '請求內容 (body)');
        if (body.error) return body.error;
    }
    return null;
}

async function readLimited(response, maxBytes) {
    if (!response.body || !response.body.getReader) return (await response.text()).slice(0, maxBytes);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
    }
    try { await reader.cancel(); } catch { /* 已讀完 */ }
    const bytes = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const c of chunks) {
        const take = Math.min(c.length, bytes.length - offset);
        bytes.set(c.subarray(0, take), offset);
        offset += take;
        if (offset >= bytes.length) break;
    }
    return new TextDecoder().decode(bytes);
}

/**
 * 發出請求。任何失敗（設定不合法、逾時、網路錯誤、非 JSON）都回 { ok: false }，不丟例外。
 * @returns {Promise<{ok: boolean, status: number, json: any}>}
 */
export async function callApi(data, { fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    const failed = { ok: false, status: 0, json: null };
    if (validateApiNode(data)) return failed; // 發布後被竄改或舊資料：不發請求

    const method = String(data.method || 'GET').toUpperCase();
    const headers = { 'User-Agent': 'LINE-Flow/1', Accept: 'application/json', ...JSON.parse(data.headers || '{}') };
    const init = { method, headers, redirect: 'manual' };
    if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        init.body = data.body || '{}';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchFn(data.url, { ...init, signal: controller.signal });
        const text = await readLimited(response, MAX_RESPONSE_BYTES);
        let json = null;
        try { json = JSON.parse(text); } catch { /* 不是 JSON：只提供 ok / status */ }
        return { ok: response.status >= 200 && response.status < 300, status: response.status, json };
    } catch {
        return failed;
    } finally {
        clearTimeout(timer);
    }
}

/** 回應 → { 'api.ok': 'true', 'api.status': '200', 'api.欄位.路徑': '值' }（只收純量，深度 ≤ 3，最多 MAX_VARS 個） */
export function flattenApiResult(result) {
    const out = {};
    let count = 0;
    const walk = (value, path, depth) => {
        if (count >= MAX_VARS || depth > 3) return;
        if (value === null || value === undefined) return;
        if (typeof value === 'object') {
            for (const key of Object.keys(value)) {
                if (/^[\w-]{1,40}$/.test(key)) walk(value[key], `${path}.${key}`, depth + 1);
            }
        } else if (['string', 'number', 'boolean'].includes(typeof value)) {
            out[path] = String(value);
            count++;
        }
    };
    if (result && result.json) walk(result.json, 'api', 0);
    // 內建欄位最後寫入，回應裡剛好有 ok / status 欄位時也不能蓋掉
    out['api.ok'] = String(!!(result && result.ok));
    out['api.status'] = String((result && result.status) || 0);
    return out;
}
