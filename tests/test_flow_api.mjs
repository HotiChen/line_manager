#!/usr/bin/env node
/**
 * test_flow_api.mjs
 * 
 * 自動測試腳本：驗證 /flow/* API 端點是否正確運作
 * 
 * 使用方式:
 *   node test_flow_api.mjs
 *   node test_flow_api.mjs --url https://your-worker.workers.dev
 *   node test_flow_api.mjs --url http://localhost:8787
 *
 * 依賴: Node.js 18+ (原生 fetch)
 */

// ── 設定 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE_URL = urlIdx !== -1 ? args[urlIdx + 1] : 'https://pinti-line-dev.hotichen.workers.dev';

// 使用 env/config.js 中的 testUserId
const TEST_USER_ID = 'Ud66f9caf44c4d927ca4f9361d66ccc18';
const TEST_BOT_ID = '熱茶測試中'; // 已知存在的 bot

// ── 工具函式 ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function ok(name, value) {
    if (value) {
        console.log(`  ✅ ${name}`);
        passed++;
        results.push({ name, status: 'PASS' });
    } else {
        console.error(`  ❌ ${name}`);
        failed++;
        results.push({ name, status: 'FAIL' });
    }
}

async function apiCall(method, path, body) {
    // HTTP headers only accept ISO-8859-1 (ByteString), so encode Chinese bot names
    const headers = {
        'Content-Type': 'application/json',
        'X-User-Id': TEST_USER_ID,
        'X-Bot-Id': encodeURIComponent(TEST_BOT_ID),
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

// ── 測試套件 ───────────────────────────────────────────────────────────

async function testSaveFlow() {
    console.log('\n📌 [1] POST /flow/save — 建立新流程');
    const res = await apiCall('POST', '/flow/save', {
        name: '自動測試流程 ' + Date.now(),
        nodes: [
            { id: 'n1', type: 'richmenu', x: 100, y: 100, data: { name: 'Test Richmenu' } },
            { id: 'n2', type: 'end', x: 400, y: 100, data: {} },
        ],
        edges: [
            { id: 'e1', source: 'n1', target: 'n2' },
        ],
    });

    ok('HTTP 200', res.status === 200);
    ok('success=true', res.body.success === true);
    ok('回傳 flowId', typeof res.body.flowId === 'string' && res.body.flowId.length > 0);
    ok('回傳 updatedAt', typeof res.body.updatedAt === 'string');

    return res.body.flowId;
}

async function testListFlows(expectedId) {
    console.log('\n📌 [2] GET /flow/list — 列出所有流程');
    const res = await apiCall('GET', '/flow/list');

    ok('HTTP 200', res.status === 200);
    ok('success=true', res.body.success === true);
    ok('flows 是陣列', Array.isArray(res.body.flows));

    if (expectedId) {
        const found = res.body.flows.find(f => f.id === expectedId);
        ok(`清單中包含剛建立的 flowId (${expectedId.slice(-8)}...)`, !!found);
        if (found) {
            ok('flow 有 name', typeof found.name === 'string');
            ok('flow 有 nodeCount', typeof found.nodeCount === 'number');
            ok('flow 有 edgeCount', typeof found.edgeCount === 'number');
        }
    }
}

async function testGetFlow(flowId) {
    console.log(`\n📌 [3] GET /flow/get/${flowId} — 取得流程內容`);
    const res = await apiCall('GET', `/flow/get/${flowId}`);

    ok('HTTP 200', res.status === 200);
    ok('success=true', res.body.success === true);
    ok('flow 物件存在', res.body.flow !== null && typeof res.body.flow === 'object');
    ok('flow.id 正確', res.body.flow?.id === flowId);
    ok('flow.nodes 是陣列', Array.isArray(res.body.flow?.nodes));
    ok('flow.edges 是陣列', Array.isArray(res.body.flow?.edges));
    ok('nodes 數量正確 (2)', (res.body.flow?.nodes || []).length === 2);
    ok('edges 數量正確 (1)', (res.body.flow?.edges || []).length === 1);
}

async function testUpdateFlow(flowId) {
    console.log(`\n📌 [4] POST /flow/save — 更新已有流程 (id=${flowId.slice(-8)}...)`);
    const res = await apiCall('POST', '/flow/save', {
        id: flowId,
        name: '已更新的流程名稱',
        nodes: [{ id: 'n1', type: 'richmenu', x: 200, y: 200, data: {} }],
        edges: [],
    });

    ok('HTTP 200', res.status === 200);
    ok('success=true', res.body.success === true);
    ok('flowId 不變', res.body.flowId === flowId);

    // 驗證名稱真的更新了
    const getRes = await apiCall('GET', `/flow/get/${flowId}`);
    ok('名稱已更新', getRes.body.flow?.name === '已更新的流程名稱');
    ok('節點數已更新 (1)', (getRes.body.flow?.nodes || []).length === 1);
}

async function testGetMissingFlow() {
    console.log('\n📌 [5] GET /flow/get/not-exist — 取得不存在的流程');
    const res = await apiCall('GET', '/flow/get/flow_fake_id_that_does_not_exist');

    ok('HTTP 404', res.status === 404);
    ok('回傳 error 欄位', typeof res.body.error === 'string');
}

async function testDeleteFlow(flowId) {
    console.log(`\n📌 [6] DELETE /flow/delete/${flowId} — 刪除流程`);
    const res = await apiCall('DELETE', `/flow/delete/${flowId}`);

    ok('HTTP 200', res.status === 200);
    ok('success=true', res.body.success === true);

    // 確認已刪除
    const getRes = await apiCall('GET', `/flow/get/${flowId}`);
    ok('刪除後 GET 回傳 404', getRes.status === 404);

    // 確認從列表中移除
    const listRes = await apiCall('GET', '/flow/list');
    const stillThere = (listRes.body.flows || []).find(f => f.id === flowId);
    ok('刪除後不在 list 中', !stillThere);
}

async function testMissingUserId() {
    console.log('\n📌 [7] 未提供 X-User-Id — 應回傳 401');
    const res = await fetch(`${BASE_URL}/flow/list`, {
        headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json().catch(() => ({}));

    ok('HTTP 401', res.status === 401);
    ok('回傳 error 欄位', typeof json.error === 'string');
}

// ── 執行測試 ───────────────────────────────────────────────────────────
console.log('🚀 Flow API 測試腳本');
console.log(`🌐 目標 URL: ${BASE_URL}`);
console.log(`👤 測試 userId: ${TEST_USER_ID}`);
console.log(`🤖 測試 botId: ${TEST_BOT_ID}`);
console.log('─'.repeat(55));

(async () => {
    try {
        // 1. 建立流程
        const flowId = await testSaveFlow();

        if (!flowId) {
            console.error('\n🛑 無法取得 flowId，後續測試中止。');
            console.error('   → 請確認後端已部署最新版本 (wrangler deploy)');
            process.exit(1);
        }

        // 2-6. 完整 CRUD
        await testListFlows(flowId);
        await testGetFlow(flowId);
        await testUpdateFlow(flowId);
        await testGetMissingFlow();
        await testDeleteFlow(flowId);
        await testMissingUserId();

    } catch (err) {
        console.error('\n💥 測試執行發生例外:', err.message);
        failed++;
    }

    // ── 結果摘要 ────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(55));
    console.log(`📊 測試結果: ${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);

    if (failed === 0) {
        console.log('🎉 全部通過！Flow API 運作正常。');
    } else {
        console.log('\n❌ 失敗項目:');
        results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`   - ${r.name}`);
        });
        console.log('\n💡 常見原因:');
        console.log('   1. 後端尚未部署: 執行 npx wrangler deploy');
        console.log('   2. 指定了錯誤的 URL: 加上 --url 參數');
        console.log('   3. KV binding 未設定');
    }

    process.exit(failed > 0 ? 1 : 0);
})();
