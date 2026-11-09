/**
 * Unit Tests — kv_schema 的 botId 命名空間
 *
 * 為什麼要有這組測試：
 *
 * 現在有兩套不相容的命名慣例。16 個 handler 用 `<domain>_${userId}`（底線、
 * 綁呼叫者本人），team.js 與 bot.js 用 `bot:${botId}:<domain>`（冒號、綁 bot）。
 * 正式環境兩種都有：924 個 key 裡 865 個是 member_profile_<owner>_<member>，
 * 另有 12 個是 bot:<id>:*。
 *
 * 收斂的方向是冒號那套，因為會員那 865 個 key 本來就得重寫（owner → bot），
 * 改分隔符的增量成本接近零，而冒號換來 list({prefix:'bot:<id>:'}) ——
 * 多租戶要能匯出或刪除單一租戶，這個能力是必要的。
 *
 * 代價是分隔符進了 key，所以 key 組件一定要驗證：botId 或 tag 裡夾一個 ':'
 * 就能偽造別人的 key。這組測試的重點一半在這裡。
 *
 * botId 的身分不是發明出來的，是 LINE 的 destination —— token.js:23 註冊時
 * 就打 /v2/bot/info 拿到它，webhook.js:53 已經用它路由進來的事件。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const MEMBER = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';

async function load() {
    return import('../../worker_src/lib/kv_schema.js');
}

describe('BotKeys — 每個 key 都在 bot 的命名空間底下', () => {
    it('所有 bot 範圍的 key 都以 bot:<botId>: 開頭', async () => {
        const { BotKeys } = await load();
        const simple = ['info', 'permissions', 'owner', 'credential', 'keywords', 'keywordStats',
            'flexList', 'imagemaps', 'members', 'tags', 'quickReplies', 'images',
            'messageStats', 'tierConfig', 'welcome', 'segmentedRichMenuRules', 'flowList'];
        for (const name of simple) {
            assert.equal(typeof BotKeys[name], 'function', `BotKeys.${name} 不存在`);
            const key = BotKeys[name](BOT);
            assert.ok(key.startsWith(`bot:${BOT}:`), `${name} → ${key}`);
        }
    });

    it('帶 id 的 key 也在同一個命名空間底下', async () => {
        const { BotKeys } = await load();
        const withId = {
            member: MEMBER, memberLog: MEMBER, keyword: 'kw1', flex: 'f1',
            quickReply: 'qr1', richMenuMeta: 'rm1', message: 'm1', flow: 'flow1',
        };
        for (const [name, id] of Object.entries(withId)) {
            assert.equal(typeof BotKeys[name], 'function', `BotKeys.${name} 不存在`);
            const key = BotKeys[name](BOT, id);
            assert.ok(key.startsWith(`bot:${BOT}:`), `${name} → ${key}`);
            assert.ok(key.includes(id), `${name} 沒有帶上 id → ${key}`);
        }
    });

    it('不同 bot 的同名資源不會撞 key', async () => {
        const { BotKeys } = await load();
        const other = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        assert.notEqual(BotKeys.members(BOT), BotKeys.members(other));
        assert.notEqual(BotKeys.member(BOT, MEMBER), BotKeys.member(other, MEMBER));
    });

    it('同一個 bot 的不同資源不會撞 key', async () => {
        const { BotKeys } = await load();
        const keys = [
            BotKeys.info(BOT), BotKeys.permissions(BOT), BotKeys.owner(BOT),
            BotKeys.credential(BOT), BotKeys.keywords(BOT), BotKeys.members(BOT),
            BotKeys.tags(BOT), BotKeys.flexList(BOT), BotKeys.welcome(BOT),
            BotKeys.member(BOT, MEMBER), BotKeys.memberLog(BOT, MEMBER),
        ];
        assert.equal(new Set(keys).size, keys.length, '有 key 重複');
    });

    it('botPrefix 可以列出一個 bot 的全部資料（匯出／刪除租戶用）', async () => {
        const { BotKeys } = await load();
        const prefix = BotKeys.prefix(BOT);
        assert.equal(prefix, `bot:${BOT}:`);
        for (const key of [BotKeys.members(BOT), BotKeys.member(BOT, MEMBER), BotKeys.keywords(BOT)]) {
            assert.ok(key.startsWith(prefix));
        }
    });
});

describe('key 組件驗證 — 分隔符注入', () => {
    const bad = [
        ['冒號', 'U123:evil'],
        ['前綴逃脫', 'U123:x:members'],
        ['空字串', ''],
        ['null', null],
        ['undefined', undefined],
        ['非字串', 123],
    ];

    for (const [label, value] of bad) {
        it(`botId 是${label}時必須丟錯，不可產生 key`, async () => {
            const { BotKeys } = await load();
            assert.throws(() => BotKeys.members(value), /invalid key component|botId/i,
                `${label} 竟然產生了 key`);
        });
    }

    it('id 參數含冒號時也必須丟錯', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.member(BOT, 'U1:evil'), /invalid key component/i);
        assert.throws(() => BotKeys.keyword(BOT, 'a:b'), /invalid key component/i);
    });

    it('tag 名稱含冒號時也必須丟錯（tag 是使用者輸入）', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.tagMembers(BOT, 'vip:evil'), /invalid key component/i);
    });

    it('正常的中文 tag 可以用', async () => {
        const { BotKeys } = await load();
        const key = BotKeys.tagMembers(BOT, '婚紗客戶');
        assert.ok(key.startsWith(`bot:${BOT}:`));
        assert.ok(key.includes('婚紗客戶'));
    });
});

describe('UserKeys — 關於人的資料留在 user 命名空間', () => {
    it('bots 與 profile 以 user:<userId>: 開頭', async () => {
        const { UserKeys } = await load();
        const uid = 'Ucccccccccccccccccccccccccccccc01';
        assert.ok(UserKeys.bots(uid).startsWith(`user:${uid}:`));
        assert.ok(UserKeys.profile(uid).startsWith(`user:${uid}:`));
    });

    it('userId 也要驗證', async () => {
        const { UserKeys } = await load();
        assert.throws(() => UserKeys.bots('U1:evil'), /invalid key component/i);
    });

    it('rate limit 是對人不是對 bot，所以不在 bot 命名空間', async () => {
        const { UserKeys } = await load();
        assert.equal(typeof UserKeys.rateLimit, 'function');
        const key = UserKeys.rateLimit('Ucccccccccccccccccccccccccccccc01', 42);
        assert.ok(!key.startsWith('bot:'), `rate limit 不該綁 bot → ${key}`);
    });
});

describe('V1Keys — 舊 key 的產生器（migration 要讀舊資料）', () => {
    it('提供 v1 的 userId 命名空間 key，供 migration 讀取', async () => {
        const { V1Keys } = await load();
        const owner = 'Ucccccccccccccccccccccccccccccc01';
        assert.equal(V1Keys.memberList(owner), `member_list_${owner}`);
        assert.equal(V1Keys.memberProfile(owner, MEMBER), `member_profile_${owner}_${MEMBER}`);
        assert.equal(V1Keys.keywordReplyList(owner), `keyword_reply_list_${owner}`);
        assert.equal(V1Keys.accessTokens(owner), `access_tokens_${owner}`);
        assert.equal(V1Keys.currentToken(owner), `current_token_${owner}`);
        assert.equal(V1Keys.destinationUser('Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb03'),
            'destination_user_Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb03');
    });
});
