/**
 * Toast Notification Utility
 * Simple, Bootstrap-based toast notifications to replace alert()
 */

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - The type of toast: 'success', 'error', 'warning', 'info'
 * @param {number} duration - Auto-hide duration in milliseconds (default: 4000)
 */
export function showToast(message, type = 'info', duration = 4000) {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        console.error('Toast container not found');
        return;
    }

    // ✅ 限制最多顯示 2 個 Toast
    const existingToasts = toastContainer.querySelectorAll('.toast');
    const MAX_TOASTS = 2;

    // 如果已經有 2 個，移除最舊的
    if (existingToasts.length >= MAX_TOASTS) {
        const oldestToast = existingToasts[0];
        oldestToast.remove();
    }

    // Create unique ID for this toast
    const toastId = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Icon and title mapping
    const toastConfig = {
        success: { title: '成功', icon: '✓' },
        error: { title: '錯誤', icon: '✗' },
        warning: { title: '警告', icon: '⚠' },
        info: { title: '提示', icon: 'ℹ' }
    };

    const config = toastConfig[type] || toastConfig.info;

    // Create toast HTML
    const toastHTML = `
    <div id="${toastId}" class="toast toast-${type} toast-new" role="alert" aria-live="assertive" aria-atomic="true">
      <div class="toast-header">
        <strong class="me-auto">${config.icon} ${config.title}</strong>
        <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
      <div class="toast-body">
        ${message}
      </div>
    </div>
  `;

    // ✅ 將之前的 Toast 縮小 25%
    const previousToasts = toastContainer.querySelectorAll('.toast');
    previousToasts.forEach(toast => {
        toast.classList.remove('toast-new');
        toast.classList.add('toast-old');
    });

    // Insert toast into container
    toastContainer.insertAdjacentHTML('beforeend', toastHTML);

    // Get the toast element and initialize Bootstrap Toast
    const toastElement = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastElement, {
        autohide: true,
        delay: duration
    });

    // Show the toast
    toast.show();

    // Remove from DOM after it's hidden
    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();

        // ✅ 如果移除後只剩一個，將它恢復到原始大小
        const remainingToasts = toastContainer.querySelectorAll('.toast');
        if (remainingToasts.length === 1) {
            remainingToasts[0].classList.remove('toast-old');
            remainingToasts[0].classList.add('toast-new');
        }
    });

    // ✅ Toast 展開/收起功能
    setupToastStackInteraction(toastContainer);
}

/**
 * 設置 Toast 堆疊展開/收起互動
 */
function setupToastStackInteraction(toastContainer) {
    // 避免重複綁定
    if (toastContainer.dataset.interactionSetup) return;
    toastContainer.dataset.interactionSetup = 'true';

    let isExpanded = false;

    // 點擊展開
    toastContainer.addEventListener('mousedown', () => {
        const toasts = toastContainer.querySelectorAll('.toast');
        if (toasts.length > 1) {
            isExpanded = true;
            toastContainer.classList.add('toast-stack-expanded');
        }
    });

    // 放開收起
    const collapse = () => {
        if (isExpanded) {
            isExpanded = false;
            toastContainer.classList.remove('toast-stack-expanded');
        }
    };

    toastContainer.addEventListener('mouseup', collapse);
    toastContainer.addEventListener('mouseleave', collapse);
}

/**
 * Convenience methods for different toast types
 */
export const toast = {
    success: (message, duration) => showToast(message, 'success', duration),
    error: (message, duration) => showToast(message, 'error', duration),
    warning: (message, duration) => showToast(message, 'warning', duration),
    info: (message, duration) => showToast(message, 'info', duration)
};

/**
 * Button Loading State Management
 */
export class ButtonLoader {
    constructor(buttonElement) {
        this.button = buttonElement;
        this.originalHTML = buttonElement.innerHTML;
        this.originalDisabled = buttonElement.disabled;
    }

    start(loadingText = '處理中...') {
        this.button.disabled = true;
        this.button.classList.add('btn-loading');
        this.button.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span> ${loadingText}`;
    }

    stop() {
        this.button.disabled = this.originalDisabled;
        this.button.classList.remove('btn-loading');
        this.button.innerHTML = this.originalHTML;
    }
}

/**
 * Helper function to wrap async button actions with loading state
 * @param {HTMLButtonElement} button - The button element
 * @param {Function} asyncFunction - The async function to execute
 * @param {string} loadingText - Optional loading text
 * @returns {Promise} The result of the async function
 */
export async function withButtonLoading(button, asyncFunction, loadingText = '處理中...') {
    const loader = new ButtonLoader(button);
    loader.start(loadingText);

    try {
        const result = await asyncFunction();
        return result;
    } finally {
        loader.stop();
    }
}
