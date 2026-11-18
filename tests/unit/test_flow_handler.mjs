/**
 * Unit Tests — handler/flow.js（Phase 0：bot 命名空間 + 權限）
 *
 * 見 docs/flow_designer/ARCHITECTURE_REVIEW_2026-11-18.md 的 H1 / H6。
 *
 * 之前的問題：
 *   - botId 來自一個沒有任何程式寫入的 `token_${userId}`，永遠是 "default"
 *   - key 綁呼叫者的 userId，受邀的團隊成員看不到 owner 的流程
 *   - /flow 沒有 withPermission
 *   - 每次儲存都覆蓋 createdAt
 *
 * 全部用 createMockKV（不傳空 env —— 空 env 會走 fail-open 路徑）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';
import { route } from '../../worker_src/handler/flow.js';

const OWNER = 'Uowner00000000000000000000000001';
const ADMIN = 'Uadmin00000000000000000000000002';
const MEMBER = 'Umember0000000000000000000000003';
const STRANGER = 'Ustranger00000000000000000000004';
const OTHER_OWNER = 'Uowner00000000000000000000000009';
const BOT_A = 'Ubota0000000000000000000000000a1';
const BOT_B = 'Ubotb0000000000000000000000000b1';
const BOT_C = 'Ubotc0000000000000000000000000c1';

let env;
let kv;

function seedPermissions(botId, users) {
    return kv.put(BotKeys.permissions(botId), JSON.stringify({ users }));
}

function seedCurrentBot(userId, currentBotId, botIds = [currentBotId]) {
    return kv.put(
        UserKeys.bots(userId),
        JSON.stringify({ bots: botIds.map((botId) => ({ botId, role: 'owner' })), currentBotId })
    );
}

beforeEach(async () => {
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv };

    // OWNER 持有 A、B 兩個 bot；ADMIN / MEMBER 是 A 的團隊成員
    await seedPermissions(BOT_A, [
        { userId: OWNER, role: 'owner' },
        { userId: ADMIN, role: 'admin' },
        { userId: MEMBER, role: 'member' },
    ]);
    await seedPermissions(BOT_B, [{ userId: OWNER, role: 'owner' }]);
    await seedPermissions(BOT_C, [{ userId: OTHER_OWNER, role: 'owner' }]);
    await seedCurrentBot(OWNER, BOT_A, [BOT_A, BOT_B]);
    await seedCurrentBot(ADMIN, BOT_A);
    await seedCurrentBot(MEMBER, BOT_A);
    // STRANGER 的「目前 bot」指向 A，但他不在 A 的權限清單裡
    await seedCurrentBot(STRANGER, BOT_A);
    await seedCurrentBot(OTHER_OWNER, BOT_C);
});

// ── helpers ──────────────────────────────────────────────

async function call(userId, method, pathname, body, headers = {}) {
    const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await route(new Request(`https://worker.example.com${pathname}`, init), env, userId, pathname);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
}

const save = (userId, body, headers) => call(userId, 'POST', '/flow/save', body, headers);
const list = (userId, headers) => call(userId, 'GET', '/flow/list', undefined, headers);
const get = (userId, id, headers) => call(userId, 'GET', `/flow/get/${id}`, undefined, headers);
const del = (userId, id, headers) => call(userId, 'DELETE', `/flow/delete/${id}`, undefined, headers);

const NODES = [{ id: 'n1', type: 'message_text', position: { x: 0, y: 0 }, data: { text: 'hi' } }];
const EDGES = [];

async function raw(key) {
    const v = await kv.get(key);
    return v === null ? null : JSON.parse(v);
}

// ── 基本 CRUD：走 bot 命名空間 ───────────────────────────

describe('flow handler — bot 命名空間', () => {
    it('儲存後寫進 bot:<botId>:flow:*，且不再寫舊的 flow_<userId>_default_*', async () => {
        const res = await save(OWNER, { name: '流程一', nodes: NODES, edges: EDGES });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        const id = res.json.flowId;

        const stored = await raw(BotKeys.flow(BOT_A, id));
        assert.equal(stored.name, '流程一');
        assert.equal(stored.botId, BOT_A);
        assert.deepEqual(await raw(BotKeys.flowList(BOT_A)), [id]);

        assert.equal(await kv.get(V1Keys.flow(OWNER, 'default', id)), null);
        assert.equal(await kv.get(V1Keys.flowList(OWNER, 'default')), null);
    });

    it('新流程的 id 不含 LINE userId', async () => {
        const res = await save(OWNER, { name: 'x', nodes: [], edges: [] });
        assert.ok(!res.json.flowId.includes(OWNER));
    });

    it('list / get / delete 往返', async () => {
        const { json: saved } = await save(OWNER, { name: 'A 流程', nodes: NODES, edges: EDGES });
        const id = saved.flowId;

        const listed = await list(OWNER);
        assert.equal(listed.status, 200);
        assert.equal(listed.json.flows.length, 1);
        assert.equal(listed.json.flows[0].id, id);
        assert.equal(listed.json.flows[0].nodeCount, 1);
        assert.equal(listed.json.flows[0].edgeCount, 0);

        const got = await get(OWNER, id);
        assert.equal(got.status, 200);
        assert.equal(got.json.flow.name, 'A 流程');
        assert.deepEqual(got.json.flow.nodes, NODES);

        const removed = await del(OWNER, id);
        assert.equal(removed.status, 200);
        assert.equal(removed.json.success, true);
        assert.equal((await list(OWNER)).json.flows.length, 0);
        assert.equal((await get(OWNER, id)).status, 404);
        assert.equal(await kv.get(BotKeys.flow(BOT_A, id)), null);
    });

    it('get 不存在的流程回 404', async () => {
        const res = await get(OWNER, 'flow_nope');
        assert.equal(res.status, 404);
        assert.equal(res.json.error, 'Flow not found');
    });

    it('名稱的 HTML 標籤被移除', async () => {
        const res = await save(OWNER, { name: '<img src=x onerror=alert(1)>正常', nodes: [], edges: [] });
        const got = await get(OWNER, res.json.flowId);
        assert.equal(got.json.flow.name, '正常');
    });

    it('每次儲存仍會寫一筆版本快照，listVersions 讀得到', async () => {
        const { json: saved } = await save(OWNER, { name: 'v', nodes: NODES, edges: EDGES });
        const versions = await call(OWNER, 'GET', `/flow/versions/${saved.flowId}`);
        assert.equal(versions.status, 200);
        assert.equal(versions.json.versions.length, 1);
        assert.equal(versions.json.versions[0].name, 'v');
        assert.equal(versions.json.versions[0].nodeCount, 1);
        // 版本也在 bot 命名空間底下
        const keys = [...kv._store.keys()].filter((k) => k.startsWith(`bot:${BOT_A}:flow_version:${saved.flowId}:`));
        assert.equal(keys.length, 1);
    });

    it('版本不會跨 bot 洩漏', async () => {
        const { json: saved } = await save(OWNER, { name: 'v', nodes: [], edges: [] });
        const other = await call(OWNER, 'GET', `/flow/versions/${saved.flowId}`, undefined, { 'X-Bot-Id': BOT_B });
        assert.equal(other.status, 200);
        assert.deepEqual(other.json.versions, []);
    });
});

// ── 兩個 bot 互相隔離 ────────────────────────────────────

describe('flow handler — 多 bot 隔離', () => {
    it('A 的流程在 B 看不到（切換 current bot）', async () => {
        const { json: saved } = await save(OWNER, { name: 'A only', nodes: NODES, edges: EDGES });
        await seedCurrentBot(OWNER, BOT_B, [BOT_A, BOT_B]);

        assert.deepEqual((await list(OWNER)).json.flows, []);
        assert.equal((await get(OWNER, saved.flowId)).status, 404);
    });

    it('A 的流程在 B 看不到（X-Bot-Id）', async () => {
        const { json: saved } = await save(OWNER, { name: 'A only', nodes: NODES, edges: EDGES });
        const inB = { 'X-Bot-Id': BOT_B };

        assert.deepEqual((await list(OWNER, inB)).json.flows, []);
        assert.equal((await get(OWNER, saved.flowId, inB)).status, 404);
        // 回到 A 仍然看得到
        assert.equal((await list(OWNER, { 'X-Bot-Id': BOT_A })).json.flows.length, 1);
    });

    it('在 B 刪除 A 的 flowId 不會動到 A 的資料', async () => {
        const { json: saved } = await save(OWNER, { name: 'A only', nodes: NODES, edges: EDGES });
        await del(OWNER, saved.flowId, { 'X-Bot-Id': BOT_B });
        assert.equal((await get(OWNER, saved.flowId)).status, 200);
        assert.equal((await list(OWNER)).json.flows.length, 1);
    });

    it('在 B 用 A 的 flowId 儲存，是在 B 建立一份新的，A 不受影響', async () => {
        const { json: saved } = await save(OWNER, { name: 'A 版本', nodes: NODES, edges: EDGES });
        await save(OWNER, { id: saved.flowId, name: 'B 版本', nodes: [], edges: [] }, { 'X-Bot-Id': BOT_B });

        assert.equal((await get(OWNER, saved.flowId, { 'X-Bot-Id': BOT_A })).json.flow.name, 'A 版本');
        assert.equal((await get(OWNER, saved.flowId, { 'X-Bot-Id': BOT_B })).json.flow.name, 'B 版本');
    });

    it('另一個 owner 的 bot 看不到、也碰不到', async () => {
        const { json: saved } = await save(OWNER, { name: 'mine', nodes: NODES, edges: EDGES });
        assert.deepEqual((await list(OTHER_OWNER)).json.flows, []);
        assert.equal((await get(OTHER_OWNER, saved.flowId)).status, 404);
        // 即使指名 A 的 botId 也被權限檢查擋下
        assert.equal((await get(OTHER_OWNER, saved.flowId, { 'X-Bot-Id': BOT_A })).status, 403);
    });
});

// ── 團隊與授權 ───────────────────────────────────────────

describe('flow handler — 團隊授權', () => {
    it('團隊 admin 看得到 owner 的流程，也能取得內容', async () => {
        const { json: saved } = await save(OWNER, { name: 'owner 的', nodes: NODES, edges: EDGES });

        const listed = await list(ADMIN);
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.json.flows.map((f) => f.id), [saved.flowId]);
        assert.equal((await get(ADMIN, saved.flowId)).json.flow.name, 'owner 的');
    });

    it('團隊 admin 能編輯、刪除 owner 的流程，owner 也看得到 admin 建立的', async () => {
        const { json: saved } = await save(OWNER, { name: 'v1', nodes: NODES, edges: EDGES });

        const edit = await save(ADMIN, { id: saved.flowId, name: 'v2 by admin', nodes: NODES, edges: EDGES });
        assert.equal(edit.status, 200);
        assert.equal(edit.json.flowId, saved.flowId);
        assert.equal((await get(OWNER, saved.flowId)).json.flow.name, 'v2 by admin');

        const created = await save(ADMIN, { name: 'admin 新增', nodes: [], edges: [] });
        assert.equal((await list(OWNER)).json.flows.length, 2);

        await del(ADMIN, created.json.flowId);
        assert.equal((await list(OWNER)).json.flows.length, 1);
    });

    it('一般 member 與 admin 一樣可以操作（角色分級是 Phase 1 的 D12）', async () => {
        const res = await save(MEMBER, { name: 'by member', nodes: [], edges: [] });
        assert.equal(res.status, 200);
        assert.equal((await list(ADMIN)).json.flows.length, 1);
    });

    it('非成員：五個端點全部 403，而且什麼都沒寫入', async () => {
        const { json: saved } = await save(OWNER, { name: 'secret', nodes: NODES, edges: EDGES });
        const before = new Map([...kv._store].map(([k, v]) => [k, v.value]));

        const results = [
            await list(STRANGER),
            await get(STRANGER, saved.flowId),
            await save(STRANGER, { id: saved.flowId, name: 'hijack', nodes: [], edges: [] }),
            await del(STRANGER, saved.flowId),
            await call(STRANGER, 'GET', `/flow/versions/${saved.flowId}`),
        ];
        for (const r of results) {
            assert.equal(r.status, 403, r.text);
            assert.ok(r.json.error);
            assert.ok(!r.text.includes('secret'));
        }

        const after = new Map([...kv._store].map(([k, v]) => [k, v.value]));
        assert.deepEqual(after, before);
        assert.equal((await get(OWNER, saved.flowId)).json.flow.name, 'secret');
    });

    it('非成員用 X-Bot-Id 指名別人的 bot 也被擋', async () => {
        const res = await list(STRANGER, { 'X-Bot-Id': BOT_B });
        assert.equal(res.status, 403);
    });

    it('完全沒有 bot 的使用者：fail-closed 403', async () => {
        const res = await list('Unobody0000000000000000000000099');
        assert.equal(res.status, 403);
    });

    it('沒有認證身分（userId 為 null）回 401', async () => {
        for (const r of [await list(null), await save(null, { name: 'x' }), await get(null, 'f'), await del(null, 'f')]) {
            assert.equal(r.status, 401);
        }
        assert.equal([...kv._store.keys()].filter((k) => k.includes('flow')).length, 0);
    });

    it('body 裡自報的 userId / botId 不被信任', async () => {
        const res = await save(OWNER, { name: 'x', nodes: [], edges: [], userId: STRANGER, botId: BOT_C });
        assert.equal(res.status, 200);
        assert.ok(await raw(BotKeys.flow(BOT_A, res.json.flowId)));
        assert.equal((await raw(BotKeys.flow(BOT_A, res.json.flowId))).botId, BOT_A);
        assert.equal(await kv.get(BotKeys.flow(BOT_C, res.json.flowId)), null);
    });
});

// ── createdAt ────────────────────────────────────────────

describe('flow handler — createdAt', () => {
    it('更新時保留原本的 createdAt（不論用戶端送什麼）', async () => {
        const { json: first } = await save(OWNER, { name: 'v1', nodes: [], edges: [] });
        const id = first.flowId;

        // 把 createdAt 改成一個明確、不可能是「現在」的值
        const stored = await raw(BotKeys.flow(BOT_A, id));
        stored.createdAt = '2020-01-01T00:00:00.000Z';
        await kv.put(BotKeys.flow(BOT_A, id), JSON.stringify(stored));

        // 前端更新時送的是 createdAt: undefined（被 JSON 省略）
        await save(OWNER, { id, name: 'v2', nodes: [], edges: [] });
        assert.equal((await get(OWNER, id)).json.flow.createdAt, '2020-01-01T00:00:00.000Z');

        // 就算有人硬塞也不能改
        await save(ADMIN, { id, name: 'v3', nodes: [], edges: [], createdAt: '1999-09-09T00:00:00.000Z' });
        const after = (await get(OWNER, id)).json.flow;
        assert.equal(after.createdAt, '2020-01-01T00:00:00.000Z');
        assert.equal(after.name, 'v3');
        assert.notEqual(after.updatedAt, after.createdAt);
    });

    it('新建時 createdAt 與 updatedAt 同為現在', async () => {
        const res = await save(OWNER, { name: 'new', nodes: [], edges: [] });
        const flow = (await get(OWNER, res.json.flowId)).json.flow;
        assert.equal(flow.createdAt, flow.updatedAt);
    });
});

// ── 舊資料：lazy fallback + copy-forward ─────────────────

describe('flow handler — 舊 key 相容', () => {
    const LEGACY_ID = `flow_${OWNER}_1700000000000_abc123def`;

    async function seedLegacy(userId, legacyBot, id, extra = {}) {
        const flow = {
            id,
            name: '舊流程',
            botId: legacyBot,
            nodes: NODES,
            edges: EDGES,
            createdAt: '2025-12-01T00:00:00.000Z',
            updatedAt: '2025-12-02T00:00:00.000Z',
            ...extra,
        };
        await kv.put(V1Keys.flow(userId, legacyBot, id), JSON.stringify(flow));
        const listKey = V1Keys.flowList(userId, legacyBot);
        const ids = JSON.parse((await kv.get(listKey)) || '[]');
        ids.push(id);
        await kv.put(listKey, JSON.stringify(ids));
        return flow;
    }

    it('list 讀得到舊的 flow_<userId>_default_*，並 copy-forward 到 bot 命名空間', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);

        const res = await list(OWNER);
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.flows.map((f) => f.id), [LEGACY_ID]);
        assert.equal(res.json.flows[0].name, '舊流程');
        assert.equal(res.json.flows[0].createdAt, '2025-12-01T00:00:00.000Z');

        const copied = await raw(BotKeys.flow(BOT_A, LEGACY_ID));
        assert.equal(copied.name, '舊流程');
        assert.equal(copied.botId, BOT_A);
        assert.deepEqual(await raw(BotKeys.flowList(BOT_A)), [LEGACY_ID]);
    });

    it('舊 key 不會被刪除或改動', async () => {
        const legacy = await seedLegacy(OWNER, 'default', LEGACY_ID);
        const listBefore = await kv.get(V1Keys.flowList(OWNER, 'default'));

        await list(OWNER);
        await save(OWNER, { id: LEGACY_ID, name: '改過', nodes: [], edges: [] });
        await del(OWNER, LEGACY_ID);

        assert.deepEqual(await raw(V1Keys.flow(OWNER, 'default', LEGACY_ID)), legacy);
        assert.equal(await kv.get(V1Keys.flowList(OWNER, 'default')), listBefore);
    });

    it('第一次就是 get（沒先 list）也讀得到', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);
        const res = await get(OWNER, LEGACY_ID);
        assert.equal(res.status, 200);
        assert.equal(res.json.flow.name, '舊流程');
    });

    it('第一次就是 save（更新舊流程）：保留舊的 createdAt，且舊流程不會從清單消失', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);
        const other = `flow_${OWNER}_1700000000001_zzz999aaa`;
        await seedLegacy(OWNER, 'default', other, { name: '另一個舊流程' });

        const res = await save(OWNER, { id: LEGACY_ID, name: '更新後', nodes: NODES, edges: EDGES });
        assert.equal(res.status, 200);

        const got = (await get(OWNER, LEGACY_ID)).json.flow;
        assert.equal(got.name, '更新後');
        assert.equal(got.createdAt, '2025-12-01T00:00:00.000Z');
        assert.deepEqual((await list(OWNER)).json.flows.map((f) => f.id).sort(), [LEGACY_ID, other].sort());
    });

    it('刪除 copy-forward 過的舊流程後不會復活', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);
        await list(OWNER);
        await del(OWNER, LEGACY_ID);

        assert.deepEqual((await list(OWNER)).json.flows, []);
        assert.equal((await get(OWNER, LEGACY_ID)).status, 404);
    });

    it('第一次就是 delete：舊流程被刪除且不會復活', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);
        const res = await del(OWNER, LEGACY_ID);
        assert.equal(res.status, 200);
        assert.deepEqual((await list(OWNER)).json.flows, []);
    });

    it('舊的 default 資料只歸屬第一個被打開的 bot，另一個 bot 不會看到', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);

        assert.equal((await list(OWNER, { 'X-Bot-Id': BOT_B })).json.flows.length, 1);
        assert.deepEqual((await list(OWNER, { 'X-Bot-Id': BOT_A })).json.flows, []);
        assert.equal((await get(OWNER, LEGACY_ID, { 'X-Bot-Id': BOT_A })).status, 404);
        // B 仍然看得到（且之後每次都一樣）
        assert.equal((await list(OWNER, { 'X-Bot-Id': BOT_B })).json.flows.length, 1);
    });

    it('舊 key 若明確帶著 botId（flow_<userId>_<botId>_*），只屬於那個 bot', async () => {
        const idB = `flow_${OWNER}_1700000000002_bbbbbbbbb`;
        await seedLegacy(OWNER, BOT_B, idB, { name: 'B 專屬舊流程' });

        assert.deepEqual((await list(OWNER, { 'X-Bot-Id': BOT_A })).json.flows, []);
        const inB = await list(OWNER, { 'X-Bot-Id': BOT_B });
        assert.deepEqual(inB.json.flows.map((f) => f.id), [idB]);
        assert.equal(inB.json.flows[0].name, 'B 專屬舊流程');
    });

    it('舊資料只屬於它的作者：另一位成員打開同一個 bot 不會讀到 owner 的舊 key', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID);
        // ADMIN 先打開 → 不應把 OWNER 的舊流程標記成已匯入
        assert.deepEqual((await list(ADMIN)).json.flows, []);
        // OWNER 之後打開，仍然拿得回自己的舊流程
        assert.deepEqual((await list(OWNER)).json.flows.map((f) => f.id), [LEGACY_ID]);
        // 匯入之後 ADMIN 也看得到（bot 內共享）
        assert.deepEqual((await list(ADMIN)).json.flows.map((f) => f.id), [LEGACY_ID]);
    });

    it('已經在 bot 命名空間的流程優先，不會被舊資料覆蓋', async () => {
        await seedLegacy(OWNER, 'default', LEGACY_ID, { name: '舊版內容' });
        await kv.put(
            BotKeys.flow(BOT_A, LEGACY_ID),
            JSON.stringify({ id: LEGACY_ID, name: '新版內容', botId: BOT_A, nodes: [], edges: [], createdAt: 'c', updatedAt: 'u' })
        );
        await kv.put(BotKeys.flowList(BOT_A), JSON.stringify([LEGACY_ID]));

        assert.equal((await get(OWNER, LEGACY_ID)).json.flow.name, '新版內容');
        assert.equal((await list(OWNER)).json.flows[0].name, '新版內容');
    });

    it('舊清單裡的孤兒 id（資料已不存在）不會讓 list 壞掉', async () => {
        await kv.put(V1Keys.flowList(OWNER, 'default'), JSON.stringify(['flow_ghost', LEGACY_ID]));
        await kv.put(V1Keys.flow(OWNER, 'default', LEGACY_ID), JSON.stringify({ id: LEGACY_ID, name: '活的', nodes: [], edges: [] }));

        const res = await list(OWNER);
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.flows.map((f) => f.id), [LEGACY_ID]);
    });
});

// ── 輸入驗證與錯誤形狀 ───────────────────────────────────

describe('flow handler — 驗證與錯誤', () => {
    it('壞掉的 JSON 回 400', async () => {
        const req = new Request('https://worker.example.com/flow/save', { method: 'POST', body: '{not json' });
        const res = await route(req, env, OWNER, '/flow/save');
        assert.equal(res.status, 400);
    });

    it('flowId 含冒號（試圖跨出命名空間）被拒絕，什麼都不寫', async () => {
        const before = kv._store.size;
        const res = await save(OWNER, { id: `x:y`, name: 'evil', nodes: [], edges: [] });
        assert.equal(res.status, 400);
        assert.equal(kv._store.size, before);

        assert.equal((await get(OWNER, 'a:b')).status, 400);
        assert.equal((await del(OWNER, 'a:b')).status, 400);
    });

    it('id 不是字串被拒絕', async () => {
        const res = await save(OWNER, { id: { $ne: 1 }, name: 'x', nodes: [], edges: [] });
        assert.equal(res.status, 400);
    });

    it('nodes / edges 不是陣列被拒絕', async () => {
        assert.equal((await save(OWNER, { name: 'x', nodes: 'oops', edges: [] })).status, 400);
        assert.equal((await save(OWNER, { name: 'x', nodes: [], edges: {} })).status, 400);
    });

    it('節點過多、資料過大都被拒絕（既有限制保留）', async () => {
        const tooMany = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}` }));
        assert.equal((await save(OWNER, { name: 'x', nodes: tooMany, edges: [] })).status, 400);
        const big = [{ id: 'n', data: { text: 'x'.repeat(1024 * 513) } }];
        assert.equal((await save(OWNER, { name: 'x', nodes: big, edges: [] })).status, 400);
        assert.equal((await list(OWNER)).json.flows.length, 0);
    });

    it('未知的 flow 路由回 404；回應不含 stack', async () => {
        const res = await call(OWNER, 'GET', '/flow/unknown');
        assert.equal(res.status, 404);
        for (const r of [res, await list(STRANGER), await get(OWNER, 'nope')]) {
            assert.ok(!/stack|\.js:\d+/i.test(r.text), r.text);
        }
    });
});
