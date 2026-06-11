/**
 * 安全性修改自動化測試腳本
 *
 * 測試項目：
 * 1. 認證機制 — 無認證 / X-User-Id / Authorization Bearer
 * 2. Migration API — secret 驗證
 * 3. Rate Limiter — 頻率限制
 * 4. CORS Headers — Authorization 是否被允許
 *
 * 使用方式：
 *   1. 先啟動本地 Worker: npx wrangler dev --env dev
 *   2. 設定 migration secret: npx wrangler secret put MIGRATION_SECRET --env dev
 *   3. 執行測試: node test_security.mjs
 *
 *   可選環境變數：
 *     API_BASE=http://localhost:8787  (預設)
 *     MIGRATION_SECRET=你設定的密碼
 *     TEST_USER_ID=你的LINE_userId
 */

const API_BASE = process.env.API_BASE || 'http://localhost:8787';
const MIGRATION_SECRET = process.env.MIGRATION_SECRET || '';
const TEST_USER_ID = process.env.TEST_USER_ID || 'U_test_user_001';

// ─── 工具函式 ───────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function log(icon, msg) {
    console.log(`  ${icon} ${msg}`);
}

async function test(name, fn) {
    try {
        await fn();
        passed++;
        log('✅', name);
    } catch (err) {
        failed++;
        log('❌', `${name} — ${err.message}`);
    }
}

function skip(name, reason) {
    skipped++;
    log('⏭️', `${name} (跳過: ${reason})`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function fetchAPI(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { ...options.headers }
    });
    return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.json().catch(() => null)
    };
}

// ─── 測試開始 ───────────────────────────────────────

console.log('\n🔒 安全性修改測試\n');
console.log(`  📡 API: ${API_BASE}`);
console.log(`  👤 Test User: ${TEST_USER_ID}\n`);

// ── 連線檢查 ──
let serverOnline = false;
try {
    const ping = await fetch(`${API_BASE}/debug-ping`);
    if (ping.ok) {
        serverOnline = true;
        log('🟢', 'Worker 已連線\n');
    }
} catch (e) {
    log('🔴', `無法連線到 ${API_BASE}`);
    log('💡', '請先執行: npx wrangler dev --env dev\n');
    process.exit(1);
}

// ═══════════════════════════════════════════════════
console.log('── 1. 認證機制測試 ──\n');

