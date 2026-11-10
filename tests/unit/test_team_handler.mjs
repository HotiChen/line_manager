/**
 * Unit Tests — handler/team.js
 *
 * team.js 是目前唯一走 withPermission 的 handler，也是 botId 統一時會被動到
 * 最多的地方。在改資料模型之前先把現有行為釘住，之後重構才有東西可以對照。
 *
 * 這裡直接測 handler 函式（跳過 route 的 withPermission 包裝），因為權限中間件
 * 本身已經有 test_permission.mjs 覆蓋。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, InviteKeys } from '../../worker_src/lib/kv_schema.js';
import {
    handleListMembers,
    handleAddMember,
    handleRemoveMember,
    handleGenerateInvite,
    handlePreviewInvite,
    handleAcceptInvite,
    handleListInvites,
} from '../../worker_src/handler/team.js';

const BOT_A = 'Ubot00000000000000000000000000a';
const BOT_B = 'Ubot00000000000000000000000000b';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';
const NEWBIE = 'Unewbie000000000000000000000003';

/** 支援 { type: 'json' } 的 KV mock（team.js 每一次讀取都用這個選項） */
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
        put: base.put.bind(base),
        delete: base.delete.bind(base),
        list: base.list.bind(base),
    };
}

function createEnv() {
    return { KV_LINE_STORAGE: createJsonAwareMockKV(), LIFF_ID: '1234-abcd' };
}

function jsonRequest(body, method = 'POST') {
    // GET/HEAD 不能帶 body（undici 會丟錯），而這些 handler 本來就不讀它
    if (method === 'GET' || method === 'HEAD') {
        return new Request('https://worker.example.com/team', { method });
    }
    return new Request('https://worker.example.com/team', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function seedBot(env, botId, users) {
    await env.KV_LINE_STORAGE.put(BotKeys.permissions(botId), JSON.stringify({ users }));
    await env.KV_LINE_STORAGE.put(BotKeys.info(botId), JSON.stringify({ name: `Bot ${botId.slice(-1)}` }));
}

async function readJson(res) {
    return res.json();
}

// ---------------------------------------------------------------------------

describe('handleListMembers', () => {
    let env;
    beforeEach(() => { env = createEnv(); });

    it('回傳成員清單與呼叫者自己的角色', async () => {
        await seedBot(env, BOT_A, [
            { userId: OWNER, role: 'owner', displayName: 'Tim' },
            { userId: MEMBER, role: 'member', displayName: 'Amy' },
        ]);

        const res = await handleListMembers(jsonRequest({}, 'GET'), env, OWNER, BOT_A, 'owner');
        const body = await readJson(res);

        assert.equal(res.status, 200);
        assert.equal(body.members.length, 2);
        assert.equal(body.currentUserRole, 'owner');
    });

    it('bot 沒有權限資料時回 404', async () => {
        const res = await handleListMembers(jsonRequest({}, 'GET'), env, OWNER, BOT_A, 'owner');
        assert.equal(res.status, 404);
    });
});

describe('handleAddMember', () => {
    let env;
    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [{ userId: OWNER, role: 'owner', displayName: 'Tim' }]);
    });

    it('新增成員後，反向索引 user_bots 也要跟著建立', async () => {
        const res = await handleAddMember(
            jsonRequest({ newUserId: NEWBIE, newRole: 'member', displayName: 'Bob' }),
            env, OWNER, BOT_A, 'owner'
        );
        const body = await readJson(res);

        assert.equal(body.success, true);
        assert.equal(body.member.addedBy, OWNER);

        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        assert.equal(perms.users.length, 2);

        // 反向索引是「邀請來的同事登入後看不看得到東西」的關鍵
        const userBots = await env.KV_LINE_STORAGE.get(UserKeys.bots(NEWBIE), { type: 'json' });
        assert.ok(userBots, 'user_bots 必須被建立');
        assert.equal(userBots.bots[0].botId, BOT_A);
        assert.equal(userBots.currentBotId, BOT_A, '第一個 bot 要自動設為當前');
    });

    it('重複新增同一個人要被擋下', async () => {
        await handleAddMember(jsonRequest({ newUserId: NEWBIE }), env, OWNER, BOT_A, 'owner');
        const res = await handleAddMember(jsonRequest({ newUserId: NEWBIE }), env, OWNER, BOT_A, 'owner');

        assert.equal(res.status, 400);
        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        assert.equal(perms.users.length, 2, '不可被加進去兩次');
    });

    it('缺少 newUserId 回 400', async () => {
        const res = await handleAddMember(jsonRequest({}), env, OWNER, BOT_A, 'owner');
        assert.equal(res.status, 400);
    });
});

