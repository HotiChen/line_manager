/**
 * Unit Tests — handler/flow.js
 *
 * 重點：
 *   1. 路由一律走 withPermission：沒權限的 bot（含偽造 X-Bot-Id）→ 403
 *   2. botId 由 withPermission 注入（不再讀從未被寫入的 token_${userId}，那會讓所有 bot 共用 "default"）
 *   3. 存檔前驗證 flow 格式；flowId 只允許安全字元
 *   4. 舊資料（存在 "default" 命名空間）讀得到，存檔時搬到正確的 bot 底下
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import {
    route,
    handleSaveFlow,
    handleListFlows,
    handleGetFlow,
    handleDeleteFlow,
    handleListVersions,
} from '../../worker_src/handler/flow.js';

const USER = 'Uuser00000000000000000000000001';
const OTHER = 'Uother0000000000000000000000002';
const BOT_A = 'Ubot00000000000000000000000000a';
const BOT_B = 'Ubot00000000000000000000000000b';

/** permission.js 用 get(key, { type: 'json' })，基礎 mock 不支援，這裡補上 */
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
        },
    };
}

const node = (id, type = 'message_text') => ({ id, type, position: { x: 10, y: 20 }, data: { text: 'hi' } });

function req(method, path, { body, headers = {} } = {}) {
    return new Request(`https://example.test${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
}

async function json(res) {
    return { status: res.status, body: await res.json() };
}

let env;
beforeEach(async () => {
    env = { KV_LINE_STORAGE: createJsonAwareMockKV() };
    // USER 可操作 BOT_A（目前所選）；BOT_B 只屬於 OTHER
    await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({ currentBotId: BOT_A, bots: [BOT_A] }));
    await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_A), JSON.stringify({ users: [{ userId: USER, role: 'owner' }] }));
    await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_B), JSON.stringify({ users: [{ userId: OTHER, role: 'owner' }] }));
});

describe('route — 授權', () => {
    it('沒有任何 bot 的使用者 → 403', async () => {
        const res = await route(req('GET', '/flow/list'), env, 'Unobody', '/flow/list');
        assert.equal(res.status, 403);
    });

    it('X-Bot-Id 指向沒權限的 bot → 403，且不寫入任何資料', async () => {
        const before = env.KV_LINE_STORAGE._store.size;
        const res = await route(
            req('POST', '/flow/save', { body: { name: 'x', nodes: [], edges: [] }, headers: { 'X-Bot-Id': BOT_B } }),
            env, USER, '/flow/save',
        );
        assert.equal(res.status, 403);
        assert.equal(env.KV_LINE_STORAGE._store.size, before);
    });

    it('沒帶 X-Bot-Id 時用使用者目前所選的 bot', async () => {
        const res = await route(req('POST', '/flow/save', { body: { name: 'A 的流程', nodes: [node('n1')], edges: [] } }), env, USER, '/flow/save');
        const { status, body } = await json(res);
        assert.equal(status, 200);
        assert.ok(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${body.flowId}`));
    });

    it('未知路由 → 404', async () => {
        const res = await route(req('GET', '/flow/nope'), env, USER, '/flow/nope');
        assert.equal(res.status, 404);
    });
});

