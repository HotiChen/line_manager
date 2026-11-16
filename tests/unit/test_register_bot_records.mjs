/**
 * Integration Tests — /token/register 與 migrate 的 mode=repair 會建立 bot 層級紀錄
 *
 * 新註冊的使用者要能立刻用 /team/*、/api/v1/systems 等 withPermission 路由，
 * 不必等 migration。已經註冊、但缺紀錄的使用者用 mode=repair 補。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { handleRegisterAccessToken } from '../../worker_src/handler/token.js';
import { checkPermission } from '../../worker_src/middleware/permission.js';
import { handleMigrate } from '../../worker_src/migration/migrate.js';

const OWNER = 'Uowner0000000000000000000000001';
const OWNER2 = 'Uowner0000000000000000000000002';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const KEY = Buffer.alloc(32, 5).toString('base64');
const SECRET = 'migration-secret-value';
const originalFetch = globalThis.fetch;

let env;
const read = async (k) => { const r = await env.KV_LINE_STORAGE.get(k); return r === null ? null : JSON.parse(r); };
const mockBotInfo = (dest, name = 'OA') => { globalThis.fetch = async () => new Response(JSON.stringify({ userId: dest, displayName: name }), { status: 200 }); };
const register = (userId, project, token = 'tok') => handleRegisterAccessToken(
    new Request('https://x/token/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, token }) }),
    env, userId);

beforeEach(() => { env = { KV_LINE_STORAGE: createMockKV(), TOKEN_ENCRYPTION_KEY: KEY, MIGRATION_SECRET: SECRET }; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('/token/register', () => {
    it('註冊完立刻通過 checkPermission，角色是 owner', async () => {
        mockBotInfo(BOT, '品禔');
        assert.equal((await register(OWNER, '品禔')).status, 200);
        const check = await checkPermission(new Request('https://x/team/members'), env, OWNER);
        assert.equal(check.success, true);
        assert.equal(check.botId, BOT);
        assert.equal(check.role, 'owner');
    });

    it('建立 owner / info / permissions / user:bots', async () => {
        mockBotInfo(BOT, '品禔');
        await register(OWNER, '專案名');
        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.owner(BOT)), OWNER);
        assert.equal((await read(BotKeys.info(BOT))).displayName, '品禔');
        assert.equal((await read(BotKeys.permissions(BOT))).users[0].userId, OWNER);
        assert.equal((await read(UserKeys.bots(OWNER))).currentBotId, BOT);
    });

    it('重新註冊同一個帳號（換 token）不會蓋掉已邀請的成員', async () => {
        mockBotInfo(BOT);
        await register(OWNER, 'p');
        const perms = await read(BotKeys.permissions(BOT));
        perms.users.push({ userId: 'Uinvited00000000000000000000003', role: 'member' });
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT), JSON.stringify(perms));

        await register(OWNER, 'p', 'new-token');
        assert.equal((await read(BotKeys.permissions(BOT))).users.length, 2);
    });

    it('兩位 owner 各註冊自己的 OA，互不影響', async () => {
        mockBotInfo(BOT);
        await register(OWNER, 'a');
        mockBotInfo(BOT2);
        await register(OWNER2, 'b');
        assert.equal((await checkPermission(new Request('https://x/'), env, OWNER)).botId, BOT);
        assert.equal((await checkPermission(new Request('https://x/'), env, OWNER2)).botId, BOT2);
        assert.equal((await checkPermission(new Request('https://x/', { headers: { 'X-Bot-Id': BOT2 } }), env, OWNER)).success, false);
    });

    it('建立紀錄失敗不會讓註冊變成 500（token 已經存好，之後可用 repair 補）', async () => {
        const kv = env.KV_LINE_STORAGE;
        const origPut = kv.put.bind(kv);
        kv.put = async (k, ...rest) => { if (k.startsWith('bot:') || k.startsWith('user:')) throw new Error('boom'); return origPut(k, ...rest); };
        mockBotInfo(BOT);
        const res = await register(OWNER, 'p');
        assert.equal(res.status, 200);
        assert.ok(await kv.get(`access_tokens_${OWNER}`));
        assert.equal((await res.text()).includes('boom'), false);
    });

    it('LINE token 驗證失敗時，不建立任何 bot 紀錄', async () => {
        globalThis.fetch = async () => new Response('no', { status: 401 });
        assert.equal((await register(OWNER, 'p')).status, 400);
        assert.deepEqual([...env.KV_LINE_STORAGE._store.keys()].filter((k) => k.startsWith('bot:') || k.startsWith('user:')), []);
    });
});

describe('GET /admin/migrate?mode=repair', () => {
    const repair = (qs = '') => handleMigrate(new Request(`https://x/admin/migrate?key=${SECRET}&mode=repair${qs}`), env);

    async function seedLegacyUser(userId, bots) {
        // 舊註冊流程留下的狀態：只有 access_tokens 與 destination_user，沒有 bot 層級紀錄
        const map = {};
        for (const [project, dest, name] of bots) {
            map[project] = { token: 'enc.v1.x', destination: dest, displayName: name };
            await env.KV_LINE_STORAGE.put(`destination_user_${dest}`, userId);
        }
        await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(map));
    }

    it('替缺紀錄的使用者補齊，補完後 checkPermission 通過', async () => {
        await seedLegacyUser(OWNER, [['p', BOT, '品禔']]);
        const body = await (await repair()).json();
        assert.equal(body.success, true);
        assert.equal(body.done, true);
        assert.equal((await checkPermission(new Request('https://x/'), env, OWNER)).role, 'owner');
    });

    it('currentBotId 優先指向 current_token 的專案', async () => {
        await seedLegacyUser(OWNER, [['a', BOT, 'A'], ['b', BOT2, 'B']]);
        await env.KV_LINE_STORAGE.put(`current_token_${OWNER}`, 'b');
        await repair();
        assert.equal((await read(UserKeys.bots(OWNER))).currentBotId, BOT2);
        assert.equal((await read(UserKeys.bots(OWNER))).bots.length, 2);
    });

    it('冪等：再跑一次不寫任何東西', async () => {
        await seedLegacyUser(OWNER, [['p', BOT, '品禔']]);
        await repair();
        env.KV_LINE_STORAGE._resetOps();
        const body = await (await repair()).json();
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
        assert.equal(body.repaired, 0);
    });

    it('不碰受邀成員、不動既有 currentBotId', async () => {
        await seedLegacyUser(OWNER, [['p', BOT, '品禔']]);
        const existing = { users: [{ userId: OWNER, role: 'owner' }, { userId: 'Uinvited00000000000000000000003', role: 'member' }] };
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT), JSON.stringify(existing));
        await env.KV_LINE_STORAGE.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT2 }], currentBotId: BOT2 }));
        await repair();
        assert.deepEqual(await read(BotKeys.permissions(BOT)), existing);
        assert.equal((await read(UserKeys.bots(OWNER))).currentBotId, BOT2);
    });

    it('舊格式專案（沒有 destination）略過，不丟錯', async () => {
        await env.KV_LINE_STORAGE.put(`access_tokens_${OWNER}`, JSON.stringify({ old: 'plain-legacy-token' }));
        const body = await (await repair()).json();
        assert.equal(body.success, true);
        assert.equal(body.repaired, 0);
    });

    it('不複製任何資源（只補 bot 紀錄），也不碰 migration 游標', async () => {
        await seedLegacyUser(OWNER, [['p', BOT, '品禔']]);
        await env.KV_LINE_STORAGE.put(`member_list_${OWNER}`, JSON.stringify(['Um1']));
        await repair();
        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.members(BOT)), null);
        assert.equal(await env.KV_LINE_STORAGE.get('migration:botid:cursor'), null);
    });

    it('分批：batchSize 小於使用者數時回傳 nextCursor，帶著它繼續到 done', async () => {
        await seedLegacyUser(OWNER, [['a', BOT, 'A']]);
        await seedLegacyUser(OWNER2, [['b', BOT2, 'B']]);
        const first = await (await repair('&batchSize=1')).json();
        assert.equal(first.done, false);
        assert.ok(first.nextCursor);
        const second = await (await repair(`&batchSize=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
        assert.equal(second.done, true);
        assert.equal((await checkPermission(new Request('https://x/'), env, OWNER)).success, true);
        assert.equal((await checkPermission(new Request('https://x/'), env, OWNER2)).success, true);
    });

    it('沒有密鑰 → 401；未設定密鑰 → 503（與其他 mode 一致）', async () => {
        const bad = await handleMigrate(new Request('https://x/admin/migrate?key=wrong&mode=repair'), env);
        assert.equal(bad.status, 401);
        const none = await handleMigrate(new Request(`https://x/admin/migrate?key=${SECRET}&mode=repair`), { KV_LINE_STORAGE: env.KV_LINE_STORAGE });
        assert.equal(none.status, 503);
    });

    it('回應不含 token 或密文', async () => {
        await seedLegacyUser(OWNER, [['p', BOT, '品禔']]);
        const text = await (await repair()).text();
        assert.ok(!text.includes('enc.v1.'));
    });
});
