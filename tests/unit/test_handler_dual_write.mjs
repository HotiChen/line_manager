/**
 * Unit Tests — 已切換到 bot_store 的 handler
 *
 * bot_store 自己的行為在 test_bot_store.mjs 釘住了。這裡測的是另一件事：
 * handler 真的改走它了。
 *
 * 每個資源問三個問題：
 *   1. 只有舊 key 有資料時，端點讀得到嗎？（回填還沒跑完的使用者）
 *   2. 端點寫入後，新舊兩邊都有嗎？（雙寫）
 *   3. 新 key 有資料時，端點用的是新的嗎？（切換真的生效）
 *
 * 第 3 題是最重要的 —— 它是「handler 還在偷讀舊 key」唯一會被抓到的地方。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';

import * as flexHandler from '../../worker_src/handler/flex.js';
import * as imageHandler from '../../worker_src/handler/image_msg.js';
import * as imagemapHandler from '../../worker_src/handler/imagemap.js';
import * as quickReplyHandler from '../../worker_src/handler/quick_reply.js';
import * as keywordHandler from '../../worker_src/handler/keyword_reply.js';
import * as segmentedHandler from '../../worker_src/handler/segmented_richmenu.js';
import * as profileHandler from '../../worker_src/handler/profile.js';
import { formatReplyMessage } from '../../worker_src/lib/line_client.js';
import * as memberHandler from '../../worker_src/handler/member.js';
import * as tagHandler from '../../worker_src/handler/tag.js';
import * as tierHandler from '../../worker_src/handler/tier.js';

const USER = 'Uowner00000000000000000000000001';
const BOT = 'Ubot000000000000000000000000001';

function createEnv() {
    return { KV_LINE_STORAGE: createMockKV() };
}

/** 讓 resolveBotId 找得到 botId */
async function seedBot(env) {
    await env.KV_LINE_STORAGE.put(
        UserKeys.bots(USER),
        JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }], currentBotId: BOT })
    );
}

function post(pathname, body) {
    return new Request(`https://worker.example.com${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function get(pathname) {
    return new Request(`https://worker.example.com${pathname}`, { method: 'GET' });
}

/** 把一筆資料直接寫進某一個命名空間（繞過 store，模擬回填前／後的狀態） */
async function seedRaw(env, key, value) {
    await env.KV_LINE_STORAGE.put(key, JSON.stringify(value));
}

async function readRaw(env, key) {
    const raw = await env.KV_LINE_STORAGE.get(key);
    return raw === null ? null : JSON.parse(raw);
}

// ---------------------------------------------------------------------------

describe('flex.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('只有舊 key 有資料時也讀得到', async () => {
        await seedRaw(env, V1Keys.flexList(USER), [{ id: 'f1', name: '舊的' }]);

        const res = await flexHandler.route(get('/flex/list'), env, USER, '/flex/list');
        const body = await res.json();

        assert.equal(body.flexs.length, 1);
        assert.equal(body.flexs[0].name, '舊的');
    });

    it('新 key 有資料時優先用新的', async () => {
        await seedRaw(env, V1Keys.flexList(USER), [{ id: 'f1', name: '舊的' }]);
        await seedRaw(env, BotKeys.flexList(BOT), [{ id: 'f2', name: '新的' }]);

        const res = await flexHandler.route(get('/flex/list'), env, USER, '/flex/list');
        const body = await res.json();

        assert.equal(body.flexs[0].name, '新的', 'handler 還在讀舊 key');
    });

    it('同步時新舊兩邊都寫', async () => {
        const req = post('/flex/sync', { flexs: [{ id: 'f1', name: 'A' }] });
        await flexHandler.route(req, env, USER, '/flex/sync');

        assert.deepEqual(await readRaw(env, BotKeys.flexList(BOT)), [{ id: 'f1', name: 'A' }]);
        assert.deepEqual(await readRaw(env, V1Keys.flexList(USER)), [{ id: 'f1', name: 'A' }]);
    });

    it('算不出 botId 時仍可運作，且不寫出 bot 命名空間', async () => {
        const bare = createEnv();
        const req = post('/flex/sync', { flexs: [{ id: 'f1', name: 'A' }] });
        await flexHandler.route(req, bare, USER, '/flex/sync');

        assert.deepEqual(await readRaw(bare, V1Keys.flexList(USER)), [{ id: 'f1', name: 'A' }]);
        assert.deepEqual(
            [...bare.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('bot:')),
            []
        );
    });
});

