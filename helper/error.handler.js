/**
 * ErrorHandler - 統一錯誤處理模組
 */
import { toast } from './toast.js';

export const ErrorTypes = {
    NETWORK: 'network',
    UNAUTHORIZED: 'unauthorized',
    FORBIDDEN: 'forbidden',
    NOT_FOUND: 'notfound',
    VALIDATION: 'validation',
    SERVER: 'server',
    TIMEOUT: 'timeout',
    BUSINESS: 'business',
    UNKNOWN: 'unknown'
};

const ERROR_MESSAGES = {
    [ErrorTypes.NETWORK]: {
        title: '網路連線問題',
        message: '無法連接到伺服器，請檢查網路連線。',
        suggestion: '請檢查您的網路連線，然後重試。'
    },
    [ErrorTypes.UNAUTHORIZED]: {
        title: '需要登入',
        message: '您的登入已過期或無效。',
        suggestion: '請重新登入後再試。'
    },
    [ErrorTypes.FORBIDDEN]: {
        title: '沒有權限',
        message: '您沒有權限執行此操作。',
        suggestion: '請聯繫管理員取得權限。'
    },
    [ErrorTypes.NOT_FOUND]: {
        title: '找不到資源',
        message: '請求的資源不存在或已被刪除。',
        suggestion: '請確認網址正確，或返回上一頁。'
    },
    [ErrorTypes.VALIDATION]: {
        title: '資料驗證失敗',
        message: '提交的資料格式不正確。',
        suggestion: '請檢查輸入的資料後重試。'
    },
    [ErrorTypes.SERVER]: {
        title: '伺服器錯誤',
        message: '伺服器發生內部錯誤。',
        suggestion: '請稍後再試，若持續發生請聯繫客服。'
    },
    [ErrorTypes.TIMEOUT]: {
        title: '請求逾時',
        message: '伺服器回應時間過長。',
        suggestion: '請檢查網路連線，然後重試。'
    },
    [ErrorTypes.BUSINESS]: {
        title: '操作失敗',
        message: '無法完成此操作。'
    },
    [ErrorTypes.UNKNOWN]: {
        title: '發生錯誤',
        message: '發生未知錯誤。',
        suggestion: '請重試，若持續發生請聯繫客服。'
    }
};

export class ErrorHandler {
    /**
     * 分類並展示錯誤訊息給用戶
     * 
     * @param {Error|Response|object|string} error - 錯誤物件或訊息
     * @param {string} [context=''] - 發生錯誤的情境或模組名稱
     * @param {object} [options={}] - 選項 (showToast, logToConsole)
     * @returns {object} 分類後的 errorInfo 物件
     * 
     * Pre-conditions:
     * - error 不可為空
     * Post-conditions:
     * - 記錄錯誤到 Console 並根據設定顯示 Toast 通知，回傳標準化錯誤資訊
     */
    static handle(error, context = '', options = {}) {
        const { showToast = true, logToConsole = true } = options;
        const errorInfo = this.classify(error);

        if (logToConsole) {
            console.error(`❌ [${context || 'Error'}]`, {
                type: errorInfo.type,
                message: errorInfo.message,
                originalError: error
            });
        }

        if (showToast) {
            const displayMessage = context ? `${context}: ${errorInfo.message}` : errorInfo.message;
            if ([ErrorTypes.UNAUTHORIZED, ErrorTypes.VALIDATION, ErrorTypes.BUSINESS].includes(errorInfo.type)) {
                toast.warning(displayMessage);
            } else {
                toast.error(displayMessage);
            }
        }

        return errorInfo;
    }

    /**
     * 根據錯誤型態分類
     * 
     * @param {any} error - 原始錯誤物件
     * @returns {object} 包含 type 與 message 的錯誤資訊
     * 
     * Pre-conditions:
     * - 無特別限制
     * Post-conditions:
     * - 回傳合法的分類物件
     */
    static classify(error) {
        if (error instanceof Response || error?.status) return this.classifyHttpError(error);

        if (error instanceof TypeError && error.message.includes('fetch')) {
            return {
                type: ErrorTypes.NETWORK,
                message: ERROR_MESSAGES[ErrorTypes.NETWORK].message
            };
        }

        if (error.name === 'AbortError' || error.message?.includes('timeout')) {
            return {
                type: ErrorTypes.TIMEOUT,
                message: ERROR_MESSAGES[ErrorTypes.TIMEOUT].message
            };
        }

        return {
            type: ErrorTypes.BUSINESS,
            message: error.message || (typeof error === 'string' ? error : '發生非預期錯誤')
        };
    }

    static classifyHttpError(response) {
        const status = response.status;
        const mapping = {
            401: ErrorTypes.UNAUTHORIZED,
            403: ErrorTypes.FORBIDDEN,
            404: ErrorTypes.NOT_FOUND,
            400: ErrorTypes.VALIDATION,
            500: ErrorTypes.SERVER
        };
        const type = mapping[status] || ErrorTypes.UNKNOWN;
        return {
            type,
            message: ERROR_MESSAGES[type]?.message || `HTTP 錯誤 ${status}`
        };
    }
}

/**
 * 設定全域的錯誤攔截處理器
 * 
 * Pre-conditions:
 * - window 物件存在
 * Post-conditions:
 * - 系統未捕捉的 promise rejection 或 error 都由 ErrorHandler 接手
 */
export function setupGlobalErrorHandlers() {
    window.addEventListener('unhandledrejection', (e) => {
        ErrorHandler.handle(e.reason, '未處理的請求失敗', { showToast: false });
    });
    window.addEventListener('error', (e) => {
        ErrorHandler.handle(e.error, '腳本執行錯誤', { showToast: false });
    });
}

// 導出快捷方法
export const handleError = ErrorHandler.handle.bind(ErrorHandler);
