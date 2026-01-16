// js/shared/loader.js
import { setInnerHTML } from "../../helper/security.js";

/**
 * 顯示一個全螢幕的載入動畫和文字。
 * 如果 overlay 不存在，會自動建立。
 * @param {string} text - 要顯示在 loader 下方的文字。
 */
export function showLoader(text = '讀取中...') {
    let overlay = document.getElementById('loader-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loader-overlay';
        setInnerHTML(overlay, `
            <div class="loader-spinner"></div>
            <div class="loader-text"></div>
        `);
        document.body.appendChild(overlay);
    }
    overlay.classList.remove('hidden');
    const textEl = overlay.querySelector('.loader-text');
    if (textEl) textEl.textContent = text;
}

/**
 * 隱藏全螢幕的載入動畫。
 */
export function hideLoader() {
    const overlay = document.getElementById('loader-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}
