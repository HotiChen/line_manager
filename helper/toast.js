/**
 * Toast Notification Utility - 基於 Bootstrap 的通知模組
 */

/**
 * showToast
 * 顯示 Toast 通知
 * 
 * Pre-conditions: 需在 DOM 中存在 #toast-container
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
 * ButtonLoader
 * 管理按鈕的 Loading 狀態（旋轉圖示與停用）
 */
export class ButtonLoader {
    constructor(element) {
        this.btn = element;
        this.oldHTML = element.innerHTML;
    }
    start(text = '處理中...') {
        this.btn.disabled = true;
        this.btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span> ${text}`;
    }
    stop() {
        this.btn.disabled = false;
        this.btn.innerHTML = this.oldHTML;
    }
}