describe('image_msg.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('新 key 優先', async () => {
        await seedRaw(env, V1Keys.imageList(USER), [{ id: 'i1', name: '舊' }]);
        await seedRaw(env, BotKeys.images(BOT), [{ id: 'i2', name: '新' }]);

        const res = await imageHandler.route(get('/image/list'), env, USER, '/image/list');
        const body = await res.json();
        assert.equal(body.images[0].name, '新');
    });

    it('同步時雙寫', async () => {
        await imageHandler.route(
            post('/image/sync', { images: [{ id: 'i1' }] }), env, USER, '/image/sync'
        );
        assert.ok(await readRaw(env, BotKeys.images(BOT)));
        assert.ok(await readRaw(env, V1Keys.imageList(USER)));
    });
});

describe('imagemap.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('只有舊 key 時讀得到', async () => {
        await seedRaw(env, V1Keys.imagemap(USER), [{ name: '舊圖' }]);

        const res = await imagemapHandler.route(get('/imagemap/list'), env, USER, '/imagemap/list');
        const body = await res.json();
        assert.equal(body.imagemaps[0].name, '舊圖');
    });

    it('儲存時雙寫', async () => {
        await imagemapHandler.route(
            post('/imagemap/save', { imagemaps: [{ name: 'A' }] }), env, USER, '/imagemap/save'
        );
        assert.deepEqual(await readRaw(env, BotKeys.imagemaps(BOT)), [{ name: 'A' }]);
        assert.deepEqual(await readRaw(env, V1Keys.imagemap(USER)), [{ name: 'A' }]);
    });

    it('兩邊都沒有時回空陣列', async () => {
        const res = await imagemapHandler.route(get('/imagemap/list'), env, USER, '/imagemap/list');
        const body = await res.json();
        assert.deepEqual(body.imagemaps, []);
    });
});

describe('quick_reply.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('新 key 優先', async () => {
        await seedRaw(env, V1Keys.quickReplyList(USER), [{ id: 'q1', name: '舊' }]);
        await seedRaw(env, BotKeys.quickReplies(BOT), [{ id: 'q2', name: '新' }]);

        const res = await quickReplyHandler.route(get('/quickreply/list'), env, USER, '/quickreply/list');
        const body = await res.json();
        assert.equal(body.data[0].name, '新');
    });

    it('儲存時雙寫，而且是接在舊資料後面（不可覆蓋掉還沒回填的項目）', async () => {
        await seedRaw(env, V1Keys.quickReplyList(USER), [{ id: 'q1', name: '舊' }]);

        await quickReplyHandler.route(
            post('/quickreply/save', { name: '新的', items: [] }), env, USER, '/quickreply/save'
        );

        const fresh = await readRaw(env, BotKeys.quickReplies(BOT));
        assert.equal(fresh.length, 2, '讀回退拿到的舊清單必須被保留');
        assert.deepEqual(fresh.map(q => q.name), ['舊', '新的']);
    });

    it('刪除時兩邊都更新', async () => {
        await quickReplyHandler.route(
            post('/quickreply/save', { id: 'q1', name: 'A', items: [] }), env, USER, '/quickreply/save'
        );
        await quickReplyHandler.route(
            post('/quickreply/delete', { id: 'q1' }), env, USER, '/quickreply/delete'
        );

        assert.deepEqual(await readRaw(env, BotKeys.quickReplies(BOT)), []);
        assert.deepEqual(await readRaw(env, V1Keys.quickReplyList(USER)), []);
    });

    it('取得單一模板走的也是新 key', async () => {
        await seedRaw(env, BotKeys.quickReplies(BOT), [{ id: 'q9', name: '新' }]);

        const res = await quickReplyHandler.route(get('/quickreply/q9'), env, USER, '/quickreply/q9');
        const body = await res.json();
        assert.equal(body.data.name, '新');
    });
});