describe('handleSaveFlow', () => {
    it('新建：產生不含 userId 的 flowId，寫入 flow、list、version', async () => {
        const { status, body } = await json(await handleSaveFlow(
            req('POST', '/flow/save', { body: { name: '<b>主選單</b>', nodes: [node('n1', 'keyword'), node('n2')], edges: [{ source: 'n1', target: 'n2' }] } }),
            env, USER, BOT_A,
        ));
        assert.equal(status, 200);
        assert.match(body.flowId, /^flow_\d+_[a-z0-9]+$/);
        assert.ok(!body.flowId.includes(USER));

        const saved = JSON.parse(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${body.flowId}`));
        assert.equal(saved.name, '主選單');
        assert.equal(saved.botId, BOT_A);
        assert.equal(saved.nodes.length, 2);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_${BOT_A}`)), [body.flowId]);

        const versions = await env.KV_LINE_STORAGE.list({ prefix: `flow_version_${USER}_${BOT_A}_${body.flowId}_` });
        assert.equal(versions.keys.length, 1);
    });

    it('更新：保留 createdAt，list 不重複', async () => {
        const first = (await json(await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'v1', nodes: [] } }), env, USER, BOT_A))).body;
        const created = JSON.parse(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${first.flowId}`)).createdAt;

        await handleSaveFlow(req('POST', '/flow/save', { body: { id: first.flowId, name: 'v2', nodes: [] } }), env, USER, BOT_A);
        const saved = JSON.parse(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${first.flowId}`));
        assert.equal(saved.name, 'v2');
        assert.equal(saved.createdAt, created);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_${BOT_A}`)), [first.flowId]);
    });

    it('不合法 JSON → 400', async () => {
        const res = await handleSaveFlow(req('POST', '/flow/save', { body: '{bad' }), env, USER, BOT_A);
        assert.equal(res.status, 400);
    });

    it('格式不合法（未知節點類型）→ 400 並附 details，不寫入', async () => {
        const before = env.KV_LINE_STORAGE._store.size;
        const { status, body } = await json(await handleSaveFlow(
            req('POST', '/flow/save', { body: { name: 'x', nodes: [node('n1', 'evil')] } }), env, USER, BOT_A,
        ));
        assert.equal(status, 400);
        assert.ok(Array.isArray(body.details) && body.details.length > 0);
        assert.equal(env.KV_LINE_STORAGE._store.size, before);
    });

    it('flowId 含不安全字元 → 400', async () => {
        const res = await handleSaveFlow(req('POST', '/flow/save', { body: { id: 'x:../y', nodes: [] } }), env, USER, BOT_A);
        assert.equal(res.status, 400);
    });

    it('body 超過 512KB → 400', async () => {
        const big = 'x'.repeat(600 * 1024);
        const res = await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'x', nodes: [{ ...node('n1'), data: { big } }] } }), env, USER, BOT_A);
        assert.equal(res.status, 400);
    });

    it('存舊資料（default 命名空間）的 flow → 搬到目前 bot，舊 key 與舊 list 清掉', async () => {
        const legacyId = `flow_${USER}_1700000000000_abc123def`;
        await env.KV_LINE_STORAGE.put(`flow_${USER}_default_${legacyId}`, JSON.stringify({ id: legacyId, name: 'old', nodes: [], edges: [], createdAt: '2025-01-01T00:00:00.000Z' }));
        await env.KV_LINE_STORAGE.put(`flow_list_${USER}_default`, JSON.stringify([legacyId]));

        await handleSaveFlow(req('POST', '/flow/save', { body: { id: legacyId, name: 'old', nodes: [] } }), env, USER, BOT_A);

        const moved = JSON.parse(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${legacyId}`));
        assert.equal(moved.createdAt, '2025-01-01T00:00:00.000Z');
        assert.equal(await env.KV_LINE_STORAGE.get(`flow_${USER}_default_${legacyId}`), null);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_default`)), []);
    });
});

describe('handleListFlows', () => {
    it('只列出目前 bot 的 flow（不同 bot 互不可見）', async () => {
        const a = (await json(await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'A', nodes: [node('n1')] } }), env, USER, BOT_A))).body;
        await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'B', nodes: [] } }), env, USER, BOT_B);

        const { body } = await json(await handleListFlows(req('GET', '/flow/list'), env, USER, BOT_A));
        assert.deepEqual(body.flows.map((f) => f.id), [a.flowId]);
        assert.equal(body.flows[0].nodeCount, 1);
    });

    it('一併列出舊 default 命名空間的 flow，標 legacy', async () => {
        const legacyId = 'flow_legacy_1';
        await env.KV_LINE_STORAGE.put(`flow_${USER}_default_${legacyId}`, JSON.stringify({ id: legacyId, name: 'old', nodes: [], edges: [] }));
        await env.KV_LINE_STORAGE.put(`flow_list_${USER}_default`, JSON.stringify([legacyId]));

        const { body } = await json(await handleListFlows(req('GET', '/flow/list'), env, USER, BOT_A));
        assert.equal(body.flows.length, 1);
        assert.equal(body.flows[0].legacy, true);
    });

    it('清掉 list 裡的孤兒 id', async () => {
        await env.KV_LINE_STORAGE.put(`flow_list_${USER}_${BOT_A}`, JSON.stringify(['ghost']));
        const { body } = await json(await handleListFlows(req('GET', '/flow/list'), env, USER, BOT_A));
        assert.deepEqual(body.flows, []);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_${BOT_A}`)), []);
    });
});

