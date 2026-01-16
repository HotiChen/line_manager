/**
 * Error Handler - 統一錯誤處理模組
 * 
 * 功能：
 * - 分類錯誤類型（網路、權限、404、業務邏輯等）
 * - 顯示適當的錯誤訊息
 * - 支援錯誤恢復建議
 * - 記錄錯誤到 console
 */

import { toast } from './toast.js';

/**
 * 錯誤類型定義
 */
export const ErrorTypes = {
    NETWORK: 'network',        // 網路連線錯誤
    UNAUTHORIZED: 'unauthorized', // 401 未授權
    FORBIDDEN: 'forbidden',    // 403 禁止存取
    NOT_FOUND: 'notfound',     // 404 找不到
    VALIDATION: 'validation',  // 驗證錯誤
    SERVER: 'server',          // 500 伺服器錯誤
    TIMEOUT: 'timeout',        // 請求逾時
    BUSINESS: 'business',      // 業務邏輯錯誤
    UNKNOWN: 'unknown'         // 未知錯誤
};

/**
 * 錯誤訊息配置
 */
const errorMessages = {
    [ErrorTypes.NETWORK]: {
        title: '網路連線問題',
        message: '無法連接到伺服器，請檢查網路連線。',
        icon: 'bi-wifi-off',
        suggestion: '請檢查您的網路連線，然後重試。'
    },
    [ErrorTypes.UNAUTHORIZED]: {
        title: '需要登入',
        message: '您的登入已過期或無效。',
        icon: 'bi-person-x',
        suggestion: '請重新登入後再試。'
    },
    [ErrorTypes.FORBIDDEN]: {
        title: '沒有權限',
        message: '您沒有權限執行此操作。',
        icon: 'bi-shield-x',
        suggestion: '請聯繫管理員取得權限。'
    },
    [ErrorTypes.NOT_FOUND]: {
        title: '找不到資源',
        message: '請求的資源不存在或已被刪除。',
        icon: 'bi-question-circle',
        suggestion: '請確認網址正確，或返回上一頁。'
    },
    [ErrorTypes.VALIDATION]: {
        title: '資料驗證失敗',
        message: '提交的資料格式不正確。',
        icon: 'bi-exclamation-triangle',
        suggestion: '請檢查輸入的資料後重試。'
    },
    [ErrorTypes.SERVER]: {
        title: '伺服器錯誤',
        message: '伺服器發生內部錯誤。',
        icon: 'bi-server',
        suggestion: '請稍後再試，若持續發生請聯繫客服。'
    },
    [ErrorTypes.TIMEOUT]: {
        title: '請求逾時',
        message: '伺服器回應時間過長。',
        icon: 'bi-clock-history',
        suggestion: '請檢查網路連線，然後重試。'
    },
    [ErrorTypes.BUSINESS]: {
        title: '操作失敗',
        message: '無法完成此操作。',
        icon: 'bi-x-circle',
        suggestion: null  // 使用傳入的錯誤訊息
    },
    [ErrorTypes.UNKNOWN]: {
        title: '發生錯誤',
        message: '發生未知錯誤。',
        icon: 'bi-bug',
        suggestion: '請重試，若持續發生請聯繫客服。'
    }
};

/**
 * ErrorHandler 類別
 */
export class ErrorHandler {
    /**
     * 處理錯誤
     * @param {Error|Response|Object} error - 錯誤對象
     * @param {string} context - 錯誤發生的上下文（例如：「Flex 上傳」）
     * @param {Object} options - 選項
     * @param {boolean} options.showToast - 是否顯示 Toast 通知 (default: true)
     * @param {boolean} options.logToConsole - 是否記錄到 console (default: true)
     * @param {Function} options.onRetry - 重試回調函數
     */
    static handle(error, context = '', options = {}) {
        const {
            showToast = true,
            logToConsole = true,
            onRetry = null
        } = options;

        // 分類錯誤
        const errorInfo = this.classify(error);

        // 記錄到 console
        if (logToConsole) {
            console.error(`❌ [${context || 'Error'}]`, {
                type: errorInfo.type,
                message: errorInfo.message,
                originalError: error
            });
        }

        // 顯示 Toast
        if (showToast) {
            const config = errorMessages[errorInfo.type];
            const displayMessage = context
                ? `${context}: ${errorInfo.message}`
                : errorInfo.message;

            // 根據錯誤類型選擇 Toast 類型
            if (errorInfo.type === ErrorTypes.UNAUTHORIZED) {
                toast.warning(displayMessage);
            } else if (errorInfo.type === ErrorTypes.VALIDATION || errorInfo.type === ErrorTypes.BUSINESS) {
                toast.warning(displayMessage);
            } else {
                toast.error(displayMessage);
            }
        }

        return errorInfo;
    }

