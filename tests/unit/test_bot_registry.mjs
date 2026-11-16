/**
 * Unit Tests — lib/bot_registry.js（ensureBotRecords）
 *
 * 問題：/token/register 只寫 access_tokens_* 與 destination_user_*，不建立 bot 層級的
 * owner / info / permissions，也不更新 user:bots。這三筆只有 migration 會寫，所以新註冊的
 * 使用者呼叫任何 withPermission 的路由（/team/*、/api/v1/systems、/member/demo/*）一律 403。
 *
 * 規則：
 *   - 缺什麼補什麼，已存在的絕不覆蓋（permissions 裡可能已有受邀成員，重設等於把人踢出去）
 *   - 冪等：第二次呼叫不寫任何東西
 *   - 形狀與 migration/migrate.js 回填的一致
 *   - currentBotId 只在沒有時才設，不動使用者自己切換的結果
 *   - botId / userId 不合法（空、含 ":"）→ 什麼都不寫
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { ensureBotRecords } from '../../worker_src/lib/bot_registry.js';
import { checkPermission } from '../../worker_src/middleware/permission.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const USER = 'Uowner0000000000000000000000001';
const INVITED = 'Uinvited00000000000000000000003';

let env;
const read = async (k) => { const r = await env.KV_LINE_STORAGE.get(k); return r === null ? null : JSON.parse(r); };
const args = (over = {}) => ({ botId: BOT, userId: USER, displayName: '某官方帳號', project: '品禔', ...over });

beforeEach(() => { env = { KV_LINE_STORAGE: createMockKV() }; });

describe('從零建立', () => {
    it('建立 owner、info、permissions、user:bots', async () => {
        const r = await ensureBotRecords(env, args());
        assert.deepEqual(r.created.sort(), ['info', 'owner', 'permissions', 'userBots']);

        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.owner(BOT)), USER);
        const info = await read(BotKeys.info(BOT));
        assert.equal(info.botId, BOT);
        assert.equal(info.displayName, '某官方帳號');
        assert.equal(info.createdBy, USER);
        assert.equal(info.originalProjectName, '品禔');

        const perms = await read(BotKeys.permissions(BOT));
        assert.equal(perms.users.length, 1);
        assert.equal(perms.users[0].userId, USER);
        assert.equal(perms.users[0].role, 'owner');

        const bots = await read(UserKeys.bots(USER));
        assert.equal(bots.currentBotId, BOT);
        assert.deepEqual(bots.bots.map((b) => b.botId), [BOT]);
        assert.equal(bots.bots[0].role, 'owner');
    });

    it('做完之後 checkPermission 通過，且角色是 owner（不用帶 X-Bot-Id）', async () => {
        await ensureBotRecords(env, args());
        const check = await checkPermission(new Request('https://x/team/members'), env, USER);
        assert.equal(check.success, true);
        assert.equal(check.botId, BOT);
        assert.equal(check.role, 'owner');
    });

    it('displayName 缺少時用專案名稱', async () => {
        await ensureBotRecords(env, args({ displayName: undefined }));
        assert.equal((await read(BotKeys.info(BOT))).displayName, '品禔');
    });
});

describe('冪等與不覆蓋', () => {
    it('第二次呼叫不寫任何東西', async () => {
        await ensureBotRecords(env, args());
        env.KV_LINE_STORAGE._resetOps();
        const r = await ensureBotRecords(env, args());
        assert.deepEqual(r.created, []);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
    });

    it('permissions 已有受邀成員時原樣保留', async () => {
        const existing = { users: [{ userId: USER, role: 'owner' }, { userId: INVITED, role: 'member' }] };
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT), JSON.stringify(existing));
        const r = await ensureBotRecords(env, args());
        assert.ok(!r.created.includes('permissions'));
        assert.deepEqual(await read(BotKeys.permissions(BOT)), existing);
    });

    it('已存在的 owner 與 info 不被覆蓋', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.owner(BOT), 'Uprevious00000000000000000000009');
        await env.KV_LINE_STORAGE.put(BotKeys.info(BOT), JSON.stringify({ botId: BOT, displayName: '舊名稱' }));
        await ensureBotRecords(env, args());
        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.owner(BOT)), 'Uprevious00000000000000000000009');
        assert.equal((await read(BotKeys.info(BOT))).displayName, '舊名稱');
    });

    it('只缺其中一筆時只補那一筆', async () => {
        await ensureBotRecords(env, args());
        await env.KV_LINE_STORAGE.delete(BotKeys.info(BOT));
        const r = await ensureBotRecords(env, args());
        assert.deepEqual(r.created, ['info']);
    });
});

describe('user:bots', () => {
    it('保留既有的 bot 與其他欄位，只補上缺的', async () => {
        await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({
            bots: [{ botId: BOT2, role: 'member', displayName: '別人的', joinedAt: 'x' }],
            currentBotId: BOT2,
            extra: 'keep',
        }));
        await ensureBotRecords(env, args());
        const bots = await read(UserKeys.bots(USER));
        assert.deepEqual(bots.bots.map((b) => b.botId), [BOT2, BOT]);
        assert.equal(bots.bots[0].role, 'member');
        assert.equal(bots.extra, 'keep');
    });

    it('currentBotId 已有值時不動（那是使用者自己切換的結果）', async () => {
        await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({ bots: [{ botId: BOT2 }], currentBotId: BOT2 }));
        await ensureBotRecords(env, args());
        assert.equal((await read(UserKeys.bots(USER))).currentBotId, BOT2);
    });

    it('currentBotId 是 null 時才補', async () => {
        await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({ bots: [], currentBotId: null }));
        await ensureBotRecords(env, args());
        assert.equal((await read(UserKeys.bots(USER))).currentBotId, BOT);
    });

    it('makeCurrent:false 時加進清單但不設 currentBotId', async () => {
        await ensureBotRecords(env, args(), { makeCurrent: false });
        const bots = await read(UserKeys.bots(USER));
        assert.deepEqual(bots.bots.map((b) => b.botId), [BOT]);
        assert.equal(bots.currentBotId, null);
    });

    it('清單裡已有這個 bot 時不重複加', async () => {
        await ensureBotRecords(env, args());
        await ensureBotRecords(env, args());
        assert.equal((await read(UserKeys.bots(USER))).bots.length, 1);
    });
});

describe('輸入不合法', () => {
    for (const [name, over] of [
        ['botId 為空', { botId: '' }],
        ['botId 含冒號', { botId: 'bot:evil' }],
        ['botId 不是字串', { botId: 123 }],
        ['userId 為空', { userId: '' }],
        ['userId 含冒號', { userId: 'user:evil' }],
    ]) {
        it(`${name} → 略過，什麼都不寫`, async () => {
            const r = await ensureBotRecords(env, args(over));
            assert.equal(r.skipped, true);
            assert.deepEqual(r.created, []);
            assert.equal(env.KV_LINE_STORAGE._store.size, 0);
        });
    }

    it('沒有 KV binding → 略過，不丟錯', async () => {
        const r = await ensureBotRecords({}, args());
        assert.equal(r.skipped, true);
    });
});
