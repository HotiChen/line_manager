/**
 * ApiClient - 統一 API 客戶端
 */
import { getUserId, apiBase, debug } from './state.js';
import { ErrorHandler, ErrorTypes } from './error.handler.js';

const DEFAULT_CONFIG = {
    timeout: 30000,
    showErrorToast: true,
    retries: 0
};

export class ApiClient {
    /**
     * 發送 HTTP 請求的核心方法，處理 Headers、逾時、JSON 解析與錯誤整合
     * 
     * @param {string} method - HTTP 動詞 (GET, POST, etc.)
     * @param {string} endpoint - API 端點或完整 URL
     * @param {object|FormData|null} body - 請求本體
     * @param {object} [options={}] - 額外設定 (timeout, showErrorToast, etc.)
     * @returns {Promise<any>} 解析後的回應資料
     * 
     * Pre-conditions:
     * - method 與 endpoint 必須是有效字串
     * Post-conditions:
     * - 成功：傳回解析後的 JSON 或原始 Response (若設定 rawResponse)
     * - 失敗：觸發 ErrorHandler 並抛出錯誤
     */
    static async request(method, endpoint, body, options = {}) {
        const config = { ...DEFAULT_CONFIG, ...options };
        const { timeout, showErrorToast, context, customHeaders, skipAuth, rawResponse } = config;

        const url = endpoint.startsWith('http') ? endpoint : `${apiBase}${endpoint}`;
        const headers = this.buildHeaders(body, customHeaders, skipAuth);

        const fetchOptions = { method, headers };
        if (body) {
            if (body instanceof FormData) {
                fetchOptions.body = body;
                // 由瀏覽器自動設定，不可手動設為 application/json
                delete headers['Content-Type'];
            } else {
                fetchOptions.body = JSON.stringify(body);
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        fetchOptions.signal = controller.signal;

        try {
            const response = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);

            if (rawResponse) return response;

            if (!response.ok) {
                await this.handleErrorResponse(response, context || endpoint, showErrorToast);
                const httpErr = new Error(`HTTP ${response.status}`);
                httpErr._isHttpError = true; // 已由 handleErrorResponse 處理過 toast，catch 不重複顯示
                throw httpErr;
            }

            // 204 No Content（如刪除操作）不呼叫 .json()，否則會丟出 SyntaxError
            if (response.status === 204) return null;

            const contentType = response.headers.get('content-type');
            return contentType?.includes('application/json') ? await response.json() : await response.text();

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                const timeoutErr = { type: ErrorTypes.TIMEOUT, message: '連線逾時' };
                if (showErrorToast) ErrorHandler.handle(timeoutErr, context || endpoint);
                throw timeoutErr;
            }
            // _isHttpError 代表已由 handleErrorResponse 顯示過 toast，避免重複彈出
            if (!error._isHttpError && showErrorToast) ErrorHandler.handle(error, context || endpoint);
            throw error;
        }
    }

    /**
     * 建構 HTTP 請求的 Headers
     * 
     * @param {object|FormData|null} body - 請求本體
     * @param {object} [customHeaders={}] - 自訂 Headers
     * @param {boolean} [skipAuth=false] - 是否跳過 Auth
     * @returns {object} 合併後的 Headers 物件
     * 
     * Pre-conditions: 
     * - 無特別限制
     * Post-conditions:
     * - 回傳包含 Content-Type 與 Auth 資訊的 Headers
     */
    static buildHeaders(body, customHeaders = {}, skipAuth = false) {
        const headers = (body && !(body instanceof FormData)) ? { 'Content-Type': 'application/json' } : {};
        if (!skipAuth) {
            // 優先使用 LIFF access token（正式環境，非 debug 模式）
            const isLocalHost = typeof window !== 'undefined' &&
                (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            if (!debug && !isLocalHost) { 
                try {
                    // eslint-disable-next-line no-undef
                    if (typeof liff !== 'undefined' && typeof liff.isLoggedIn === 'function' && liff.isLoggedIn()) {
                        const accessToken = liff.getAccessToken();
                        if (accessToken) {
                            headers['Authorization'] = `Bearer ${accessToken}`;
                        }
                    }
                } catch (e) {
                    // LIFF SDK 尚未 init 時的預期錯誤，靜默降級即可不阻擋請求
                    console.warn('⚠️ [ApiClient] LIFF 尚未初始化，自動降級使用 X-User-Id:', e.message);
                }
            }
            // 同時帶上 X-User-Id 作為回退（過渡期間）
            const userId = getUserId();
            if (userId) headers['X-User-Id'] = userId;
        }
        return { ...headers, ...customHeaders };
    }

    /**
     * 處理錯誤的 HTTP 回應
     * 
     * @param {Response} response - Fetch 回應物件
     * @param {string} context - 發生錯誤的情境
     * @param {boolean} showToast - 是否顯示錯誤提示
     * 
     * Pre-conditions:
     * - response 必須是 Fetch Response
     * Post-conditions:
     * - 解析錯誤內容並呼叫 ErrorHandler
     */
    static async handleErrorResponse(response, context, showToast) {
        let errorData = {};
        try {
            const contentType = response.headers.get('content-type');
            errorData = contentType?.includes('application/json') ? await response.json() : { message: await response.text() };
        } catch (e) { }

        const error = { status: response.status, ...errorData };
        if (showToast) ErrorHandler.handle(error, context);
    }

    // 便捷方法
    static get(endpoint, options) { return this.request('GET', endpoint, null, options); }
    static post(endpoint, body, options) { return this.request('POST', endpoint, body, options); }
    static put(endpoint, body, options) { return this.request('PUT', endpoint, body, options); }
    static delete(endpoint, body, options) { return this.request('DELETE', endpoint, body || null, options); }
    static async upload(endpoint, file, fieldName = 'file', extraData = {}, options = {}) {
        const formData = new FormData();
        formData.append(fieldName, file);
        Object.entries(extraData).forEach(([k, v]) => v != null && formData.append(k, typeof v === 'object' ? JSON.stringify(v) : v));
        return this.post(endpoint, formData, { ...options, timeout: options.timeout || 60000 });
    }

    /**
     * 平行發送多個請求，並攔截個別錯誤，不讓單一失敗導致全盤崩潰
     * 
     * @param {Array<{method: string, endpoint: string, body: any, options: object}>} requests - 請求陣列
     * @returns {Promise<Array<any>>} 回應結果陣列
     * 
     * Pre-conditions:
     * - requests 必須是陣列
     * Post-conditions:
     * - 回傳相同長度的陣列，成功為解析後結果，失敗為 { error: true, details: err } 物件
     */
    static async parallel(requests) {
        return Promise.all(
            requests.map(req =>
                this.request(req.method || 'GET', req.endpoint, req.body, req.options)
                    .catch(err => ({ error: true, details: err }))
            )
        );
    }
}

export const api = {
    get: ApiClient.get.bind(ApiClient),
    post: ApiClient.post.bind(ApiClient),
    put: ApiClient.put.bind(ApiClient),
    delete: ApiClient.delete.bind(ApiClient),
    upload: ApiClient.upload.bind(ApiClient),
    parallel: ApiClient.parallel.bind(ApiClient)
};

export default api; // Support both named and default imports