describe('handleRemoveMember', () => {
    let env;
    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [
            { userId: OWNER, role: 'owner' },
            { userId: MEMBER, role: 'member' },
        ]);
        await env.KV_LINE_STORAGE.put(UserKeys.bots(MEMBER), JSON.stringify({
            bots: [{ botId: BOT_A, role: 'member' }, { botId: BOT_B, role: 'member' }],
            currentBotId: BOT_A,
        }));
    });

    it('移除成員時也要清掉他的反向索引，並改掉 currentBotId', async () => {
        const res = await handleRemoveMember(
            jsonRequest({ targetUserId: MEMBER }), env, OWNER, BOT_A, 'owner'
        );

        assert.equal(res.status, 200);

        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        assert.equal(perms.users.length, 1);

        const userBots = await env.KV_LINE_STORAGE.get(UserKeys.bots(MEMBER), { type: 'json' });
        assert.deepEqual(userBots.bots.map(b => b.botId), [BOT_B]);
        assert.equal(userBots.currentBotId, BOT_B, 'currentBotId 指向已被移除的 bot 會讓他整個後台空白');
    });

    it('不可移除自己', async () => {
        const res = await handleRemoveMember(
            jsonRequest({ targetUserId: OWNER }), env, OWNER, BOT_A, 'owner'
        );
        assert.equal(res.status, 400);
    });

    it('移除不在團隊裡的人回 404', async () => {
        const res = await handleRemoveMember(
            jsonRequest({ targetUserId: NEWBIE }), env, OWNER, BOT_A, 'owner'
        );
        assert.equal(res.status, 404);
    });
});

describe('handleGenerateInvite', () => {
    let env;
    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [{ userId: OWNER, role: 'owner' }, { userId: MEMBER, role: 'member' }]);
        await seedBot(env, BOT_B, [{ userId: MEMBER, role: 'owner' }]);
    });

    it('owner 可以為自己的 bot 產生邀請', async () => {
        const res = await handleGenerateInvite(jsonRequest({}), env, OWNER, BOT_A, 'owner');
        const body = await readJson(res);

        assert.equal(body.success, true);
        assert.ok(body.token);

        const stored = await env.KV_LINE_STORAGE.get(InviteKeys.token(body.token), { type: 'json' });
        assert.deepEqual(stored.botIds, [BOT_A]);
        assert.equal(stored.used, false);
        assert.equal(stored.createdBy, OWNER);
    });

    it('不可為自己不是 owner 的 bot 產生邀請（橫向越權）', async () => {
        // OWNER 在 BOT_B 裡根本不存在
        const res = await handleGenerateInvite(
            jsonRequest({ targetBotIds: [BOT_B] }), env, OWNER, BOT_A, 'owner'
        );
        assert.equal(res.status, 403);
    });

    it('只要清單裡有一個 bot 沒有 owner 權限，整批都要拒絕', async () => {
        const res = await handleGenerateInvite(
            jsonRequest({ targetBotIds: [BOT_A, BOT_B] }), env, OWNER, BOT_A, 'owner'
        );
        assert.equal(res.status, 403);

        const list = await env.KV_LINE_STORAGE.list({ prefix: 'invite' });
        assert.equal(list.keys.length, 0, '被拒絕時不可留下任何 token');
    });

    it('只是 member 不能產生邀請', async () => {
        const res = await handleGenerateInvite(
            jsonRequest({ targetBotIds: [BOT_A] }), env, MEMBER, BOT_A, 'member'
        );
        assert.equal(res.status, 403);
    });

    it('bot 不存在時回 404', async () => {
        const res = await handleGenerateInvite(
            jsonRequest({ targetBotIds: ['Ughost000000000000000000000000'] }), env, OWNER, BOT_A, 'owner'
        );
        assert.equal(res.status, 404);
    });
});

describe('handlePreviewInvite', () => {
    let env;
    let token;

    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [{ userId: OWNER, role: 'owner' }]);
        const res = await handleGenerateInvite(jsonRequest({}), env, OWNER, BOT_A, 'owner');
        token = (await readJson(res)).token;
    });

    it('回傳 bot 名稱，且不洩漏敏感欄位', async () => {
        const res = await handlePreviewInvite(jsonRequest({ token }), env);
        const body = await readJson(res);

        assert.equal(body.success, true);
        assert.equal(body.bots[0].botId, BOT_A);
        assert.equal(body.bots[0].name, 'Bot a');
        assert.equal(body.used, undefined, '預覽不該回傳 used 之類的內部狀態');
    });

    it('無效 token 回 404', async () => {
        const res = await handlePreviewInvite(jsonRequest({ token: 'not-a-token' }), env);
        assert.equal(res.status, 404);
    });

    it('缺 token 回 400', async () => {
        const res = await handlePreviewInvite(jsonRequest({}), env);
        assert.equal(res.status, 400);
    });
});

