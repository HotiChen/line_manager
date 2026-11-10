/**
 * Unit Tests - handler/token.js
 * 測試 Token Handler 的純 KV CRUD 路徑（不觸及 LINE API fetch）
 *
 * 略過測試：
 * - handleRegisterAccessToken：一定會呼叫 fetch("https://api.line.me/v2/bot/info")，
 *   屬於網路依賴，不在本單元測試範圍。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import {
    handleSetCurrentToken,
    handleDeleteAccessToken,
    handleGetCurrentToken,
    handleListUserProjects,
    route
} from '../../worker_src/handler/token.js';

/**
 * 支援 { type: 'json' } 選項的 mock KV wrapper
 * 真實 Cloudflare KV 在 type:'json' 時自動 parse；此 wrapper 補齊這個行為。
 */
function createJsonAwareMockKV() {
    const base = createMockKV();
    return {
        ...base,
        async get(key, opts) {
            const raw = await base.get(key);
            if (raw === null) return null;
            if (opts && opts.type === 'json') {
                try { return JSON.parse(raw); } catch { return null; }
            }
            return raw;
        }
    };
}

function makeRequest(body = {}, method = 'POST') {
    return new Request('http://localhost/token/set', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

/**
 * 直接在 KV 中寫入一筆 access_tokens，模擬已成功 register 的狀態。
 */
async function seedToken(kv, userId, project, tokenValue = 'tok-test-001') {
    const key = `access_tokens_${userId}`;
    const existing = (await kv.get(key, { type: 'json' })) || {};
    existing[project] = { token: tokenValue, destination: `dest-${project}`, displayName: project };
    await kv.put(key, JSON.stringify(existing));
}

// ────────────────────────────────────────────────────────────
// handleSetCurrentToken
// ────────────────────────────────────────────────────────────
describe('handleSetCurrentToken', () => {
    let env;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    });

    it('設定已存在的專案為 current token，回傳 200', async () => {
        await seedToken(env.KV_LINE_STORAGE, 'user-set-01', 'proj-alpha');
        const req = makeRequest({ project: 'proj-alpha' });
        const res = await handleSetCurrentToken(req, env, 'user-set-01');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.ok(body.message.includes('proj-alpha'));
    });

    it('設定不存在的專案回傳 404', async () => {
        const req = makeRequest({ project: 'no-such-project' });
        const res = await handleSetCurrentToken(req, env, 'user-set-02');
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(body.error, '應有 error 欄位');
    });
});

// ────────────────────────────────────────────────────────────
// handleGetCurrentToken
// ────────────────────────────────────────────────────────────
describe('handleGetCurrentToken', () => {
    let env;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    });

    it('尚未設定 current_token 時回傳 404', async () => {
        const res = await handleGetCurrentToken(env, 'user-get-01');
        assert.equal(res.status, 404);
    });

    it('設定後能取回 project 名稱與 botId，但不回傳 token', async () => {
        // 原本這裡斷言 body.token === 'secret-tok'，也就是斷言端點會把 LINE
        // channel access token 交給呼叫端。那是這次要修掉的漏洞本身，所以
        // 斷言必須反轉：現在驗證專案資訊仍可取得，而祕密不外流。
        const userId = 'user-get-02';
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-beta', 'secret-tok');
        await env.KV_LINE_STORAGE.put(`current_token_${userId}`, 'proj-beta');

        const res = await handleGetCurrentToken(env, userId);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.project, 'proj-beta');
        assert.equal(body.botId, 'dest-proj-beta');
        assert.ok(!('token' in body), 'token 不可出現在回應裡');
    });
});

// ────────────────────────────────────────────────────────────
// handleDeleteAccessToken
// ────────────────────────────────────────────────────────────
describe('handleDeleteAccessToken', () => {
    let env;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    });

    it('刪除存在的 token 後，get current 應回傳 404（若是 current）', async () => {
        const userId = 'user-del-01';
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-del');
        await env.KV_LINE_STORAGE.put(`current_token_${userId}`, 'proj-del');

        const req = makeRequest({ project: 'proj-del' });
        const res = await handleDeleteAccessToken(req, env, userId);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);

        // current_token 應已連同清除
        const currentRes = await handleGetCurrentToken(env, userId);
        assert.equal(currentRes.status, 404);
    });

    it('刪除不存在的 token 回傳 404', async () => {
        const req = makeRequest({ project: 'ghost-project' });
        const res = await handleDeleteAccessToken(req, env, 'user-del-02');
        assert.equal(res.status, 404);
    });

    it('刪除非 current 的 token 不影響 current_token', async () => {
        const userId = 'user-del-03';
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-keep');
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-remove');
        await env.KV_LINE_STORAGE.put(`current_token_${userId}`, 'proj-keep');

        const req = makeRequest({ project: 'proj-remove' });
        await handleDeleteAccessToken(req, env, userId);

        // current_token 應仍是 proj-keep
        const currentRes = await handleGetCurrentToken(env, userId);
        assert.equal(currentRes.status, 200);
        const currentBody = await currentRes.json();
        assert.equal(currentBody.project, 'proj-keep');
    });
});

