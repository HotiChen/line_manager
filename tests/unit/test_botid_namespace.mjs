/**
 * Unit Tests — 命名空間歸屬：資料有沒有寫進正確的 bot
 *
 * 這是整個 botId 收斂裡最容易安靜出錯的一件事。
 *
 * 後台路徑的 botId 來自「這個人在介面上選的 bot」（resolveBotId）。
 * webhook 路徑完全不受後台操作影響：事件屬於 LINE 的 destination 指定的
 * 那個官方帳號。兩者可能不同 —— 而正式環境已經有一個 owner 持有兩個帳號。
 *
 * 如果 webhook 誤用了「他現在選的 bot」，A 帳號收到的訊息會被寫進 B 的
 * 命名空間。不會丟錯、不會有任何 log，只是會員跑到隔壁去。所以這裡的
 * 每個測試都刻意把 currentBotId 設成「錯的那個」。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';
import { openBotStoreFor, openBotStoreForBot } from '../../worker_src/lib/bot_store.js';
import {
    handleFollowEvent,
    handleMessageEvent,
    handleUnfollowEvent,
    handlePostbackEvent,
} from '../../worker_src/lib/event_handler.js';

const OWNER = 'Uowner00000000000000000000000001';
/** webhook 事件來自這個帳號 */
const BOT_EVENT = 'Cbotevent000000000000000000001';
/** 但 owner 正在後台看這個帳號 */
const BOT_SELECTED = 'Cbotselected00000000000000001';
const MEMBER = 'Umember000000000000000000000001';

const originalFetch = globalThis.fetch;

