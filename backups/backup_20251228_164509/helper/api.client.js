/**
 * ApiClient - 統一 API 客戶端
 * 
 * 功能：
 * - 自動加入 X-User-Id 和其他必要 Headers
 * - 自動 JSON 解析和錯誤處理
 * - 整合 ErrorHandler 顯示錯誤訊息
 * - 支援 FormData 檔案上傳
 * - 請求逾時處理
 */

import { getUserId, apiBase } from './state.js';
import { ErrorHandler, ErrorTypes } from './error.handler.js';

/**
 * 預設配置
 */
const DEFAULT_CONFIG = {
    timeout: 30000,  // 30 秒
    showErrorToast: true,
    retries: 0
};

/**
 * ApiClient 類別
 */
export class ApiClient {
    /**
     * 發送 GET 請求
     * @param {string} endpoint - API 端點（例如：'/richmenu/list'）
     * @param {Object} options - 選項
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async get(endpoint, options = {}) {
        return this.request('GET', endpoint, null, options);
    }

    /**
     * 發送 POST 請求
     * @param {string} endpoint - API 端點
     * @param {Object|FormData} body - 請求內容
     * @param {Object} options - 選項
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async post(endpoint, body = {}, options = {}) {
        return this.request('POST', endpoint, body, options);
    }

    /**
     * 發送 PUT 請求
     * @param {string} endpoint - API 端點
     * @param {Object|FormData} body - 請求內容
     * @param {Object} options - 選項
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async put(endpoint, body = {}, options = {}) {
        return this.request('PUT', endpoint, body, options);
    }

    /**
     * 發送 DELETE 請求
     * @param {string} endpoint - API 端點
     * @param {Object} options - 選項
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async delete(endpoint, options = {}) {
        return this.request('DELETE', endpoint, null, options);
    }

    /**
     * 發送 PATCH 請求
     * @param {string} endpoint - API 端點
     * @param {Object} body - 請求內容
     * @param {Object} options - 選項
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async patch(endpoint, body = {}, options = {}) {
        return this.request('PATCH', endpoint, body, options);
    }

    /**
     * 核心請求方法
     * @param {string} method - HTTP 方法
     * @param {string} endpoint - API 端點
     * @param {Object|FormData|null} body - 請求內容
     * @param {Object} options - 選項
     * @returns {Promise<any>}
     */
    static async request(method, endpoint, body, options = {}) {
        const config = { ...DEFAULT_CONFIG, ...options };
        const {
            timeout,
            showErrorToast,
            context,
            customHeaders,
            skipAuth,
            rawResponse,  // 如果 true，返回原始 Response 而非 JSON
            retries
        } = config;

        // 構建完整 URL
        const url = endpoint.startsWith('http') ? endpoint : `${apiBase}${endpoint}`;

        // 構建 Headers
        const headers = this.buildHeaders(body, customHeaders, skipAuth);

        // 構建請求選項
        const fetchOptions = {
            method,
            headers
        };

        // 添加 body（如果有）
        if (body) {
            if (body instanceof FormData) {
                fetchOptions.body = body;
                // FormData 時移除 Content-Type，讓瀏覽器自動設定 boundary
                delete headers['Content-Type'];
            } else {
                fetchOptions.body = JSON.stringify(body);
            }
        }

        // 建立 AbortController 用於逾時
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        fetchOptions.signal = controller.signal;

        try {
            const response = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);

            // 如果需要原始 Response
            if (rawResponse) {
                return response;
            }

            // 處理非成功回應
            if (!response.ok) {
                await this.handleErrorResponse(response, context || endpoint, showErrorToast);
                throw response;
            }

            // 檢查是否有內容
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            }

            // 非 JSON 回應
            return await response.text();

        } catch (error) {
            clearTimeout(timeoutId);

            // 處理逾時
            if (error.name === 'AbortError') {
                const timeoutError = {
                    type: ErrorTypes.TIMEOUT,
                    message: '請求逾時，請稍後再試'
                };
                if (showErrorToast) {
                    ErrorHandler.handle(timeoutError, context || endpoint);
                }
                throw timeoutError;
            }

            // 如果是 Response 對象（已處理的錯誤），直接拋出
            if (error instanceof Response) {
                throw error;
            }

            // 處理網路錯誤
            if (showErrorToast) {
                ErrorHandler.handle(error, context || endpoint);
            }
            throw error;
        }
    }

    /**
     * 構建請求 Headers
     * @param {Object|FormData|null} body - 請求內容
     * @param {Object} customHeaders - 自訂 Headers
     * @param {boolean} skipAuth - 是否跳過認證 Header
     * @returns {Object}
     */
    static buildHeaders(body, customHeaders = {}, skipAuth = false) {
        const headers = {};

        // 加入 Content-Type（非 FormData 時）
        if (body && !(body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        // 加入認證 Header
        if (!skipAuth) {
            const userId = getUserId();
            if (userId) {
                headers['X-User-Id'] = userId;
            }
        }

        // 合併自訂 Headers
        return { ...headers, ...customHeaders };
    }

    /**
     * 處理錯誤回應
     * @param {Response} response - HTTP Response
     * @param {string} context - 操作上下文
     * @param {boolean} showToast - 是否顯示 Toast
     */
    static async handleErrorResponse(response, context, showToast) {
        let errorData = {};

        try {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                errorData = await response.json();
            } else {
                errorData = { message: await response.text() };
            }
        } catch (e) {
            // 無法解析錯誤內容
        }

        const error = {
            status: response.status,
            statusText: response.statusText,
            ...errorData
        };

        if (showToast) {
            ErrorHandler.handle(error, context);
        }
    }

    /**
     * 上傳檔案（便捷方法）
     * @param {string} endpoint - API 端點
     * @param {File|Blob} file - 檔案
     * @param {string} fieldName - 表單欄位名稱
     * @param {Object} extraData - 額外資料
     * @param {Object} options - 選項
     * @returns {Promise<any>}
     */
    static async upload(endpoint, file, fieldName = 'file', extraData = {}, options = {}) {
        const formData = new FormData();
        formData.append(fieldName, file);

        // 添加額外資料
        Object.entries(extraData).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                formData.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
            }
        });

        return this.post(endpoint, formData, {
            ...options,
            timeout: options.timeout || 60000  // 上傳預設 60 秒
        });
    }

    /**
     * 並行請求多個 API
     * @param {Array<{method: string, endpoint: string, body?: any, options?: Object}>} requests
     * @returns {Promise<Array<{success: boolean, data?: any, error?: any}>>}
     */
    static async parallel(requests) {
        const promises = requests.map(async ({ method, endpoint, body, options }) => {
            try {
                const data = await this.request(method, endpoint, body, {
                    ...options,
                    showErrorToast: false  // 並行請求時不逐一顯示 Toast
                });
                return { success: true, data };
            } catch (error) {
                return { success: false, error };
            }
        });

        return Promise.all(promises);
    }
}

// 導出便捷函數
export const api = {
    get: ApiClient.get.bind(ApiClient),
    post: ApiClient.post.bind(ApiClient),
    put: ApiClient.put.bind(ApiClient),
    patch: ApiClient.patch.bind(ApiClient),
    delete: ApiClient.delete.bind(ApiClient),
    upload: ApiClient.upload.bind(ApiClient),
    parallel: ApiClient.parallel.bind(ApiClient)
};

// 導出預設值
export default ApiClient;