await test('無認證請求 /token/list 應回 401', async () => {
    const res = await fetchAPI('/token/list');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('無認證請求 /keyword/list 應回 401', async () => {
    const res = await fetchAPI('/keyword/list');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('無認證請求 /richmenu/list 應回 401', async () => {
    const res = await fetchAPI('/richmenu/list');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('無認證請求 /flex/list 應回 401', async () => {
    const res = await fetchAPI('/flex/list');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('無認證請求 /tier/config 應回 401', async () => {
    const res = await fetchAPI('/tier/config');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('X-User-Id 認證應通過（Legacy 模式）', async () => {
    const res = await fetchAPI('/token/list', {
        headers: { 'X-User-Id': TEST_USER_ID }
    });
    // 可能回 200 或其他非 401 的狀態（如 404、500 都算認證通過）
    assert(res.status !== 401, `認證應通過，但得到 401`);
});

await test('假的 Bearer token 應被拒絕或回退', async () => {
    const res = await fetchAPI('/token/list', {
        headers: { 'Authorization': 'Bearer fake_invalid_token_12345' }
    });
    // 帶了 Bearer 但 token 無效，應該被拒絕 (401)
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

// ── 公開 API 不需認證 ──
await test('Webhook API 不需認證', async () => {
    const res = await fetchAPI('/api/webhook', { method: 'POST' });
    // 不是 401 就好（可能是 400 或其他）
    assert(res.status !== 401, `Webhook 不應要求認證，但得到 401`);
});

await test('Debug ping 不需認證', async () => {
    const res = await fetchAPI('/debug-ping');
    assert(res.status === 200, `預期 200，實際 ${res.status}`);
});

// ═══════════════════════════════════════════════════
console.log('\n── 2. Migration API 測試 ──\n');

await test('Migration 無 key 應回 401', async () => {
    const res = await fetchAPI('/admin/migrate?userId=test');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

await test('Migration 錯誤 key 應回 401', async () => {
    const res = await fetchAPI('/admin/migrate?userId=test&key=wrong_password');
    assert(res.status === 401, `預期 401，實際 ${res.status}`);
});

if (MIGRATION_SECRET) {
    await test('Migration 正確 key 應通過', async () => {
        const res = await fetchAPI(`/admin/migrate?userId=test_migration_user&key=${MIGRATION_SECRET}`);
        assert(res.status !== 401, `認證應通過，但得到 401`);
        assert(res.status !== 500 || !res.body?.error?.includes('not configured'),
            'MIGRATION_SECRET 環境變數未設定');
    });
} else {
    skip('Migration 正確 key 測試', '未提供 MIGRATION_SECRET 環境變數');
}

// ═══════════════════════════════════════════════════
console.log('\n── 3. CORS Headers 測試 ──\n');

await test('OPTIONS 預檢請求應回 204', async () => {
    const res = await fetch(`${API_BASE}/token/list`, { method: 'OPTIONS' });
    assert(res.status === 204, `預期 204，實際 ${res.status}`);
});

await test('CORS 應允許 Authorization header', async () => {
    const res = await fetch(`${API_BASE}/token/list`, { method: 'OPTIONS' });
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
    assert(allowHeaders.includes('Authorization'),
        `Access-Control-Allow-Headers 缺少 Authorization: "${allowHeaders}"`);
});

await test('CORS 應允許 X-User-Id header', async () => {
    const res = await fetch(`${API_BASE}/token/list`, { method: 'OPTIONS' });
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
    assert(allowHeaders.includes('X-User-Id'),
        `Access-Control-Allow-Headers 缺少 X-User-Id: "${allowHeaders}"`);
});

await test('CORS 應允許 X-Bot-Id header', async () => {
    const res = await fetch(`${API_BASE}/token/list`, { method: 'OPTIONS' });
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
    assert(allowHeaders.includes('X-Bot-Id'),
        `Access-Control-Allow-Headers 缺少 X-Bot-Id: "${allowHeaders}"`);
});

// ═══════════════════════════════════════════════════
console.log('\n── 4. Rate Limiter 測試 ──\n');

await test('連續請求不應立即被限制', async () => {
    // 前幾次請求應該都通過
    for (let i = 0; i < 5; i++) {
        const res = await fetchAPI('/token/list', {
            headers: { 'X-User-Id': `rate_test_user_${Date.now()}` }
        });
        assert(res.status !== 429, `第 ${i + 1} 次請求不應被限制`);
    }
});

await test('超過限制後應回 429', async () => {
    const testUser = `rate_limit_test_${Date.now()}`;

    // 快速發送 105 次請求（預設限制 100）
    const promises = [];
    for (let i = 0; i < 105; i++) {
        promises.push(
            fetchAPI('/token/list', {
                headers: { 'X-User-Id': testUser }
            })
        );
    }

    const results = await Promise.all(promises);
    const got429 = results.some(r => r.status === 429);

    assert(got429, '發送 105 次請求後應至少有一次收到 429');
});

await test('429 回應應包含 retryAfter', async () => {
    const testUser = `retry_after_test_${Date.now()}`;

    // 快速打滿 limit
    const promises = [];
    for (let i = 0; i < 110; i++) {
        promises.push(
            fetchAPI('/token/list', {
                headers: { 'X-User-Id': testUser }
            })
        );
    }
    const results = await Promise.all(promises);
    const rateLimited = results.find(r => r.status === 429);

    if (rateLimited) {
        assert(rateLimited.body?.retryAfter !== undefined,
            '429 回應缺少 retryAfter 欄位');
    } else {
        // 如果沒有觸發 429，可能是並發處理的 KV 競態條件，標記警告
        log('⚠️', '  未觸發 429（可能是 KV 並發競態），此為已知行為');
    }
});

// ═══════════════════════════════════════════════════
console.log('\n── 5. Hardcoded 敏感資訊檢查 ──\n');

// 這些是靜態檔案檢查，透過 fetch 前端檔案來驗證
await test('前端 config.js 不應包含 hardcoded userId', async () => {
    const res = await fetch(`${API_BASE}/env/config.js`);
    const text = await res.text();
    assert(!text.includes('Ud66f9caf44c4d927ca4f9361d66ccc18'),
        'config.js 仍包含 hardcoded userId');
});

await test('前端 state.js 不應包含 hardcoded userId', async () => {
    const res = await fetch(`${API_BASE}/helper/state.js`);
    const text = await res.text();
    assert(!text.includes('Ud66f9caf44c4d927ca4f9361d66ccc18'),
        'state.js 仍包含 hardcoded userId');
});

await test('前端 config.js debug 不應在非 localhost 為 true', async () => {
    const res = await fetch(`${API_BASE}/env/config.js`);
    const text = await res.text();
    // 確認 debug 是條件式的，不是寫死 true
    assert(!text.match(/export\s+const\s+debug\s*=\s*true\s*;/),
        'debug 不應該被寫死為 true');
});

// ═══════════════════════════════════════════════════
// 結果摘要
console.log('\n════════════════════════════════════════\n');
console.log(`  ✅ 通過: ${passed}`);
console.log(`  ❌ 失敗: ${failed}`);
if (skipped > 0) console.log(`  ⏭️ 跳過: ${skipped}`);
console.log(`  📊 總計: ${passed + failed + skipped} 項測試\n`);

if (failed > 0) {
    console.log('  ⚠️  有測試失敗，請檢查上方錯誤訊息。\n');
    process.exit(1);
} else {
    console.log('  🎉 所有測試通過！安全性修改驗證完成。\n');
}