describe('keyword_reply.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('列表讀新 key', async () => {
        await seedRaw(env, V1Keys.keywordReplyList(USER), [{ keyword: '舊' }]);
        await seedRaw(env, BotKeys.keywords(BOT), [{ keyword: '新' }]);

        const res = await keywordHandler.route(get('/keyword/list'), env, USER, '/keyword/list');
        const body = await res.json();
        assert.equal(body.data[0].keyword, '新');
    });

    it('儲存時雙寫', async () => {
        await keywordHandler.route(
            post('/keyword/save', { keyword: '營業時間', replies: [{ type: 'text', text: '9-18' }] }),
            env, USER, '/keyword/save'
        );

        assert.equal((await readRaw(env, BotKeys.keywords(BOT)))[0].keyword, '營業時間');
        assert.equal((await readRaw(env, V1Keys.keywordReplyList(USER)))[0].keyword, '營業時間');
    });

    it('刪除關鍵字時連統計一起清，且兩邊同步', async () => {
        await seedRaw(env, BotKeys.keywords(BOT), [{ keyword: 'A' }, { keyword: 'B' }]);
        await seedRaw(env, BotKeys.keywordStats(BOT), { A: { total: 3 }, B: { total: 5 } });

        await keywordHandler.route(
            post('/keyword/delete', { keyword: 'A' }), env, USER, '/keyword/delete'
        );

        assert.deepEqual((await readRaw(env, BotKeys.keywords(BOT))).map(k => k.keyword), ['B']);
        assert.deepEqual(await readRaw(env, BotKeys.keywordStats(BOT)), { B: { total: 5 } });
        assert.deepEqual((await readRaw(env, V1Keys.keywordReplyList(USER))).map(k => k.keyword), ['B']);
        assert.deepEqual(await readRaw(env, V1Keys.keywordStats(USER)), { B: { total: 5 } });
    });

    it('統計查詢讀得到舊 key 的資料（回填前）', async () => {
        await seedRaw(env, V1Keys.keywordStats(USER), { A: { total: 7, monthly: {} } });

        const res = await keywordHandler.route(
            post('/keyword/stats', { keyword: 'A' }), env, USER, '/keyword/stats'
        );
        const body = await res.json();
        assert.equal(body.stats.total, 7);
    });
});

describe('segmented_richmenu.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('新 key 優先', async () => {
        await seedRaw(env, V1Keys.segmentedRichMenuRules(USER), [{ tag: '舊', richMenuId: 'r1' }]);
        await seedRaw(env, BotKeys.segmentedRichMenuRules(BOT), [{ tag: '新', richMenuId: 'r2' }]);

        const res = await segmentedHandler.route(
            get('/richmenu/segmented/list'), env, USER, '/richmenu/segmented/list'
        );
        const body = await res.json();
        assert.equal(body.rules[0].tag, '新');
    });

    it('儲存時雙寫', async () => {
        await segmentedHandler.route(
            post('/richmenu/segmented/save', { rules: [{ tag: 'VIP', richMenuId: 'r1' }] }),
            env, USER, '/richmenu/segmented/save'
        );

        assert.deepEqual(
            await readRaw(env, BotKeys.segmentedRichMenuRules(BOT)),
            [{ tag: 'VIP', richMenuId: 'r1' }]
        );
        assert.deepEqual(
            await readRaw(env, V1Keys.segmentedRichMenuRules(USER)),
            [{ tag: 'VIP', richMenuId: 'r1' }]
        );
    });
});

describe('profile.js — 切到 user 命名空間', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('profile 不進 bot 命名空間（換 bot 之後這筆資料還有意義）', async () => {
        await profileHandler.route(
            post('/profile/save', { userName: 'Tim' }), env, USER, '/profile/save'
        );

        assert.deepEqual(await readRaw(env, UserKeys.profile(USER)), { userName: 'Tim' });
        assert.deepEqual(await readRaw(env, V1Keys.profile(USER)), { userName: 'Tim' });
        assert.deepEqual(
            [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith(`bot:${BOT}:`)),
            []
        );
    });

    it('只有舊 key 時讀得到', async () => {
        await seedRaw(env, V1Keys.profile(USER), { userName: '舊名字' });

        const res = await profileHandler.route(get('/profile/check'), env, USER, '/profile/check');
        const body = await res.json();
        assert.equal(body.exists, true);
        assert.equal(body.profile.userName, '舊名字');
    });

    it('兩邊都沒有時 exists 為 false', async () => {
        const res = await profileHandler.route(get('/profile/check'), env, USER, '/profile/check');
        const body = await res.json();
        assert.equal(body.exists, false);
        assert.equal(body.profile, null);
    });
});

// ---------------------------------------------------------------------------
// webhook 回覆路徑
// ---------------------------------------------------------------------------

