/**
 * Toast Notification Utility - 基於 Bootstrap 的通知模組
 */

/**
 * 顯示 Toast 通知
 * 
 * @param {string} message - 要顯示的訊息內容
 * @param {string} [type='info'] - 通知類型 ('success', 'error', 'warning', 'info')
 * @param {number} [duration=4000] - 顯示時間 (毫秒)
 * 
 * Pre-conditions:
 * - 需在 DOM 中存在 #toast-container
 * Post-conditions:
 * - 成功在畫面上暫時顯示一個 Toast，並在設定時間後自動銷毀
 */
export function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return console.error('找不到 #toast-container');

    // 限制堆疊數量
    const existing = container.querySelectorAll('.toast');
    if (existing.length >= 2) existing[0].remove();

    const id = `toast-${Date.now()}`;
    const mapping = {
        success: { title: '成功', icon: '✓' },
        error: { title: '錯誤', icon: '✗' },
        warning: { title: '警告', icon: '⚠' },
        info: { title: '提示', icon: 'ℹ' }
    };
    const config = mapping[type] || mapping.info;

    const html = `
    <div id="${id}" class="toast toast-${type}" role="alert">
      <div class="toast-header">
        <strong class="me-auto">${config.icon} ${config.title}</strong>
        <button type="button" class="btn-close" data-bs-dismiss="toast"></button>
      </div>
      <div class="toast-body">${message}</div>
    </div>`;

    container.insertAdjacentHTML('beforeend', html);
    const element = document.getElementById(id);
    const toastObj = new bootstrap.Toast(element, { autohide: true, delay: duration });
    toastObj.show();

    element.addEventListener('hidden.bs.toast', () => element.remove());
}

export const toast = {
    success: (m, d) => showToast(m, 'success', d),
    error: (m, d) => showToast(m, 'error', d),
    warning: (m, d) => showToast(m, 'warning', d),
    info: (m, d) => showToast(m, 'info', d)
};

/**
 * ButtonLoader 類別
 * 管理按鈕的 Loading 狀態（旋轉圖示與停用）
 * 
 * Pre-conditions:
 * - 傳入的 element 必須是一個有效的 HTMLButtonElement
 */
export class ButtonLoader {
    constructor(element) {
        if (!element) throw new Error('ButtonLoader requires a valid DOM element');
        this.btn = element;
        this.oldHTML = element.innerHTML;
    }
    /**
     * 啟動 Loading 狀態
     * @param {string} [text='處理中...'] - Loading 時顯示的文字
     *
     * Post-conditions:
     * - 按鈕被停用 (disabled = true) 且內容被替換為 Spinner
     */
    start(text = '處理中...') {
        this.btn.disabled = true;
        this.btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span> ${text}`;
    }

    /**
     * 停止 Loading 狀態並還原按鈕
     *
     * Post-conditions:
     * - 按鈕被啟用 (disabled = false) 且內容還原為原始狀態
     */
    stop() {
        this.btn.disabled = false;
        this.btn.innerHTML = this.oldHTML;
    }
}

/**
 * withButtonLoading
 * 包裝一個非同步操作：執行期間顯示按鈕 Loading 狀態，完成後自動還原。
 *
 * @param {HTMLButtonElement} button - 要顯示 Loading 的按鈕
 * @param {Function} asyncFn - 要執行的非同步函數
 * @param {string} [loadingText='處理中...'] - Loading 期間顯示的文字
 * @returns {Promise<any>} asyncFn 的回傳值
 */
export async function withButtonLoading(button, asyncFn, loadingText = '處理中...') {
    const loader = new ButtonLoader(button);
    loader.start(loadingText);
    try {
        return await asyncFn();
    } finally {
        loader.stop();
    }
}
