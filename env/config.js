// env/config.js
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
export const apiBase = isLocal ? "http://localhost:8787" : "https://pinti-line-dev.hotichen.workers.dev";
export const debug = isLocal; // 只在本地開發時啟用 debug

// LIFF IDs（一個 Channel 可以有多個 LIFF App）
export const liffId = "1653928585-8Kkz0jnz";  // 管理後台用
export const liffIdMemberRegister = "1653928585-8Kkz0jnz";  // 測試用（暫時使用相同 ID，稍後請申請新的）

// ⚠️ 本地開發用 userId — 僅在 localhost 環境有效
// 正式環境一律透過 LIFF 登入取得 userId
export const testUserId = isLocal ? (localStorage.getItem('dev_test_userId') || '') : '';
