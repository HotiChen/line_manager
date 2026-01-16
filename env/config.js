// js/config.js
//export const userId = "123456";
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
export const apiBase = isLocal ? "http://localhost:8787" : "https://pinti-line-dev.hotichen.workers.dev";
export const debug = true;

// LIFF IDs（一個 Channel 可以有多個 LIFF App）
export const liffId = "1653928585-8Kkz0jnz";  // 管理後台用
export const liffIdMemberRegister = "1653928585-8Kkz0jnz";  // 測試用（暫時使用相同 ID，稍後請申請新的）

export const testUserId = "Ud66f9caf44c4d927ca4f9361d66ccc18";
