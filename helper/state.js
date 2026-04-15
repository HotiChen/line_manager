/**
 * State helper - 管理全域用戶狀態與配置項
 */
import * as config from '../env/config.js';

const state = {
    userId: null,
    currentProject: null
};

/**
 * 設定當前用戶 ID
 * 
 * @param {string} id - 用戶 ID
 * 
 * Pre-conditions:
 * - id 必須是有效字串
 * Post-conditions:
 * - 全域 state.userId 被更新
 */
export function setUserId(id) {
    if (!id || typeof id !== 'string') {
        console.warn('⚠️ [State] 傳入的 userId 無效:', id);
        return;
    }
    state.userId = id;
    // 持久化到 sessionStorage，讓新分頁（如流程設計器）也能讀取
    try { sessionStorage.setItem('linebot_userId', id); } catch (e) {}
}

/**
 * 擷取當前用戶 ID，支援 URL 參數與本地測試預設值。
 * 
 * Pre-conditions:
 * - window.location 必須可以存取
 * Post-conditions:
 * - 回傳有效的字串 ID 或 null，如果從 URL 取得則會同步更新本地 state
 * 
 * @returns {string|null} 用戶 ID
 */
export function getUserId() {
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId') || urlParams.get('testUserId');

    if (userId) {
        setUserId(userId);
        return userId;
    }

    // 從 sessionStorage 讀取（支援新分頁，如流程設計器）
    if (!state.userId) {
        try {
            const stored = sessionStorage.getItem('linebot_userId');
            if (stored) { state.userId = stored; return stored; }
        } catch (e) {}
    }

    if (!state.userId && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const devUserId = config.testUserId || localStorage.getItem('dev_test_userId') || '';
        if (devUserId) {
            console.warn('⚠️ [State] 本地開發模式，使用 dev userId:', devUserId);
            return devUserId;
        }
        console.warn('⚠️ [State] 本地開發模式但未設定 dev userId。請在 localStorage 設定 dev_test_userId 或透過 LIFF 登入。');
        return null;
    }
    return state.userId;
}

/**
 * 設定當前的專案 ID
 * @param {string} project - 專案 ID
 * 
 * Pre-conditions:
 * - project 不能為空
 */
export function setCurrentProject(project) {
    if (!project) return;
    state.currentProject = project;
}

/**
 * 取得當前的專案 ID
 * @returns {string|null} 當前的專案 ID
 */
export function getCurrentProject() {
    return state.currentProject;
}

export const apiBase = config.apiBase;
export const debug = config.debug;
