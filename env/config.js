// env/config.js
const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
// 非本機一律打 prod worker（pinti-line）。
//
// 這裡原本指向 pinti-line-dev —— 也就是線上後台實際打的是 dev worker。
// 那台的 vars 帶 AUTH_MODE=legacy（接受自報的 X-User-Id），而它 2026-02 部署時
// 綁的還是正式 KV namespace，等於正式資料只隔著一個「知道 owner 的 userId」。
// prod worker 是 AUTH_MODE=liff、有 TOKEN_ENCRYPTION_KEY 的那一台。
//
// ⚠️ LINE console 的 LIFF endpoint URL 也要指向同一個位址，否則使用者載到的
// 仍然是 dev worker 上的舊前端。
//
// 正式位址是 imhoti.tw/lm（Worker Route，見 wrangler.jsonc）。前端與 API
// 由同一個 worker 在同一個網域下提供，所以是同源 —— 完全不需要 CORS，
// 這也是 lib/utils.js 的 CORS 預設能保持 fail-closed 的前提。
export const apiBase = isLocal ? "http://localhost:8787" : "https://imhoti.tw/lm";
export const debug = isLocal; // 只在本地開發時啟用 debug

// LIFF IDs（一個 Channel 可以有多個 LIFF App）
export const liffId = "1653928585-8Kkz0jnz";  // 管理後台用
export const liffIdMemberRegister = "1653928585-8Kkz0jnz";  // 測試用（暫時使用相同 ID，稍後請申請新的）

// ⚠️ 本地開發用 userId — 僅在 localhost 環境有效
// 正式環境一律透過 LIFF 登入取得 userId
export const testUserId = isLocal ? (localStorage.getItem('dev_test_userId') || '') : '';
