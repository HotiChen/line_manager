/**
 * @fileoverview Modal 對話框 Helper
 * @description 提供統一的確認對話框，替換原生 confirm()
 * @author Antigravity AI
 * @since 2025-12-24
 */

import { setInnerHTML, escapeHTML } from './security.js';

/**
 * 組出確認對話框的 HTML。
 *
 * 所有文字欄位（title / message / 按鈕文字）一律跳脫：呼叫端會傳入使用者可控的資料
 * （LINE 顯示名稱、標籤名稱…）。DOMPurify 雖會擋掉腳本，但仍放行連結、圖片與版面，
 * 而且它是從 CDN 載入的。訊息裡的換行靠 white-space: pre-line 顯示，不需要 HTML。
 * type 走白名單，不直接插進 class。
 *
 * 純函式（不碰 DOM），可在 node 下測試。
 *
 * @param {{modalId: string, title: string, message: string, confirmText: string, cancelText: string, type: string}} opts
 * @returns {string}
 */
export function buildConfirmModalHTML({ modalId, title, message, confirmText, cancelText, type }) {
    const buttonClass = {
        danger: 'btn-danger',
        warning: 'btn-warning',
        info: 'btn-info'
    }[type] || 'btn-warning';

    return `
      <div class="modal fade" id="${modalId}" tabindex="-1" aria-labelledby="${modalId}Label" aria-hidden="true" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="${modalId}Label">${escapeHTML(title)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <p style="white-space: pre-line;">${escapeHTML(message)}</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" data-action="cancel">
                ${escapeHTML(cancelText)}
              </button>
              <button type="button" class="btn ${buttonClass}" data-action="confirm" autofocus>
                ${escapeHTML(confirmText)}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
}

/**
 * 顯示確認對話框
 * @param {Object} options - 配置選項
 * @param {string} [options.title='確認操作'] - 對話框標題
 * @param {string} options.message - 對話框訊息內容
 * @param {string} [options.confirmText='確定'] - 確認按鈕文字
 * @param {string} [options.cancelText='取消'] - 取消按鈕文字
 * @param {string} [options.type='warning'] - 類型：'danger', 'warning', 'info'
 * @returns {Promise<boolean>} - true: 使用者點擊確認, false: 使用者點擊取消
 * 
 * @example
 * const confirmed = await showConfirm({
 *   title: '刪除確認',
 *   message: '確定要刪除這個項目嗎？',
 *   type: 'danger'
 * });
 * if (confirmed) {
 *   // 執行刪除操作
 * }
 * 
 * Pre-conditions:
 * - 系統必須載入 Bootstrap JS，且 document.body 存在
 * Post-conditions:
 * - 在 DOM 插入對話框並於操作後自動清理
 */
export function showConfirm({
    title = '確認操作',
    message,
    confirmText = '確定',
    cancelText = '取消',
    type = 'warning'
} = {}) {
    return new Promise((resolve) => {
        // 生成唯一 ID
        const modalId = `confirm-modal-${Date.now()}`;

        // 創建 Modal HTML（所有文字欄位在 buildConfirmModalHTML 內跳脫）
        const modalHTML = buildConfirmModalHTML({ modalId, title, message, confirmText, cancelText, type });

        // 創建臨時容器並插入 Modal
        const container = document.createElement('div');
        setInnerHTML(container, modalHTML);
        document.body.appendChild(container);

        // 獲取 Modal 元素
        const modalElement = container.querySelector(`#${modalId}`);
        const confirmBtn = modalElement.querySelector('[data-action="confirm"]');
        const cancelBtn = modalElement.querySelector('[data-action="cancel"]');

        // 創建 Bootstrap Modal 實例
        const modal = new bootstrap.Modal(modalElement, {
            backdrop: 'static',
            keyboard: true
        });

        // 處理確認
        const handleConfirm = () => {
            modal.hide();
            // 清理 backdrop
            setTimeout(() => {
                document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.removeProperty('overflow');
                document.body.style.removeProperty('padding-right');
            }, 300);
            resolve(true);
        };

        // 處理取消
        const handleCancel = () => {
            modal.hide();
            // 清理 backdrop
            setTimeout(() => {
                document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.removeProperty('overflow');
                document.body.style.removeProperty('padding-right');
            }, 300);
            resolve(false);
        };

        // 綁定按鈕事件
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);

        // 鍵盤支援：Enter = 確認
        modalElement.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
            }
        });

        // Modal 隱藏後清理 DOM
        modalElement.addEventListener('hidden.bs.modal', () => {
            // 延遲移除以確保動畫完成
            setTimeout(() => {
                container.remove();
            }, 150);
        });

        // 顯示 Modal
        modal.show();

        // 聚焦確認按鈕
        modalElement.addEventListener('shown.bs.modal', () => {
            confirmBtn.focus();
        });
    });
}

/**
 * 快捷方法：顯示危險操作確認對話框（紅色）
 * @param {string} message - 訊息內容
 * @param {string} [title='警告'] - 標題
 * @returns {Promise<boolean>}
 * 
 * Pre-conditions: 系統已載入 Bootstrap JS
 * Post-conditions: 顯示 danger 類型的 Modal
 */
export function confirmDanger(message, title = '警告') {
    return showConfirm({
        title,
        message,
        type: 'danger',
        confirmText: '確定',
        cancelText: '取消'
    });
}

/**
 * 快捷方法：顯示一般確認對話框（黃色）
 * @param {string} message - 訊息內容
 * @param {string} [title='確認'] - 標題
 * @returns {Promise<boolean>}
 * 
 * Pre-conditions: 系統已載入 Bootstrap JS
 * Post-conditions: 顯示 warning 類型的 Modal
 */
export function confirmWarning(message, title = '確認') {
    return showConfirm({
        title,
        message,
        type: 'warning',
        confirmText: '確定',
        cancelText: '取消'
    });
}

/**
 * 快捷方法：顯示資訊確認對話框（藍色）
 * @param {string} message - 訊息內容
 * @param {string} [title='提示'] - 標題
 * @returns {Promise<boolean>}
 * 
 * Pre-conditions: 系統已載入 Bootstrap JS
 * Post-conditions: 顯示 info 類型的 Modal
 */
export function confirmInfo(message, title = '提示') {
    return showConfirm({
        title,
        message,
        type: 'info',
        confirmText: '確定',
        cancelText: '取消'
    });
}