// ────────────────────────────────────────────────────────────
// handleListUserProjects（純 KV 路徑，無 bots 部分）
// ────────────────────────────────────────────────────────────
describe('handleListUserProjects', () => {
    let env;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    });

    /**
     * 注意：handleListUserProjects 中的 Promise.all 語法
     *   Promise.all([kv.get(key, opts) || {}, kv.get(key2, opts) || { bots: [] }])
     * 由於 kv.get() 回傳 Promise（truthy），|| fallback 不會觸發，
     * 當 KV 不存在資料時會回傳 null，需自行 seed user:${userId}:bots
     * 以避開生產程式碼中的既有行為。
     */
    async function seedEmptyBots(kv, userId) {
        await kv.put(`user:${userId}:bots`, JSON.stringify({ bots: [] }));
    }

    it('無任何 token 時回傳空物件（需 seed bots key）', async () => {
        const userId = 'user-list-01';
        await seedEmptyBots(env.KV_LINE_STORAGE, userId);
        const res = await handleListUserProjects(env, userId);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, {});
    });

    it('有 token 的用戶回傳其專案列表', async () => {
        const userId = 'user-list-02';
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-one', 'tok-one');
        await seedToken(env.KV_LINE_STORAGE, userId, 'proj-two', 'tok-two');
        await seedEmptyBots(env.KV_LINE_STORAGE, userId);

        const res = await handleListUserProjects(env, userId);
        assert.equal(res.status, 200);
        const body = await res.json();
        // 回傳物件的 key 應包含這兩個專案
        assert.ok('proj-one' in body, 'proj-one 應在列表中');
        assert.ok('proj-two' in body, 'proj-two 應在列表中');
    });
});

// ────────────────────────────────────────────────────────────
// 命名空間隔離測試：user A 的 tokens 不應洩漏給 user B
// ────────────────────────────────────────────────────────────
describe('Token 命名空間隔離', () => {
    it('user A 儲存的 token 在 user B 的 list 中不可見', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const userA = 'user-iso-A';
        const userB = 'user-iso-B';

        await seedToken(env.KV_LINE_STORAGE, userA, 'proj-A-secret', 'tok-secret');
        // 需 seed bots key 以讓 handleListUserProjects 能正確運作（見 handleListUserProjects 說明）
        await env.KV_LINE_STORAGE.put(`user:${userB}:bots`, JSON.stringify({ bots: [] }));

        // user B 查自己的 current token，不應取到任何資料
        const resB = await handleGetCurrentToken(env, userB);
        assert.equal(resB.status, 404);

        // user B 的 project list 應為空且看不到 user A 的專案
        const listResB = await handleListUserProjects(env, userB);
        const listBodyB = await listResB.json();
        assert.ok(!('proj-A-secret' in listBodyB), 'user B 不應看到 user A 的專案');
    });

    it('set/delete 操作不影響其他 user 的資料', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const userA = 'user-cross-A';
        const userB = 'user-cross-B';

        await seedToken(env.KV_LINE_STORAGE, userA, 'shared-name', 'tok-A');
        await seedToken(env.KV_LINE_STORAGE, userB, 'shared-name', 'tok-B');
        await env.KV_LINE_STORAGE.put(`current_token_${userA}`, 'shared-name');
        await env.KV_LINE_STORAGE.put(`current_token_${userB}`, 'shared-name');

        // user A 刪除自己的 'shared-name'
        const delReq = makeRequest({ project: 'shared-name' });
        await handleDeleteAccessToken(delReq, env, userA);

        // user A 的 current token 應已消失
        const resA = await handleGetCurrentToken(env, userA);
        assert.equal(resA.status, 404);

        // user B 的 current token 不應受影響
        const resB = await handleGetCurrentToken(env, userB);
        assert.equal(resB.status, 200);
        const bodyB = await resB.json();
        // 原本用 token 值當 A/B 的區分工具。隔離的證明其實是「A 的回 404、
        // B 的仍回 200 且專案在」——不需要祕密就成立。
        assert.equal(bodyB.project, 'shared-name');
    });
});

// ────────────────────────────────────────────────────────────
// route() 未知路徑
// ────────────────────────────────────────────────────────────
describe('token route() — 未知路徑', () => {
    it('/token/unknown 回傳 404', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const req = makeRequest({});
        const res = await route(req, env, 'some-user', '/token/unknown');
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.success, false);
    });
});