describe('line_client.formatReplyMessage — 以 id 取 Flex 內容', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('從新命名空間取得 Flex 內容', async () => {
        await seedRaw(env, BotKeys.flexList(BOT), [
            { id: 'f1', name: '卡片', contents: { type: 'bubble' } },
        ]);

        const msg = await formatReplyMessage({ type: 'flex', id: 'f1' }, env, USER);

        assert.ok(msg, '原本讀的是 bot:${userId}:flex_list —— 永遠對不到，訊息會被丟掉');
        assert.equal(msg.type, 'flex');
        assert.deepEqual(msg.contents, { type: 'bubble' });
    });

    it('回填前只有舊 key 時也取得到', async () => {
        await seedRaw(env, V1Keys.flexList(USER), [
            { id: 'f1', contents: { type: 'bubble' } },
        ]);

        const msg = await formatReplyMessage({ type: 'flex', id: 'f1' }, env, USER);
        assert.ok(msg);
        assert.deepEqual(msg.contents, { type: 'bubble' });
    });

    it('reply 自帶 contents 時不去查 KV', async () => {
        const msg = await formatReplyMessage(
            { type: 'flex', contents: { type: 'carousel' } }, env, USER
        );
        assert.deepEqual(msg.contents, { type: 'carousel' });
    });

    it('找不到該 id 時回 null（維持原本行為）', async () => {
        await seedRaw(env, BotKeys.flexList(BOT), [{ id: 'other', contents: {} }]);
        assert.equal(await formatReplyMessage({ type: 'flex', id: 'f1' }, env, USER), null);
    });
});

// ---------------------------------------------------------------------------
// 後台路徑：CRM 與設定
// ---------------------------------------------------------------------------

describe('member.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('列表讀新 key', async () => {
        await seedRaw(env, V1Keys.memberList(USER), ['U-old']);
        await seedRaw(env, BotKeys.members(BOT), ['U-new']);

        const res = await memberHandler.route(get('/member/list'), env, USER, '/member/list');
        const body = await res.json();
        assert.deepEqual(body.data, ['U-new']);
    });

    it('回填前只有舊 key 時也讀得到', async () => {
        await seedRaw(env, V1Keys.memberList(USER), ['U-old']);
        await seedRaw(env, V1Keys.memberProfile(USER, 'U-old'), { memberId: 'U-old', lineName: '舊會員' });

        const res = await memberHandler.route(get('/member/list-full'), env, USER, '/member/list-full');
        const body = await res.json();
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].lineName, '舊會員');
    });

    it('儲存會員時雙寫 profile 與清單', async () => {
        await memberHandler.route(
            post('/member/save', { lineUserId: 'U-a', name: '小明', tags: [] }),
            env, USER, '/member/save'
        );

        assert.equal((await readRaw(env, BotKeys.member(BOT, 'U-a'))).name, '小明');
        assert.equal((await readRaw(env, V1Keys.memberProfile(USER, 'U-a'))).name, '小明');
        assert.deepEqual(await readRaw(env, BotKeys.members(BOT)), ['U-a']);
        assert.deepEqual(await readRaw(env, V1Keys.memberList(USER)), ['U-a']);
    });

    it('標籤同時寫進會員 profile 與反向索引', async () => {
        await memberHandler.route(
            post('/member/save', { lineUserId: 'U-a', name: '小明', tags: ['VIP'] }),
            env, USER, '/member/save'
        );

        assert.deepEqual((await readRaw(env, BotKeys.member(BOT, 'U-a'))).tags, ['VIP']);
        assert.deepEqual(await readRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP')), ['U-a']);
        assert.deepEqual(await readRaw(env, BotKeys.tags(BOT)), ['VIP']);
        // 舊命名空間同步
        assert.deepEqual(await readRaw(env, V1Keys.tagEntities(USER, 'member', 'VIP')), ['U-a']);
    });

    it('刪除會員時兩邊都清掉', async () => {
        await memberHandler.route(
            post('/member/save', { lineUserId: 'U-a', name: '小明', tags: [] }),
            env, USER, '/member/save'
        );
        await memberHandler.route(
            post('/member/delete', { memberId: 'U-a' }), env, USER, '/member/delete'
        );

        assert.equal(await readRaw(env, BotKeys.member(BOT, 'U-a')), null);
        assert.equal(await readRaw(env, V1Keys.memberProfile(USER, 'U-a')), null);
        assert.deepEqual(await readRaw(env, BotKeys.members(BOT)), []);
    });

    it('取得單一會員走新 key', async () => {
        await seedRaw(env, BotKeys.member(BOT, 'U-a'), { memberId: 'U-a', name: '新' });

        const res = await memberHandler.route(
            get('/member/profile/U-a'), env, USER, '/member/profile/U-a'
        );
        const body = await res.json();
        assert.equal(body.data.name, '新');
    });
});

