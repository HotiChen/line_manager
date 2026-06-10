// init_cloud_data.js
const fetch = require('node-fetch');

const API_BASE = 'http://localhost:8787';
// ⚠️ 開發腳本：請替換為你自己的 LINE userId，或透過環境變數設定
const OWNER_ID = process.env.LINE_OWNER_ID || 'YOUR_LINE_USER_ID';

async function init() {
    console.log('🚀 開始初始化雲端數據...');

    // 1. 檢查是否已有數據
    try {
        const res = await fetch(`${API_BASE}/team/members`, {
            headers: { 'X-User-Id': OWNER_ID }
        });
        const data = await res.json();

        if (data.success) {
            console.log('✅ 數據已存在，跳過初始化');
            console.log('當前成員:', data.members.length);
            return;
        }
    } catch (e) {
        console.log('⚠️ 無法連接 API，請確保 Worker 已啟動');
        return;
    }

    // 2. 如果沒有數據，這裡需要手動觸發遷移或創建
    // 由於我們沒有直接的 API 來"初始化"，我們可能需要依賴 migration 腳本
    // 或者直接使用 wrangler kv:key put

    console.log('ℹ️ 請運行以下命令來初始化數據：');
    console.log('npx wrangler kv:key put "bot:U_bot_A:permissions" \'{"users":[{"userId":"YOUR_LINE_USER_ID","role":"owner","displayName":"Owner","addedAt":"2025-11-26T00:00:00.000Z","addedBy":"system"}]}\' --binding KV_LINE_STORAGE --env dev');
    console.log('npx wrangler kv:key put "user:YOUR_LINE_USER_ID:bots" \'{"currentBotId":"U_bot_A","bots":[{"botId":"U_bot_A","role":"owner","joinedAt":"2025-11-26T00:00:00.000Z"}]}\' --binding KV_LINE_STORAGE --env dev');
}

init();
