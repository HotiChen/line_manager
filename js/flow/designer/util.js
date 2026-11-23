// js/flow/designer/util.js
// Designer 各模組共用的小工具

/** 目前選的 bot（草稿依 bot 分開存） */
export function currentBot() {
    try { return localStorage.getItem('flow_designer_bot') || null; } catch { return null; }
}

/** 放進 HTML 屬性（value="..."）用：textContent→innerHTML 不會跳脫引號，屬性會被撐破 */
export function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
