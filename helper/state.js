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
    // 持久化到 localStorage，讓新分頁（如流程設計器）也能讀取
    // ⚠️ 不可用 sessionStorage — 它是 per-tab，新分頁無法存取
    try { localStorage.setItem('linebot_userId', id); } catch (e) {}
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

    // 從 localStorage 讀取（跨分頁共享，支援新分頁如流程設計器）
    if (!state.userId) {
        try {
            const stored = localStorage.getItem('linebot_userId');
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

/**
 * 清除當前用戶 ID，同步清除 localStorage（登出時使用）
 *
 * Post-conditions:
 * - state.userId 重設為 null
 * - localStorage 中的 userId 與 bot 選擇皆被清除
 */
export function clearUserId() {
    state.userId = null;
    try {
        localStorage.removeItem('linebot_userId');
        localStorage.removeItem('flow_designer_bot');
    } catch (e) {}
}

export const apiBase = config.apiBase;
export const debug = config.debug;

/**
 * 取得驗證用的請求標頭。
 *
 * Why:
 * - 後端預設只認 LIFF access token（Authorization: Bearer），不再信任自報的 X-User-Id。
 * - 只有本機開發（localhost）才會附帶 X-User-Id，對應後端 AUTH_MODE = "legacy"。
 *
 * Post-conditions:
 * - 正式環境：已登入 LIFF 則回傳 { Authorization }，否則回傳空物件
 * - 本機開發：額外回傳 { 'X-User-Id' }
 *
 * @returns {Object} headers
 */
export function getAuthHeaders() {
    const headers = {};
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    try {
        // eslint-disable-next-line no-undef
        if (typeof liff !== 'undefined' && typeof liff.isLoggedIn === 'function' && liff.isLoggedIn()) {
            // eslint-disable-next-line no-undef
            const accessToken = liff.getAccessToken();
            if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
        }
    } catch (e) {
        console.warn('⚠️ [State] LIFF 尚未初始化，無法取得 access token:', e.message);
    }
    if (isLocalHost) {
        const userId = getUserId();
        if (userId) headers['X-User-Id'] = userId;
    }
    return headers;
}
