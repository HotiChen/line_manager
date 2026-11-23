// js/flow/designer/util.js
// Designer 各模組共用的小工具

/** 目前選的 bot（草稿依 bot 分開存） */
export function currentBot() {
    try { return localStorage.getItem('flow_designer_bot') || null; } catch { return null; }
}

export function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