describe('handleAcceptInvite', () => {
    let env;
    let token;

    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [{ userId: OWNER, role: 'owner' }]);
        await seedBot(env, BOT_B, [{ userId: OWNER, role: 'owner' }]);
        const res = await handleGenerateInvite(
            jsonRequest({ targetBotIds: [BOT_A, BOT_B], inviteRole: 'member' }),
            env, OWNER, BOT_A, 'owner'
        );
        token = (await readJson(res)).token;
    });

    it('接受邀請後加入所有 bot，並建立反向索引', async () => {
        const res = await handleAcceptInvite(
            jsonRequest({ token, displayName: 'Bob' }), env, NEWBIE
        );
        const body = await readJson(res);

        assert.equal(body.success, true);
        assert.deepEqual(body.joinedBots, [BOT_A, BOT_B]);

        for (const botId of [BOT_A, BOT_B]) {
            const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(botId), { type: 'json' });
            assert.ok(perms.users.find(u => u.userId === NEWBIE), `${botId} 要有這個人`);
        }

        const userBots = await env.KV_LINE_STORAGE.get(UserKeys.bots(NEWBIE), { type: 'json' });
        assert.deepEqual(userBots.bots.map(b => b.botId), [BOT_A, BOT_B]);
    });

    it('身分一律取認證傳入的 userId，body 裡的 userId 要被忽略（SEC-001）', async () => {
        await handleAcceptInvite(
            jsonRequest({ token, userId: OWNER, displayName: 'Bob' }), env, NEWBIE
        );

        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        const added = perms.users.filter(u => u.userId === NEWBIE);
        assert.equal(added.length, 1, '加入的必須是認證身分');
        assert.equal(perms.users.filter(u => u.userId === OWNER).length, 1, 'owner 不可被重複加入');
    });

    it('token 用過一次就失效', async () => {
        await handleAcceptInvite(jsonRequest({ token }), env, NEWBIE);
        const res = await handleAcceptInvite(jsonRequest({ token }), env, MEMBER);

        assert.equal(res.status, 400);
        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        assert.equal(perms.users.find(u => u.userId === MEMBER), undefined);
    });

    it('已經是成員時不重複加入，但仍算成功', async () => {
        const res = await handleAcceptInvite(jsonRequest({ token }), env, OWNER);
        const body = await readJson(res);

        assert.equal(body.success, true);
        const perms = await env.KV_LINE_STORAGE.get(BotKeys.permissions(BOT_A), { type: 'json' });
        assert.equal(perms.users.filter(u => u.userId === OWNER).length, 1);
    });

    it('無效 token 回 404', async () => {
        const res = await handleAcceptInvite(jsonRequest({ token: 'bogus' }), env, NEWBIE);
        assert.equal(res.status, 404);
    });

    it('缺 userId 回 400', async () => {
        const res = await handleAcceptInvite(jsonRequest({ token }), env, null);
        assert.equal(res.status, 400);
    });
});

describe('handleListInvites', () => {
    let env;
    beforeEach(async () => {
        env = createEnv();
        await seedBot(env, BOT_A, [{ userId: OWNER, role: 'owner' }]);
    });

    it('依建立時間新到舊排序', async () => {
        const first = await readJson(await handleGenerateInvite(jsonRequest({}), env, OWNER, BOT_A, 'owner'));
        // 讓兩筆的 createdAt 不同
        await new Promise(resolve => setTimeout(resolve, 5));
        const second = await readJson(await handleGenerateInvite(jsonRequest({}), env, OWNER, BOT_A, 'owner'));

        const res = await handleListInvites(jsonRequest({}, 'GET'), env, OWNER);
        const body = await readJson(res);

        assert.equal(body.invites.length, 2);
        assert.equal(body.invites[0].token, second.token);
        assert.equal(body.invites[1].token, first.token);
    });

    it('沒有邀請時回空陣列', async () => {
        const res = await handleListInvites(jsonRequest({}, 'GET'), env, OWNER);
        const body = await readJson(res);
        assert.deepEqual(body.invites, []);
    });
});