function mockLine() {
    globalThis.fetch = async (url) => {
        if (String(url).includes('/v2/profile')) {
            return new Response(
                JSON.stringify({ userId: MEMBER, displayName: '王小明' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
}

function createEnv() {
    return { KV_LINE_STORAGE: createMockKV() };
}

/**
 * owner 有兩個 bot，而且**正在後台看 BOT_SELECTED**。
 * webhook 事件則來自 BOT_EVENT。
 */
async function seedTwoBotsLookingAtWrongOne(env) {
    await env.KV_LINE_STORAGE.put(UserKeys.bots(OWNER), JSON.stringify({
        bots: [{ botId: BOT_EVENT, role: 'owner' }, { botId: BOT_SELECTED, role: 'owner' }],
        currentBotId: BOT_SELECTED,
    }));
    await env.KV_LINE_STORAGE.put(BotKeys.owner(BOT_EVENT), OWNER);
    await env.KV_LINE_STORAGE.put(BotKeys.owner(BOT_SELECTED), OWNER);
}

async function readJson(env, key) {
    return env.KV_LINE_STORAGE.get(key, { type: 'json' });
}

// ---------------------------------------------------------------------------
// webhook 事件
// ---------------------------------------------------------------------------

describe('webhook 事件要寫進 destination 的命名空間，不是後台選的那個', () => {
    let env;

    beforeEach(async () => {
        env = createEnv();
        await seedTwoBotsLookingAtWrongOne(env);
        mockLine();
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('follow：會員進 BOT_EVENT，不進 BOT_SELECTED', async () => {
        await handleFollowEvent(
            { type: 'follow', replyToken: 'rt', source: { userId: MEMBER } },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.ok(
            await readJson(env, BotKeys.member(BOT_EVENT, MEMBER)),
            '會員必須寫進事件來源的帳號'
        );
        assert.equal(
            await readJson(env, BotKeys.member(BOT_SELECTED, MEMBER)), null,
            'owner 正在後台看哪個帳號，與 webhook 無關'
        );

        // 會員清單同理
        assert.deepEqual(await readJson(env, BotKeys.members(BOT_EVENT)), [MEMBER]);
        assert.equal(await readJson(env, BotKeys.members(BOT_SELECTED)), null);
    });

    it('follow：舊命名空間也要寫（雙寫，回填前的讀取還靠它）', async () => {
        await handleFollowEvent(
            { type: 'follow', replyToken: 'rt', source: { userId: MEMBER } },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.ok(await readJson(env, V1Keys.memberProfile(OWNER, MEMBER)));
        assert.deepEqual(await readJson(env, V1Keys.memberList(OWNER)), [MEMBER]);
    });

    it('follow：歡迎訊息讀的是 BOT_EVENT 的設定', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.welcome(BOT_EVENT), JSON.stringify({
            enabled: true, replies: [{ type: 'text', text: '歡迎來到 A 帳號' }],
        }));
        await env.KV_LINE_STORAGE.put(BotKeys.welcome(BOT_SELECTED), JSON.stringify({
            enabled: true, replies: [{ type: 'text', text: '歡迎來到 B 帳號' }],
        }));

        const sent = [];
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/v2/profile')) {
                return new Response(JSON.stringify({ displayName: '王小明' }), { status: 200 });
            }
            if (String(url).includes('/message/reply')) {
                sent.push(JSON.parse(init.body));
            }
            return new Response('{}', { status: 200 });
        };

        await handleFollowEvent(
            { type: 'follow', replyToken: 'rt', source: { userId: MEMBER } },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.equal(sent.length, 1, '沒有發出歡迎訊息');
        assert.match(sent[0].messages[0].text, /A 帳號/, '讀錯帳號的歡迎訊息設定');
    });

    it('message：關鍵字讀 BOT_EVENT 的清單', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT_EVENT), JSON.stringify([
            { keyword: '營業時間', replies: [{ type: 'text', text: 'A 帳號 9-18' }] },
        ]));
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT_SELECTED), JSON.stringify([
            { keyword: '營業時間', replies: [{ type: 'text', text: 'B 帳號 10-20' }] },
        ]));

        const sent = [];
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/v2/profile')) {
                return new Response(JSON.stringify({ displayName: '王小明' }), { status: 200 });
            }
            if (String(url).includes('/message/reply')) sent.push(JSON.parse(init.body));
            return new Response('{}', { status: 200 });
        };

        await handleMessageEvent(
            {
                type: 'message',
                replyToken: 'rt',
                message: { type: 'text', text: '營業時間' },
                source: { userId: MEMBER },
            },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.equal(sent.length, 1, '沒有回覆');
        assert.match(sent[0].messages[0].text, /A 帳號/, '讀錯帳號的關鍵字');
    });

    it('unfollow：標記 inactive 的是 BOT_EVENT 底下的那筆', async () => {
        await env.KV_LINE_STORAGE.put(
            BotKeys.member(BOT_EVENT, MEMBER),
            JSON.stringify({ memberId: MEMBER, status: 'active' })
        );
        await env.KV_LINE_STORAGE.put(
            BotKeys.member(BOT_SELECTED, MEMBER),
            JSON.stringify({ memberId: MEMBER, status: 'active' })
        );

        await handleUnfollowEvent(
            { type: 'unfollow', source: { userId: MEMBER } },
            env, OWNER, BOT_EVENT
        );

        assert.equal((await readJson(env, BotKeys.member(BOT_EVENT, MEMBER))).status, 'inactive');
        assert.equal(
            (await readJson(env, BotKeys.member(BOT_SELECTED, MEMBER))).status, 'active',
            '只有事件來源的帳號該被改動'
        );
    });

    it('postback 自動標籤寫進 BOT_EVENT', async () => {
        await env.KV_LINE_STORAGE.put(
            BotKeys.member(BOT_EVENT, MEMBER),
            JSON.stringify({ memberId: MEMBER, tags: [] })
        );
        await env.KV_LINE_STORAGE.put(
            BotKeys.member(BOT_SELECTED, MEMBER),
            JSON.stringify({ memberId: MEMBER, tags: [] })
        );

        await handlePostbackEvent(
            { type: 'postback', replyToken: 'rt', postback: { data: 'tag=VIP' }, source: { userId: MEMBER } },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.deepEqual((await readJson(env, BotKeys.member(BOT_EVENT, MEMBER))).tags, ['VIP']);
        assert.deepEqual(
            (await readJson(env, BotKeys.member(BOT_SELECTED, MEMBER))).tags, [],
            '標籤被加到錯的帳號'
        );
    });

    it('訊息統計記在 BOT_EVENT 底下（LINE 的額度是 per 官方帳號）', async () => {
        await handlePostbackEvent(
            { type: 'postback', replyToken: 'rt', postback: { data: 'x' }, source: { userId: MEMBER } },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        const stats = await readJson(env, BotKeys.messageStats(BOT_EVENT));
        assert.equal(stats.total, 1);
        assert.equal(await readJson(env, BotKeys.messageStats(BOT_SELECTED)), null);
    });
});

// ---------------------------------------------------------------------------
// 回填前：webhook 仍要讀得到舊資料
// ---------------------------------------------------------------------------

describe('回填前的 webhook：讀得到舊命名空間', () => {
    let env;

    beforeEach(async () => {
        env = createEnv();
        await seedTwoBotsLookingAtWrongOne(env);
        mockLine();
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('關鍵字只在舊 key 時照樣回覆', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(OWNER), JSON.stringify([
            { keyword: '營業時間', replies: [{ type: 'text', text: '舊設定 9-18' }] },
        ]));

        const sent = [];
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/v2/profile')) {
                return new Response(JSON.stringify({ displayName: '王小明' }), { status: 200 });
            }
            if (String(url).includes('/message/reply')) sent.push(JSON.parse(init.body));
            return new Response('{}', { status: 200 });
        };

        await handleMessageEvent(
            {
                type: 'message',
                replyToken: 'rt',
                message: { type: 'text', text: '營業時間' },
                source: { userId: MEMBER },
            },
            env, OWNER, 'tok', null, BOT_EVENT
        );

        assert.equal(sent.length, 1, '回填前的使用者會完全收不到回覆');
        assert.match(sent[0].messages[0].text, /舊設定/);
    });

    it('既有會員只在舊 key 時，unfollow 仍標得到 inactive', async () => {
        await env.KV_LINE_STORAGE.put(
            V1Keys.memberProfile(OWNER, MEMBER),
            JSON.stringify({ memberId: MEMBER, status: 'active' })
        );

        await handleUnfollowEvent(
            { type: 'unfollow', source: { userId: MEMBER } },
            env, OWNER, BOT_EVENT
        );

        assert.equal((await readJson(env, V1Keys.memberProfile(OWNER, MEMBER))).status, 'inactive');
        // 雙寫會把它同時帶進新命名空間
        assert.equal((await readJson(env, BotKeys.member(BOT_EVENT, MEMBER))).status, 'inactive');
    });
});