describe('tag.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('新增標籤時雙寫', async () => {
        await tagHandler.route(post('/tag/save', { name: 'VIP' }), env, USER, '/tag/save');

        assert.deepEqual(await readRaw(env, BotKeys.tags(BOT)), ['VIP']);
        assert.deepEqual(await readRaw(env, V1Keys.tagList(USER)), ['VIP']);
    });

    it('列表讀新 key，並帶上統計', async () => {
        await seedRaw(env, V1Keys.tagList(USER), ['舊標籤']);
        await seedRaw(env, BotKeys.tags(BOT), ['VIP']);
        await seedRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP'), ['U-1', 'U-2']);

        const res = await tagHandler.route(get('/tag/list'), env, USER, '/tag/list');
        const body = await res.json();

        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].name, 'VIP');
        assert.equal(body.data[0].total, 2);
    });

    it('重命名標籤時連會員 profile 的內嵌標籤一起改', async () => {
        await seedRaw(env, BotKeys.tags(BOT), ['VIP']);
        await seedRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP'), ['U-1']);
        await seedRaw(env, BotKeys.member(BOT, 'U-1'), { memberId: 'U-1', tags: ['VIP'] });

        await tagHandler.route(
            post('/tag/rename', { oldName: 'VIP', newName: '貴賓' }), env, USER, '/tag/rename'
        );

        assert.deepEqual(await readRaw(env, BotKeys.tags(BOT)), ['貴賓']);
        assert.deepEqual(await readRaw(env, BotKeys.tagEntities(BOT, 'member', '貴賓')), ['U-1']);
        assert.equal(await readRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP')), null);
        assert.deepEqual((await readRaw(env, BotKeys.member(BOT, 'U-1'))).tags, ['貴賓']);
    });

    it('刪除標籤時把它從會員身上移除', async () => {
        await seedRaw(env, BotKeys.tags(BOT), ['VIP']);
        await seedRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP'), ['U-1']);
        await seedRaw(env, BotKeys.member(BOT, 'U-1'), { memberId: 'U-1', tags: ['VIP'] });

        await tagHandler.route(post('/tag/delete', { name: 'VIP' }), env, USER, '/tag/delete');

        assert.deepEqual(await readRaw(env, BotKeys.tags(BOT)), []);
        assert.equal(await readRaw(env, BotKeys.tagEntities(BOT, 'member', 'VIP')), null);
        assert.deepEqual((await readRaw(env, BotKeys.member(BOT, 'U-1'))).tags, []);
    });
});

describe('tier.js — 已切換到 bot_store', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedBot(env); });

    it('第一次讀取會寫入預設設定，兩邊都寫', async () => {
        const res = await tierHandler.handleGetTierConfig(get('/tier/config'), env, USER);
        const body = await res.json();

        assert.ok(body.config.tiers.length > 0);
        assert.ok(await readRaw(env, BotKeys.tierConfig(BOT)));
        assert.ok(await readRaw(env, V1Keys.tierConfig(USER)));
    });

    it('回填前只有舊設定時也讀得到', async () => {
        await seedRaw(env, V1Keys.tierConfig(USER), {
            tiers: [{ id: 0, name: '舊等級' }],
        });

        const res = await tierHandler.handleGetTierConfig(get('/tier/config'), env, USER);
        const body = await res.json();
        assert.equal(body.config.tiers[0].name, '舊等級');
    });

    it('更新設定時雙寫', async () => {
        await tierHandler.handleUpdateTierConfig(
            post('/tier/config', { benefits: { richMenu: { enabled: true } } }), env, USER
        );

        assert.equal((await readRaw(env, BotKeys.tierConfig(BOT))).benefits.richMenu.enabled, true);
        assert.equal((await readRaw(env, V1Keys.tierConfig(USER))).benefits.richMenu.enabled, true);
    });

    it('等級統計以新舊兩邊的會員聯集計算（回填期間不可少算）', async () => {
        await seedRaw(env, BotKeys.member(BOT, 'U-new'), { memberId: 'U-new', tier: 0 });
        await seedRaw(env, V1Keys.memberProfile(USER, 'U-old'), { memberId: 'U-old', tier: 0 });

        const res = await tierHandler.handleGetTierStats(get('/tier/stats'), env, USER);
        const body = await res.json();

        assert.equal(body.stats.total, 2, '只看單一命名空間會少算會員');
    });

    it('手動設定等級時雙寫', async () => {
        await seedRaw(env, BotKeys.member(BOT, 'U-a'), { memberId: 'U-a', tier: 0 });

        const res = await tierHandler.handleSetMemberTier(
            post('/tier/set', { lineUserId: 'U-a', tier: 2 }), env, USER
        );
        const body = await res.json();

        assert.equal(body.success, true);
        assert.equal((await readRaw(env, BotKeys.member(BOT, 'U-a'))).tier, 2);
        assert.equal((await readRaw(env, V1Keys.memberProfile(USER, 'U-a'))).tier, 2);
    });
});
