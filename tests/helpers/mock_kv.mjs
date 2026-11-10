/**
 * mock_kv.mjs — 可重用的 Cloudflare KV 記憶體模擬實作
 *
 * 此模組提供 createMockKV()，回傳一個物件，實作與 Cloudflare KV 相同的 API 介面，
 * 以便在 Node.js 單元測試中使用，無需實際的 Cloudflare 環境。
 *
 * 支援的 KV 方法：
 *   - get(key)                              → string | null
 *   - put(key, value, { expirationTtl })    → void（TTL 使用絕對過期時間戳記）
 *   - delete(key)                           → void
 *   - list({ prefix, cursor, limit })       → { keys, list_complete, cursor }
 *
 * TTL 行為：
 *   - 儲存 expirationTtl 時，以目前時間加上 TTL 秒數計算絕對過期時間戳記
 *   - get() 與 list() 自動跳過已過期的 key（惰性清除）
 *   - 可使用 _advanceTime(ms) 模擬時間前進，方便測試過期行為
 *
 * 使用範例：
 *   import { createMockKV } from '../helpers/mock_kv.mjs';
 *   const kv = createMockKV();
 *   const env = { KV_LINE_STORAGE: kv };
 */

/**
 * 建立一個新的記憶體 KV 實例。
 * 每次呼叫都會回傳獨立的儲存空間，適合在 beforeEach() 中呼叫以保持測試隔離。
 *
 * @returns {{
 *   get: (key: string) => Promise<string|null>,
 *   put: (key: string, value: string, options?: {expirationTtl?: number}) => Promise<void>,
 *   delete: (key: string) => Promise<void>,
 *   list: (options?: {prefix?: string, cursor?: string, limit?: number}) => Promise<{keys: Array<{name: string}>, list_complete: boolean, cursor: string}>,
 *   _store: Map,
 *   _advanceTime: (ms: number) => void,
 * }}
 */
export function createMockKV() {
    /**
     * 內部儲存：Map<key, { value: string, expiresAt: number|null }>
     * expiresAt 為 null 代表永不過期。
     */
    const store = new Map();

    /**
     * 模擬時鐘偏移（毫秒）。透過 _advanceTime() 調整，用於測試過期情境。
     */
    let timeOffset = 0;

    /** 取得目前模擬時間（毫秒） */
    function now() {
        return Date.now() + timeOffset;
    }

    /** 判斷某個 entry 是否已過期 */
    function isExpired(entry) {
        return entry.expiresAt !== null && now() >= entry.expiresAt;
    }

    return {
        /** 暴露內部 store，方便測試直接檢查狀態（非正式 API） */
        _store: store,

        /**
         * 模擬時間前進（毫秒）。可在測試中使用以觸發 TTL 過期。
         * 例如：kv._advanceTime(120_000) 前進 120 秒。
         *
         * @param {number} ms - 前進的毫秒數
         */
        _advanceTime(ms) {
            timeOffset += ms;
        },

        /**
         * 讀取 KV 值。若 key 不存在或已過期，回傳 null。
         *
         * @param {string} key
         * @returns {Promise<string|null>}
         */
        async get(key, options = {}) {
            const entry = store.get(key);
            if (!entry || isExpired(entry)) return null;
            // 真實 KV 在 { type: 'json' } 時會自己 parse，parse 失敗回 null。
            // 少了這段，每個用到 type:'json' 的測試都得自己再包一層 wrapper。
            const type = typeof options === 'string' ? options : options.type;
            if (type === 'json') {
                try { return JSON.parse(entry.value); } catch { return null; }
            }
            return entry.value;
        },

        /**
         * 寫入 KV 值，可選擇設定 TTL（秒）。
         *
         * @param {string} key
         * @param {string} value
         * @param {{ expirationTtl?: number }} [options]
         * @returns {Promise<void>}
         */
        async put(key, value, options = {}) {
            // eslint-disable-next-line eqeqeq
            const expiresAt = options.expirationTtl != null
                ? now() + options.expirationTtl * 1000
                : null;
            store.set(key, { value, expiresAt });
        },

        /**
         * 刪除 KV 值。若 key 不存在，不報錯（與真實 KV 行為一致）。
         *
         * @param {string} key
         * @returns {Promise<void>}
         */
        async delete(key) {
            store.delete(key);
        },

        /**
         * 列出 KV key（支援 prefix 過濾與 cursor 分頁）。
         *
         * 回傳格式與真實 Cloudflare KV 相同：
         *   { keys: [{ name }], list_complete: boolean, cursor: string }
         *
         * cursor 實作：使用 base64 編碼的 offset 數字，以字串傳遞。
         * limit 預設為 1000（與 Cloudflare 預設一致）。
         *
         * @param {{ prefix?: string, cursor?: string, limit?: number }} [options]
         * @returns {Promise<{ keys: Array<{name: string}>, list_complete: boolean, cursor: string }>}
         */
        async list(options = {}) {
            const prefix = options.prefix || '';
            const limit = options.limit || 1000;
            const cursorOffset = options.cursor
                ? parseInt(Buffer.from(options.cursor, 'base64').toString('utf8'), 10)
                : 0;

            // 收集所有符合條件且未過期的 key，並排序（與 KV 的字典序一致）
            const allKeys = [...store.keys()]
                .filter(k => k.startsWith(prefix) && !isExpired(store.get(k)))
                .sort();

            const page = allKeys.slice(cursorOffset, cursorOffset + limit);
            const nextOffset = cursorOffset + page.length;
            // eslint-disable-next-line camelcase
            const list_complete = nextOffset >= allKeys.length;
            // eslint-disable-next-line camelcase
            const cursor = list_complete
                ? ''
                : Buffer.from(String(nextOffset)).toString('base64');

            return {
                keys: page.map(name => ({ name })),
                // eslint-disable-next-line camelcase
                list_complete,
                cursor,
            };
        },
    };
}