// ---------------------------------------------------------------------------
// 以 botId 建立 store
// ---------------------------------------------------------------------------

describe('openBotStoreFor / openBotStoreForBot', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotsLookingAtWrongOne(env); });

    it('openBotStoreFor 兩邊都照傳入的用，不去 resolve', async () => {
        const store = openBotStoreFor(env, OWNER, BOT_EVENT);
        assert.equal(store.botId, BOT_EVENT, '不可被 currentBotId 蓋掉');
        assert.equal(store.userId, OWNER);
    });

    it('openBotStoreForBot 反查 owner 以取得舊命名空間', async () => {
        const store = await openBotStoreForBot(env, BOT_EVENT);
        assert.equal(store.botId, BOT_EVENT);
        assert.equal(store.userId, OWNER);
    });

    it('反查不到 owner 時只走新命名空間，不丟錯', async () => {
        const store = await openBotStoreForBot(env, 'Cunknownbot00000000000000001');
        assert.equal(store.userId, null);

        await store.put('keywords', ['a']);
        assert.deepEqual(await store.get('keywords'), ['a']);

        const legacy = [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('keyword_reply_list_'));
        assert.deepEqual(legacy, [], 'userId 不可用時不該寫出 `..._null` 這種 key');
    });

    it('botId 與 userId 都沒有時要丟錯，而不是寫到一個誰都讀不到的 key', () => {
        const store = openBotStoreFor(env, null, null);
        assert.throws(() => store.keys('keywords'), /既沒有 botId 也沒有 userId/);
    });
});
