/**
 * Unit Tests — token 端點的 channel secret
 *
 *   POST /token/register        可選的 channelSecret：token 驗證通過、取得 destination 之後一併登記
 *   POST /token/channel-secret  { project, channelSecret }：替「已註冊的專案」補上或更新
 *   GET  /token/channel-secret?project=…  → { configured: boolean }，永遠不回密鑰
 *
 * 安全性質：
 *   - botId（destination）只來自呼叫者自己在伺服器端存的 access_tokens，不信任請求內容
 *   - 只能動自己名下的專案
 *   - 密鑰格式驗證；缺加密金鑰回 503，不降級存明文
 *   - 回應與 /token/list 都不含密鑰
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { getChannelSecret } from '../../worker_src/lib/channel_secret.js';
import {
    handleRegisterAccessToken,
    handleSetChannelSecret,
    handleGetChannelSecretStatus,
    handleListUserProjects,
    route,
} from '../../worker_src/handler/token.js';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const OTHER = 'Uddddddddddddddddddddddddddddd02';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const KEY = Buffer.alloc(32, 5).toString('base64');
const SECRET = '0123456789abcdef0123456789abcdef';
const originalFetch = globalThis.fetch;

let env;

function mockBotInfo(destination) {
    globalThis.fetch = async () => new Response(JSON.stringify({ userId: destination, displayName: 'OA' }), { status: 200 });
}
const post = (path, body) => new Request(`https://x${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function registered(project = '品禔', destination = BOT_A, userId = OWNER) {
    mockBotInfo(destination);
    const res = await handleRegisterAccessToken(post('/token/register', { project, token: 'tok-' + project }), env, userId);
    assert.equal(res.status, 200);
}

beforeEach(() => { env = { KV_LINE_STORAGE: createMockKV(), TOKEN_ENCRYPTION_KEY: KEY }; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('POST /token/register 帶 channelSecret', () => {
    it('登記在 destination 這個 bot 底下', async () => {
        mockBotInfo(BOT_A);
        const res = await handleRegisterAccessToken(post('/token/register', { project: '品禔', token: 't', channelSecret: SECRET }), env, OWNER);
        assert.equal(res.status, 200);
        assert.equal(await getChannelSecret(env, BOT_A), SECRET);
    });

    it('回應不含密鑰', async () => {
        mockBotInfo(BOT_A);
        const res = await handleRegisterAccessToken(post('/token/register', { project: '品禔', token: 't', channelSecret: SECRET }), env, OWNER);
        assert.ok(!(await res.text()).includes(SECRET));
    });

    it('不帶 channelSecret 時行為不變（向下相容）', async () => {
        await registered();
        assert.equal(await getChannelSecret(env, BOT_A), null);
    });

    it('格式不合法 → 400，而且 token 也不會被註冊（不留半筆）', async () => {
        mockBotInfo(BOT_A);
        const res = await handleRegisterAccessToken(post('/token/register', { project: '品禔', token: 't', channelSecret: 'bad' }), env, OWNER);
        assert.equal(res.status, 400);
        assert.equal(await env.KV_LINE_STORAGE.get(`access_tokens_${OWNER}`), null);
        assert.equal(await env.KV_LINE_STORAGE.get(`destination_user_${BOT_A}`), null);
    });
});

describe('POST /token/channel-secret', () => {
    it('替已註冊的專案補上密鑰', async () => {
        await registered();
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER);
        assert.equal(res.status, 200);
        assert.equal(await getChannelSecret(env, BOT_A), SECRET);
    });

    it('回應不含密鑰', async () => {
        await registered();
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER);
        assert.ok(!(await res.text()).includes(SECRET));
    });

    it('可以更新（換密鑰）', async () => {
        await registered();
        await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER);
        await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: 'e'.repeat(32) }), env, OWNER);
        assert.equal(await getChannelSecret(env, BOT_A), 'e'.repeat(32));
    });

    it('只能動自己名下的專案：別人的專案名稱 → 404，且不會寫進別人的 bot', async () => {
        await registered('品禔', BOT_A, OWNER);
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OTHER);
        assert.equal(res.status, 404);
        assert.equal(await getChannelSecret(env, BOT_A), null);
    });

    it('botId 不來自請求內容：body 帶 botId/destination 一律忽略', async () => {
        await registered();
        const VICTIM = 'Uvictim000000000000000000000000009';
        await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET, botId: VICTIM, destination: VICTIM }), env, OWNER);
        assert.equal(await getChannelSecret(env, VICTIM), null);
        assert.equal(await getChannelSecret(env, BOT_A), SECRET);
    });

    it('不存在的專案 → 404', async () => {
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: 'ghost', channelSecret: SECRET }), env, OWNER);
        assert.equal(res.status, 404);
    });

    it('專案沒有 destination（舊格式）→ 409，說明要先重新註冊', async () => {
        await env.KV_LINE_STORAGE.put(`access_tokens_${OWNER}`, JSON.stringify({ old: 'plain-legacy-token' }));
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: 'old', channelSecret: SECRET }), env, OWNER);
        assert.equal(res.status, 409);
    });

    it('prototype 名稱（constructor）→ 404', async () => {
        await registered();
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: 'constructor', channelSecret: SECRET }), env, OWNER);
        assert.equal(res.status, 404);
    });

    it('格式不合法 → 400，不寫入', async () => {
        await registered();
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: 'short' }), env, OWNER);
        assert.equal(res.status, 400);
        assert.equal(await getChannelSecret(env, BOT_A), null);
    });

    it('缺 project / 缺 channelSecret / 壞 JSON → 400', async () => {
        await registered();
        assert.equal((await handleSetChannelSecret(post('/token/channel-secret', { channelSecret: SECRET }), env, OWNER)).status, 400);
        assert.equal((await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔' }), env, OWNER)).status, 400);
        assert.equal((await handleSetChannelSecret(post('/token/channel-secret', '{nope'), env, OWNER)).status, 400);
    });

    it('缺加密金鑰 → 503，不存明文', async () => {
        await registered();
        const res = await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), { KV_LINE_STORAGE: env.KV_LINE_STORAGE }, OWNER);
        assert.equal(res.status, 503);
        const raw = await env.KV_LINE_STORAGE.get(BotKeys.credential(BOT_A));
        assert.equal(raw, null);
    });
});

describe('GET /token/channel-secret（狀態）', () => {
    const status = (project, userId = OWNER) =>
        handleGetChannelSecretStatus(new Request(`https://x/token/channel-secret?project=${encodeURIComponent(project)}`), env, userId);

    it('未設定 → configured:false', async () => {
        await registered();
        assert.deepEqual(await (await status('品禔')).json(), { configured: false });
    });

    it('設定後 → configured:true，而且回應沒有密鑰', async () => {
        await registered();
        await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER);
        const res = await status('品禔');
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { configured: true });
        assert.ok(!text.includes(SECRET));
    });

    it('舊格式專案（沒有 botId）→ configured:false 並標 legacy:true，讓前端能說明要重新註冊', async () => {
        await env.KV_LINE_STORAGE.put(`access_tokens_${OWNER}`, JSON.stringify({ old: 'plain-legacy-token' }));
        assert.deepEqual(await (await status('old')).json(), { configured: false, legacy: true });
    });

    it('一般專案的回應不帶 legacy 欄位', async () => {
        await registered();
        assert.deepEqual(await (await status('品禔')).json(), { configured: false });
    });

    it('別人的專案名稱 → 404（不洩漏別人的設定狀態）', async () => {
        await registered();
        assert.equal((await status('品禔', OTHER)).status, 404);
    });

    it('不存在的專案 → 404', async () => {
        assert.equal((await status('ghost')).status, 404);
    });
});

describe('/token/list 不受影響', () => {
    it('值仍是 botId 字串，不含任何密鑰', async () => {
        await registered();
        await handleSetChannelSecret(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER);
        const res = await handleListUserProjects(env, OWNER);
        const text = await res.text();
        assert.equal(JSON.parse(text)['品禔'], BOT_A);
        assert.ok(!text.includes(SECRET));
    });
});

describe('路由', () => {
    it('POST /token/channel-secret 與 GET /token/channel-secret 都接得到', async () => {
        await registered();
        const set = await route(post('/token/channel-secret', { project: '品禔', channelSecret: SECRET }), env, OWNER, '/token/channel-secret');
        assert.equal(set.status, 200);
        const get = await route(new Request('https://x/token/channel-secret?project=%E5%93%81%E7%A6%94'), env, OWNER, '/token/channel-secret');
        assert.equal(get.status, 200);
    });

    it('其他方法 → 405', async () => {
        const res = await route(new Request('https://x/token/channel-secret', { method: 'DELETE' }), env, OWNER, '/token/channel-secret');
        assert.equal(res.status, 405);
    });
});
