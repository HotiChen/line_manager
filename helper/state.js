import * as config from '../env/config.js';

const state = {
    userId: null,
    currentProject: null
};

export function setUserId(id) {
    state.userId = id;
    if (config.debug) console.log('[State] User ID set to:', id);
}

export function getUserId() {
    // 優先檢查 URL 參數中的測試用戶 ID（用於測試環境）
    const urlParams = new URLSearchParams(window.location.search);

    // 支援 ?userId= 和 ?testUserId= 兩種格式（userId 優先）
    const userId = urlParams.get('userId') || urlParams.get('testUserId');
    if (userId) {
        console.log('[State] Using userId from URL:', userId);
        // 強制設定到 state 中
        setUserId(userId);
        return userId;
    }

    // 如果是本地測試且沒有 userId，使用預設測試 ID
    if (!state.userId && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        const defaultTestUserId = 'Ud66f9caf44c4d927ca4f9361d66ccc18';
        console.warn('[State] No userId set, using default test userId:', defaultTestUserId);
        return defaultTestUserId;
    }
    return state.userId;
}

export function setCurrentProject(project) {
    state.currentProject = project;
    if (config.debug) console.log('[State] Current Project set to:', project);
}

export function getCurrentProject() {
    return state.currentProject;
}

export const apiBase = config.apiBase;
export const debug = config.debug;