describe('handleGetFlow / handleDeleteFlow / handleListVersions', () => {
    it('get：找得到 → 200；別的 bot 的 → 404；不合法 id → 400', async () => {
        const { flowId } = (await json(await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'A', nodes: [] } }), env, USER, BOT_A))).body;
        assert.equal((await handleGetFlow(req('GET', '/'), env, USER, BOT_A, 'owner', flowId)).status, 200);
        assert.equal((await handleGetFlow(req('GET', '/'), env, USER, BOT_B, 'owner', flowId)).status, 404);
        assert.equal((await handleGetFlow(req('GET', '/'), env, USER, BOT_A, 'owner', 'a:b')).status, 400);
    });

    it('get：fallback 到舊 default 命名空間', async () => {
        await env.KV_LINE_STORAGE.put(`flow_${USER}_default_old1`, JSON.stringify({ id: 'old1', name: 'old', nodes: [], edges: [] }));
        const { status, body } = await json(await handleGetFlow(req('GET', '/'), env, USER, BOT_A, 'owner', 'old1'));
        assert.equal(status, 200);
        assert.equal(body.flow.name, 'old');
    });

    it('delete：刪 flow 與 list 項目（新舊命名空間都清）', async () => {
        const { flowId } = (await json(await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'A', nodes: [] } }), env, USER, BOT_A))).body;
        await env.KV_LINE_STORAGE.put(`flow_${USER}_default_old1`, '{}');
        await env.KV_LINE_STORAGE.put(`flow_list_${USER}_default`, JSON.stringify(['old1']));

        await handleDeleteFlow(req('DELETE', '/'), env, USER, BOT_A, 'owner', flowId);
        await handleDeleteFlow(req('DELETE', '/'), env, USER, BOT_A, 'owner', 'old1');

        assert.equal(await env.KV_LINE_STORAGE.get(`flow_${USER}_${BOT_A}_${flowId}`), null);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_${BOT_A}`)), []);
        assert.equal(await env.KV_LINE_STORAGE.get(`flow_${USER}_default_old1`), null);
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(`flow_list_${USER}_default`)), []);
    });

    it('versions：列出該 flow 的版本，新到舊', async () => {
        const { flowId } = (await json(await handleSaveFlow(req('POST', '/flow/save', { body: { name: 'v1', nodes: [] } }), env, USER, BOT_A))).body;
        await new Promise((r) => setTimeout(r, 5));
        await handleSaveFlow(req('POST', '/flow/save', { body: { id: flowId, name: 'v2', nodes: [] } }), env, USER, BOT_A);

        const { status, body } = await json(await handleListVersions(req('GET', '/'), env, USER, BOT_A, 'owner', flowId));
        assert.equal(status, 200);
        assert.equal(body.versions.length, 2);
        assert.equal(body.versions[0].name, 'v2');
    });
});

describe('發布 /flow/publish /flow/unpublish /flow/published', () => {
    const MEMBER = 'Umember000000000000000000000004';
    const okFlow = {
        name: '客服',
        nodes: [
            { id: 'k', type: 'keyword', position: { x: 0, y: 0 }, data: { keyword: '你好', matchType: 'exact' } },
            { id: 't', type: 'message_text', position: { x: 1, y: 0 }, data: { text: '哈囉' } },
        ],
        edges: [{ source: 'k', target: 't', sourceHandle: 'default' }],
    };
    const save = async (body, user = USER, bot = BOT_A) =>
        (await json(await handleSaveFlow(req('POST', '/flow/save', { body }), env, user, bot))).body.flowId;

    it('通過檢查 → 寫入已發布版本；GET 看得到；再發布另一份會取代', async () => {
        const id = await save(okFlow);
        const { status, body } = await json(await route(req('POST', `/flow/publish/${id}`), env, USER, `/flow/publish/${id}`));
        assert.equal(status, 200);
        assert.deepEqual(body.published.keywords, ['你好']);

        const got = (await json(await route(req('GET', '/flow/published'), env, USER, '/flow/published'))).body;
        assert.equal(got.published.flowId, id);

        const id2 = await save({ ...okFlow, name: '另一份' });
        await route(req('POST', `/flow/publish/${id2}`), env, USER, `/flow/publish/${id2}`);
        const again = (await json(await route(req('GET', '/flow/published'), env, USER, '/flow/published'))).body;
        assert.equal(again.published.name, '另一份');
    });

    it('檢查沒過 → 400 附節點錯誤，且不動目前已發布的版本', async () => {
        const good = await save(okFlow);
        await route(req('POST', `/flow/publish/${good}`), env, USER, `/flow/publish/${good}`);

        const bad = await save({ name: 'bad', nodes: [{ id: 'k', type: 'keyword', position: { x: 0, y: 0 }, data: { keyword: '' } }], edges: [] });
        const { status, body } = await json(await route(req('POST', `/flow/publish/${bad}`), env, USER, `/flow/publish/${bad}`));
        assert.equal(status, 400);
        assert.equal(body.errors[0].nodeId, 'k');

        const got = (await json(await route(req('GET', '/flow/published'), env, USER, '/flow/published'))).body;
        assert.equal(got.published.flowId, good);
    });

    it('只有 owner 能發布 / 取消發布；成員只能看', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_A), JSON.stringify({ users: [{ userId: USER, role: 'owner' }, { userId: MEMBER, role: 'member' }] }));
        await env.KV_LINE_STORAGE.put(UserKeys.bots(MEMBER), JSON.stringify({ currentBotId: BOT_A, bots: [BOT_A] }));
        const id = await save(okFlow);

        assert.equal((await route(req('POST', `/flow/publish/${id}`), env, MEMBER, `/flow/publish/${id}`)).status, 403);
        assert.equal((await route(req('DELETE', '/flow/unpublish'), env, MEMBER, '/flow/unpublish')).status, 403);
        assert.equal((await route(req('GET', '/flow/published'), env, MEMBER, '/flow/published')).status, 200);
    });

    it('不存在 / 不合法 id；別的 bot 的 flow 不能發布', async () => {
        assert.equal((await route(req('POST', '/flow/publish/ghost'), env, USER, '/flow/publish/ghost')).status, 404);
        assert.equal((await route(req('POST', '/flow/publish/a:b'), env, USER, '/flow/publish/a:b')).status, 400);
        const other = await save(okFlow, OTHER, BOT_B);
        assert.equal((await route(req('POST', `/flow/publish/${other}`), env, USER, `/flow/publish/${other}`)).status, 404);
    });

    it('unpublish 後 GET 回 null', async () => {
        const id = await save(okFlow);
        await route(req('POST', `/flow/publish/${id}`), env, USER, `/flow/publish/${id}`);
        assert.equal((await route(req('DELETE', '/flow/unpublish'), env, USER, '/flow/unpublish')).status, 200);
        const got = (await json(await route(req('GET', '/flow/published'), env, USER, '/flow/published'))).body;
        assert.equal(got.published, null);
    });
});
