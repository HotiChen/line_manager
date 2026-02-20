/**
 * State helper - 管理全域用戶狀態與配置項
 */
import * as config from '../env/config.js';

const state = {
    userId: null,
    currentProject: null
};

export function setUserId(id) {
    state.userId = id;
}

/**
 * getUserId
 * 擷取當前用戶 ID，支援 URL 參數與本地測試預設值。
 * 
 * Post-conditions:
 * - 回傳有效字串 ID 或 null
 */
export function getUserId() {
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('userId') || urlParams.get('testUserId');

    if (userId) {
        setUserId(userId);
        return userId;
    }

    if (!state.userId && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const defaultTestUserId = 'Ud66f9caf44c4d927ca4f9361d66ccc18';
        console.warn('⚠️ [State] 本地開發模式，使用預設 ID:', defaultTestUserId);
        return defaultTestUserId;
    }
    return state.userId;
}

export function setCurrentProject(project) { state.currentProject = project; }
export function getCurrentProject() { return state.currentProject; }

export const apiBase = config.apiBase;
export const debug = config.debug;