    /**
     * 分類錯誤
     * @param {Error|Response|Object} error - 錯誤對象
     * @returns {Object} - { type, message, suggestion }
     */
    static classify(error) {
        // HTTP Response 錯誤
        if (error instanceof Response || (error && typeof error.status === 'number')) {
            return this.classifyHttpError(error);
        }

        // TypeError - 通常是網路問題
        if (error instanceof TypeError && error.message.includes('fetch')) {
            return {
                type: ErrorTypes.NETWORK,
                message: errorMessages[ErrorTypes.NETWORK].message,
                suggestion: errorMessages[ErrorTypes.NETWORK].suggestion
            };
        }

        // Timeout error
        if (error.name === 'AbortError' || (error.message && error.message.includes('timeout'))) {
            return {
                type: ErrorTypes.TIMEOUT,
                message: errorMessages[ErrorTypes.TIMEOUT].message,
                suggestion: errorMessages[ErrorTypes.TIMEOUT].suggestion
            };
        }

        // 業務邏輯錯誤（有 message 的 Error）
        if (error instanceof Error) {
            return {
                type: ErrorTypes.BUSINESS,
                message: error.message,
                suggestion: null
            };
        }

        // 物件格式的錯誤 { error: 'xxx' } 或 { message: 'xxx' }
        if (error && typeof error === 'object') {
            const message = error.error || error.message || JSON.stringify(error);
            return {
                type: ErrorTypes.BUSINESS,
                message: message,
                suggestion: null
            };
        }

        // 字串錯誤
        if (typeof error === 'string') {
            return {
                type: ErrorTypes.BUSINESS,
                message: error,
                suggestion: null
            };
        }

        // 未知錯誤
        return {
            type: ErrorTypes.UNKNOWN,
            message: errorMessages[ErrorTypes.UNKNOWN].message,
            suggestion: errorMessages[ErrorTypes.UNKNOWN].suggestion
        };
    }

    /**
     * 分類 HTTP 錯誤
     * @param {Response|Object} response - HTTP Response 或包含 status 的物件
     * @returns {Object}
     */
    static classifyHttpError(response) {
        const status = response.status;

        if (status === 401) {
            return {
                type: ErrorTypes.UNAUTHORIZED,
                message: errorMessages[ErrorTypes.UNAUTHORIZED].message,
                suggestion: errorMessages[ErrorTypes.UNAUTHORIZED].suggestion
            };
        }

        if (status === 403) {
            return {
                type: ErrorTypes.FORBIDDEN,
                message: errorMessages[ErrorTypes.FORBIDDEN].message,
                suggestion: errorMessages[ErrorTypes.FORBIDDEN].suggestion
            };
        }

        if (status === 404) {
            return {
                type: ErrorTypes.NOT_FOUND,
                message: errorMessages[ErrorTypes.NOT_FOUND].message,
                suggestion: errorMessages[ErrorTypes.NOT_FOUND].suggestion
            };
        }

        if (status === 422 || status === 400) {
            return {
                type: ErrorTypes.VALIDATION,
                message: errorMessages[ErrorTypes.VALIDATION].message,
                suggestion: errorMessages[ErrorTypes.VALIDATION].suggestion
            };
        }

        if (status >= 500) {
            return {
                type: ErrorTypes.SERVER,
                message: errorMessages[ErrorTypes.SERVER].message,
                suggestion: errorMessages[ErrorTypes.SERVER].suggestion
            };
        }

        return {
            type: ErrorTypes.UNKNOWN,
            message: `HTTP 錯誤 ${status}`,
            suggestion: errorMessages[ErrorTypes.UNKNOWN].suggestion
        };
    }

    /**
     * 處理 fetch 請求並自動處理錯誤
     * @param {Promise<Response>} fetchPromise - fetch 返回的 Promise
     * @param {string} context - 操作上下文
     * @returns {Promise<any>} - 解析後的 JSON 資料
     */
    static async handleFetch(fetchPromise, context = '') {
        try {
            const response = await fetchPromise;

            if (!response.ok) {
                // 嘗試讀取錯誤訊息
                try {
                    const errorData = await response.json();
                    const error = { status: response.status, ...errorData };
                    this.handle(error, context);
                    throw error;
                } catch (e) {
                    if (e.status) throw e; // 重新拋出已處理的錯誤
                    this.handle(response, context);
                    throw response;
                }
            }

            return await response.json();
        } catch (error) {
            if (error instanceof Response || error.status) {
                throw error; // 已經處理過
            }
            this.handle(error, context);
            throw error;
        }
    }
}

/**
 * 設置全局錯誤捕獲
 * 應在 main.js 中調用
 */
export function setupGlobalErrorHandlers() {
    // 未處理的 Promise rejection
    window.addEventListener('unhandledrejection', (event) => {
        console.warn('⚠️ 未處理的 Promise 拒絕:', event.reason);
        ErrorHandler.handle(event.reason, '未處理的錯誤', { showToast: false });
        // 不阻止默認行為，讓錯誤仍然顯示在 console
    });

    // 全局 JavaScript 錯誤
    window.addEventListener('error', (event) => {
        console.warn('⚠️ 未捕獲的錯誤:', event.error);
        // 大多數情況下這些錯誤不需要顯示給用戶
        ErrorHandler.handle(event.error, '腳本錯誤', { showToast: false });
    });

}

// 導出快捷方法
export const handleError = ErrorHandler.handle.bind(ErrorHandler);
export const handleFetch = ErrorHandler.handleFetch.bind(ErrorHandler);
