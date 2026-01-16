/**
 * @fileoverview 統一的 Loading 管理器
 * @description 支援多重 loading 狀態，避免不同操作的 loading 互相衝突
 * @author Antigravity AI
 * @since 2025-12-23
 */

import { setInnerHTML } from '../../helper/security.js';

/**
 * Loading 管理器
 * 支援同時顯示多個 loading，使用 key 區分
 */
export class LoadingManager {
    static instances = new Map();
    static currentGlobalKey = null;

    /**
     * 顯示 loading
     * @param {string} key - Loading 的唯一識別碼 (例如: 'richmenu-upload', 'flex-sync')
     * @param {string} message - 顯示的訊息
     */
    static show(key = 'global', message = '處理中...') {
        // 如果已經存在，只更新訊息
        if (this.instances.has(key)) {
            this.update(key, message);
            return;
        }

        // 建立 loading overlay
        const overlay = document.createElement('div');
        overlay.className = 'loading-overlay active';  // 直接加上 active
        overlay.dataset.loadingKey = key;

        setInnerHTML(overlay, `
      <div class="loading-spinner"></div>
      <p class="loading-message">${message}</p>
    `);

        document.body.appendChild(overlay);
        this.instances.set(key, {
            element: overlay,
            message: message,
            timestamp: Date.now()
        });

        // 記錄當前的全局 loading
        if (key === 'global') {
            this.currentGlobalKey = key;
        }
    }

    /**
     * 隱藏 loading
     * @param {string} key - Loading 的唯一識別碼
     */
    static hide(key = 'global') {
        const instance = this.instances.get(key);
        if (!instance) return;

        const { element } = instance;

        // Fade out animation
        element.classList.remove('active');

        setTimeout(() => {
            element.remove();
            this.instances.delete(key);

            if (key === this.currentGlobalKey) {
                this.currentGlobalKey = null;
            }
        }, 300); // Match CSS transition duration
    }

    /**
     * 更新 loading 訊息
     * @param {string} key - Loading 的唯一識別碼
     * @param {string} message - 新的訊息
     */
    static update(key = 'global', message) {
        const instance = this.instances.get(key);
        if (!instance) return;

        const { element } = instance;
        const messageEl = element.querySelector('.loading-message');
        if (messageEl) {
            messageEl.textContent = message;
            instance.message = message;
        }
    }

    /**
     * 隱藏所有 loading
     */
    static hideAll() {
        for (const key of this.instances.keys()) {
            this.hide(key);
        }
    }

    /**
     * 檢查是否有 loading 正在顯示
     * @param {string} key - (可選) 檢查特定的 loading
     * @returns {boolean}
     */
    static isShowing(key) {
        if (key) {
            return this.instances.has(key);
        }
        return this.instances.size > 0;
    }

    /**
     * 取得所有正在顯示的 loading keys
     * @returns {Array<string>}
     */
    static getActiveKeys() {
        return Array.from(this.instances.keys());
    }
}

/**
 * 向後相容：保留原有的 showLoader/hideLoader 函數
 * 這些函數內部使用 LoadingManager，使用 'global' key
 */
export function showLoader(text = '讀取中...') {
    LoadingManager.show('global', text);
}

export function hideLoader() {
    LoadingManager.hide('global');
}

// 自動清理：如果頁面卸載時還有 loading，自動清理
window.addEventListener('beforeunload', () => {
    LoadingManager.hideAll();
});
