/**
 * ApiClient - 統一 API 客戶端
 */
import { getUserId, apiBase } from './state.js';
import { ErrorHandler, ErrorTypes } from './error.handler.js';

const DEFAULT_CONFIG = {
    timeout: 30000,
    showErrorToast: true,
    retries: 0
};

export class ApiClient {
    /**
     * request
     * 核心發送方法，處理 Headers、逾時、JSON 解析與錯誤整合
     * 
     * Pre-conditions:
     * - method: HTTP 動詞
     * - endpoint: 相對或絕對路徑
     * - body: JSON 物件或 FormData
     * 
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
                throw response;
            }

            const contentType = response.headers.get('content-type');
            return contentType?.includes('application/json') ? await response.json() : await response.text();

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                const timeoutErr = { type: ErrorTypes.TIMEOUT, message: '連線逾時' };
                if (showErrorToast) ErrorHandler.handle(timeoutErr, context || endpoint);
                throw timeoutErr;
            }
            if (!(error instanceof Response) && showErrorToast) ErrorHandler.handle(error, context || endpoint);
            throw error;
        }
    }

    static buildHeaders(body, customHeaders = {}, skipAuth = false) {
        const headers = (body && !(body instanceof FormData)) ? { 'Content-Type': 'application/json' } : {};
        if (!skipAuth) {
            const userId = getUserId();
            if (userId) headers['X-User-Id'] = userId;
        }
        return { ...headers, ...customHeaders };
    }

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
    static delete(endpoint, options) { return this.request('DELETE', endpoint, null, options); }
    static async upload(endpoint, file, fieldName = 'file', extraData = {}, options = {}) {
        const formData = new FormData();
        formData.append(fieldName, file);
        Object.entries(extraData).forEach(([k, v]) => v != null && formData.append(k, typeof v === 'object' ? JSON.stringify(v) : v));
        return this.post(endpoint, formData, { ...options, timeout: options.timeout || 60000 });
    }
}

export const api = {
    get: ApiClient.get.bind(ApiClient),
    post: ApiClient.post.bind(ApiClient),
    put: ApiClient.put.bind(ApiClient),
    delete: ApiClient.delete.bind(ApiClient),
    upload: ApiClient.upload.bind(ApiClient)
};
