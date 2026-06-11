/**
 * Unit Tests - handler/member.js
 * 測試會員 Handler 的路由分派、KV 存讀、命名空間隔離
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { route, handleSaveMember, handleListMembers } from '../../worker_src/handler/member.js';

/**
 * 建立支援 { type: 'json' } 的 mock KV wrapper
 * 真實 Cloudflare KV 會在 type:'json' 時自動 parse；mock 只回傳字串，
 * 此 wrapper 補齊這個行為。
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
    return new Request('http://localhost/member/save', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// ────────────────────────────────────────────────────────────
// route() 認證守門測試
// ────────────────────────────────────────────────────────────
describe('member route() — fail-closed ownerId 驗證', () => {
    it('ownerId 為 undefined 時回傳 401', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const req = makeRequest({});
        const res = await route(req, env, undefined, '/member/list');
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.ok(body.error, 'error message should exist');
    });

    it('ownerId 為空字串時回傳 401', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const req = makeRequest({});
        const res = await route(req, env, '', '/member/list');
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.success, false);
    });

    it('ownerId 為非字串型別（數字）時回傳 401', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const req = makeRequest({});
        // eslint-disable-next-line no-magic-numbers
        const res = await route(req, env, 12345, '/member/list');
        assert.equal(res.status, 401);
    });
});

// ────────────────────────────────────────────────────────────
// route() 未知路徑應回傳 404
// ────────────────────────────────────────────────────────────
describe('member route() — 未知路徑', () => {
    it('/member/unknown 回傳 404', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const req = makeRequest({});
        const res = await route(req, env, 'owner-A', '/member/unknown');
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.success, false);
    });
});

// ────────────────────────────────────────────────────────────
// handleSaveMember + handleListMembers 的 round-trip 測試
// ────────────────────────────────────────────────────────────
describe('handleSaveMember / handleListMembers — KV round-trip', () => {
    let env;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    });

    it('儲存會員後，list 能取回該 memberId', async () => {
        const ownerId = 'owner-roundtrip';
        const req = makeRequest({ memberId: 'member-001', name: '測試用戶' });

        const saveRes = await handleSaveMember(req, env, ownerId);
        assert.equal(saveRes.status, 200);
        const saveBody = await saveRes.json();
        assert.equal(saveBody.success, true);
        assert.equal(saveBody.data.memberId, 'member-001');

        const listRes = await handleListMembers(env, ownerId);
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        assert.equal(listBody.success, true);
        assert.ok(Array.isArray(listBody.data));
        assert.ok(listBody.data.includes('member-001'));
    });

    it('lineUserId 優先於 memberId 作為 memberId', async () => {
        const ownerId = 'owner-lineid';
        const req = makeRequest({ memberId: 'fallback-id', lineUserId: 'line-U001', name: '測試' });

        const saveRes = await handleSaveMember(req, env, ownerId);
        const saveBody = await saveRes.json();
        // lineUserId 應優先
        assert.equal(saveBody.data.memberId, 'line-U001');

        const listRes = await handleListMembers(env, ownerId);
        const listBody = await listRes.json();
        assert.ok(listBody.data.includes('line-U001'));
        assert.ok(!listBody.data.includes('fallback-id'), '不應出現 fallback memberId');
    });

    it('缺少 memberId 與 lineUserId 時回傳 400', async () => {
        const ownerId = 'owner-badreq';
        const req = makeRequest({ name: '無 ID 用戶' });

        const res = await handleSaveMember(req, env, ownerId);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
    });

    it('重複儲存同一會員，list 中不重複', async () => {
        const ownerId = 'owner-dedup';
        const req1 = makeRequest({ memberId: 'dup-001', name: '第一次' });
        const req2 = makeRequest({ memberId: 'dup-001', name: '第二次' });

        await handleSaveMember(req1, env, ownerId);
        await handleSaveMember(req2, env, ownerId);

        const listRes = await handleListMembers(env, ownerId);
        const listBody = await listRes.json();
        const count = listBody.data.filter(id => id === 'dup-001').length;
        assert.equal(count, 1, 'memberId 在 list 中應只出現一次');
    });
});

// ────────────────────────────────────────────────────────────
// 命名空間隔離測試：owner A 的資料不應洩漏給 owner B
// ────────────────────────────────────────────────────────────
describe('handleListMembers — 命名空間隔離', () => {
    it('owner A 的會員在 owner B 的 list 中不可見', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const ownerA = 'owner-A';
        const ownerB = 'owner-B';

        // 在 owner A 命名空間儲存一名會員
        const reqA = makeRequest({ memberId: 'memberA-001', name: 'A 的會員' });
        await handleSaveMember(reqA, env, ownerA);

        // owner B 的 list 應是空的
        const listResB = await handleListMembers(env, ownerB);
        const listBodyB = await listResB.json();
        assert.equal(listBodyB.success, true);
        assert.ok(Array.isArray(listBodyB.data));
        assert.ok(!listBodyB.data.includes('memberA-001'), 'owner B 不應看到 owner A 的會員');
        assert.equal(listBodyB.data.length, 0);

        // owner A 的 list 應包含自己的會員
        const listResA = await handleListMembers(env, ownerA);
        const listBodyA = await listResA.json();
        assert.ok(listBodyA.data.includes('memberA-001'));
    });

    it('兩個 owner 各有自己的會員，互不影響', async () => {
        const env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
        const ownerA = 'owner-iso-A';
        const ownerB = 'owner-iso-B';

        await handleSaveMember(makeRequest({ memberId: 'mem-A', name: 'A' }), env, ownerA);
        await handleSaveMember(makeRequest({ memberId: 'mem-B', name: 'B' }), env, ownerB);

        const listA = await (await handleListMembers(env, ownerA)).json();
        const listB = await (await handleListMembers(env, ownerB)).json();

        assert.ok(listA.data.includes('mem-A'));
        assert.ok(!listA.data.includes('mem-B'));
        assert.ok(listB.data.includes('mem-B'));
        assert.ok(!listB.data.includes('mem-A'));
    });
});
