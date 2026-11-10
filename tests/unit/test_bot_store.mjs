/**
 * Unit Tests — lib/bot_store.js
 *
 * bot_store 是 botId 收斂的地基：所有 handler 的 KV 存取都會改走它，所以它的
 * 行為必須被釘到最細。特別是三件會安靜地出錯的事：
 *
 *   1. 讀取回退的條件（空字串是資料，不是「沒有」）
 *   2. 雙寫的順序（新 key 寫失敗時不可留下一個比舊值更舊的新 key）
 *   3. 算不出 botId 時降級到舊命名空間，而不是猜一個
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';
import { BotStore, openBotStore, RESOURCES } from '../../worker_src/lib/bot_store.js';

const USER = 'Uowner00000000000000000000000001';
const BOT = 'Ubot000000000000000000000000001';

function createEnv() {
    return { KV_LINE_STORAGE: createMockKV() };
}

/** 讓 resolveBotId 走「新路徑」找到 botId */
async function seedCurrentBot(env, userId = USER, botId = BOT) {
    await env.KV_LINE_STORAGE.put(
        UserKeys.bots(userId),
        JSON.stringify({ bots: [{ botId, role: 'owner' }], currentBotId: botId })
    );
}

/** 讓 resolveBotId 只能走「舊路徑」（current_token + access_tokens.destination） */
async function seedLegacyBot(env, userId = USER, botId = BOT) {
    await env.KV_LINE_STORAGE.put(V1Keys.currentToken(userId), 'proj');
    await env.KV_LINE_STORAGE.put(
        V1Keys.accessTokens(userId),
        JSON.stringify({ proj: { token: 'tok', destination: botId } })
    );
}

// ---------------------------------------------------------------------------
// 資源對照表
// ---------------------------------------------------------------------------

describe('RESOURCES 對照表', () => {
    it('每個資源的新舊 key builder 參數個數要一致', () => {
        const store = new BotStore(createEnv(), USER, BOT);

        for (const [name, spec] of Object.entries(RESOURCES)) {
            const args = Array.from({ length: spec.args }, (_, i) => `id${i}`);
            const { bot, v1 } = store.keys(name, ...args);

            assert.ok(bot, `${name}: bot key 應該組得出來`);
            assert.ok(v1, `${name}: v1 key 應該組得出來`);
            assert.ok(bot.startsWith(`bot:${BOT}:`), `${name}: bot key 必須在 bot 命名空間下`);
            assert.ok(v1.includes(USER), `${name}: v1 key 必須帶 userId`);
        }
    });

    it('copy 策略只有 all 與 current 兩種', () => {
        for (const [name, spec] of Object.entries(RESOURCES)) {
            assert.ok(['all', 'current'].includes(spec.copy), `${name}: copy=${spec.copy}`);
        }
    });

    it('CRM 與統計類資源不可標成 all（複製到每個 bot 會生出幽靈會員）', () => {
        for (const name of ['members', 'member', 'memberLog', 'tags', 'tagEntities', 'messageStats']) {
            assert.equal(RESOURCES[name].copy, 'current', `${name} 必須只進 current bot`);
        }
    });

    it('未知資源要丟錯，不可安靜地回 undefined', () => {
        const store = new BotStore(createEnv(), USER, BOT);
        assert.throws(() => store.keys('nope'), TypeError);
    });

    it('參數個數不符要丟錯（v1 key 會安靜地吃下 undefined）', () => {
        const store = new BotStore(createEnv(), USER, BOT);
        assert.throws(() => store.keys('member'), /expects 1 id/);
        assert.throws(() => store.keys('members', 'extra'), /expects 0 id/);
    });
});

// ---------------------------------------------------------------------------
// 雙讀
// ---------------------------------------------------------------------------

describe('BotStore — 雙讀', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, BOT);
    });

    it('新 key 有值時直接用，不去碰舊 key', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT), JSON.stringify(['new']));
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify(['old']));

        assert.deepEqual(await store.get('keywords'), ['new']);
        assert.deepEqual(store.fallbacks, [], '沒有回退就不該記 fallback');
    });

    it('新 key 沒有時回退舊 key，並記下一次 fallback', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify(['old']));

        assert.deepEqual(await store.get('keywords'), ['old']);
        assert.deepEqual(store.fallbacks, ['keywords'], 'fallback 計數是「回填完成」的唯一訊號');
    });

    it('兩邊都沒有時回 null', async () => {
        assert.equal(await store.get('keywords'), null);
        assert.deepEqual(store.fallbacks, []);
    });

    it('新 key 的值是空字串時不可回退（那是剛被清空的設定）', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.welcome(BOT), '');
        await env.KV_LINE_STORAGE.put(V1Keys.welcomeMessage(USER), JSON.stringify({ text: '舊的歡迎詞' }));

        assert.equal(await store.getText('welcome'), '', '空字串是一筆真實資料');
        assert.deepEqual(store.fallbacks, []);
    });

    it('壞掉的 JSON 回 null 而不是丟錯', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT), 'not json at all');
        assert.equal(await store.get('keywords'), null);
    });

    it('getOr 省掉呼叫端的 || []', async () => {
        assert.deepEqual(await store.getOr('keywords', []), []);
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT), JSON.stringify(['a']));
        assert.deepEqual(await store.getOr('keywords', []), ['a']);
    });

    it('帶 id 的資源各自獨立回退', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, 'U-a'), JSON.stringify({ name: 'A 新' }));
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-b'), JSON.stringify({ name: 'B 舊' }));

        assert.deepEqual(await store.get('member', 'U-a'), { name: 'A 新' });
        assert.deepEqual(await store.get('member', 'U-b'), { name: 'B 舊' });
        assert.deepEqual(store.fallbacks, ['member']);
    });
});

// ---------------------------------------------------------------------------
// 雙寫
// ---------------------------------------------------------------------------

describe('BotStore — 雙寫', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, BOT);
    });

    it('兩個命名空間都要寫到', async () => {
        await store.put('keywords', ['a', 'b']);

        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.keywords(BOT)), JSON.stringify(['a', 'b']));
        assert.equal(await env.KV_LINE_STORAGE.get(V1Keys.keywordReplyList(USER)), JSON.stringify(['a', 'b']));
    });

    it('字串原樣寫入，不會被二次 stringify', async () => {
        await store.put('welcome', '{"text":"hi"}');
        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.welcome(BOT)), '{"text":"hi"}');
    });

    it('新 key 先寫；它失敗時不可寫舊 key', async () => {
        const written = [];
        env.KV_LINE_STORAGE.put = async (key) => {
            written.push(key);
            if (key.startsWith('bot:')) throw new Error('KV 爆了');
        };

        await assert.rejects(() => store.put('keywords', ['x']), /KV 爆了/);
        assert.deepEqual(written, [BotKeys.keywords(BOT)],
            '舊 key 不該被寫 —— 否則讀取優先的新 key 會是更舊的值');
    });

    it('寫入後讀得回來，而且不算 fallback', async () => {
        await store.put('member', { name: 'A' }, 'U-a');
        assert.deepEqual(await store.get('member', 'U-a'), { name: 'A' });
        assert.deepEqual(store.fallbacks, []);
    });
});

// ---------------------------------------------------------------------------
// 雙刪
// ---------------------------------------------------------------------------

describe('BotStore — 雙刪', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, BOT);
    });

    it('只刪一邊的話雙讀會把它讀回來，所以兩邊都要刪', async () => {
        await store.put('keywords', ['a']);
        await store.del('keywords');

        assert.equal(await env.KV_LINE_STORAGE.get(BotKeys.keywords(BOT)), null);
        assert.equal(await env.KV_LINE_STORAGE.get(V1Keys.keywordReplyList(USER)), null);
        assert.equal(await store.get('keywords'), null, '刪除必須真的生效');
    });

    it('只有舊 key 存在時也要刪掉', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-a'), '{}');
        await store.del('member', 'U-a');
        assert.equal(await store.get('member', 'U-a'), null);
    });
});

// ---------------------------------------------------------------------------
// 降級
// ---------------------------------------------------------------------------

describe('BotStore — 算不出 botId 時降級', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, null);
    });

    it('legacyOnly 為真，bot key 為 null', () => {
        assert.equal(store.legacyOnly, true);
        assert.equal(store.keys('keywords').bot, null);
    });

    it('讀寫刪都只走舊命名空間，而不是猜一個 botId', async () => {
        await store.put('keywords', ['a']);

        const botKeys = [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('bot:'));
        assert.deepEqual(botKeys, [], '猜錯 botId 等於把資料寫進別人的命名空間');

        assert.deepEqual(await store.get('keywords'), ['a']);
        await store.del('keywords');
        assert.equal(await store.get('keywords'), null);
    });

    it('舊 key 讀到值時不算 fallback（本來就沒有新路徑可走）', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify(['a']));
        await store.get('keywords');
        assert.deepEqual(store.fallbacks, [],
            'legacyOnly 的回退是常態，不該污染「回填完成」的訊號');
    });
});

describe('BotStore — key 組件含有分隔符', () => {
    it('tag 名稱含有 : 時只走舊命名空間，不可丟錯', async () => {
        const env = createEnv();
        const store = new BotStore(env, USER, BOT);

        // BotKeys 對含有 ':' 的組件丟 TypeError 是對的（跨命名空間寫入的防線），
        // 但那不該讓一筆歷史資料把請求打成 500
        const { bot, v1 } = store.keys('tagEntities', 'member', 'a:b');
        assert.equal(bot, null);
        assert.ok(v1.includes('a:b'));

        await store.put('tagEntities', ['U-1'], 'member', 'a:b');
        assert.deepEqual(await store.get('tagEntities', 'member', 'a:b'), ['U-1']);
    });
});

// ---------------------------------------------------------------------------
// listIds
// ---------------------------------------------------------------------------

describe('BotStore — listIds', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, BOT);
    });

    it('回兩個命名空間的聯集（回填期間兩邊都可能有獨有的項目）', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, 'U-new'), '{}');
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, 'U-both'), '{}');
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-old'), '{}');
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-both'), '{}');

        assert.deepEqual(await store.listIds('member'), ['U-both', 'U-new', 'U-old']);
    });

    it('不可把別的資源的 key 算進來', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-a'), '{}');
        await env.KV_LINE_STORAGE.put(V1Keys.memberLog(USER, 'U-b'), '{}');

        assert.deepEqual(await store.listIds('member'), ['U-a']);
        assert.deepEqual(await store.listIds('memberLog'), ['U-b']);
    });

    it('不可把別的 user / bot 的 key 算進來', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile('Uother', 'U-x'), '{}');
        await env.KV_LINE_STORAGE.put(BotKeys.member('Ubotother', 'U-y'), '{}');
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-mine'), '{}');

        assert.deepEqual(await store.listIds('member'), ['U-mine']);
    });

    it('跨越 KV 分頁（cursor）', async () => {
        for (let i = 0; i < 25; i++) {
            await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, `U-${String(i).padStart(2, '0')}`), '{}');
        }
        const original = env.KV_LINE_STORAGE.list.bind(env.KV_LINE_STORAGE);
        env.KV_LINE_STORAGE.list = (opts = {}) => original({ ...opts, limit: 10 });

        const ids = await store.listIds('member');
        assert.equal(ids.length, 25, '只讀第一頁會漏掉大部分會員');
    });

    it('沒有資料時回空陣列', async () => {
        assert.deepEqual(await store.listIds('member'), []);
    });

    it('不支援需要兩個 id 的資源', async () => {
        await assert.rejects(() => store.listIds('tagEntities'), /只支援單一 id/);
        await assert.rejects(() => store.listIds('keywords'), /只支援單一 id/);
    });
});

// ---------------------------------------------------------------------------
// 人的資料
// ---------------------------------------------------------------------------

describe('BotStore — user 資源', () => {
    let env;
    let store;

    beforeEach(() => {
        env = createEnv();
        store = new BotStore(env, USER, BOT);
    });

    it('profile 不帶 bot 維度（換 bot 之後這筆資料還有意義）', async () => {
        await store.putUser('profile', { userName: 'Tim' });

        assert.ok(await env.KV_LINE_STORAGE.get(UserKeys.profile(USER)));
        assert.ok(await env.KV_LINE_STORAGE.get(V1Keys.profile(USER)));

        const botKeys = [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('bot:'));
        assert.deepEqual(botKeys, [], 'profile 不該進 bot 命名空間');
    });

    it('新 key 優先，沒有才回退舊 key', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.profile(USER), JSON.stringify({ userName: '舊' }));
        assert.deepEqual(await store.getUser('profile'), { userName: '舊' });

        await env.KV_LINE_STORAGE.put(UserKeys.profile(USER), JSON.stringify({ userName: '新' }));
        assert.deepEqual(await store.getUser('profile'), { userName: '新' });
    });

    it('未知的 user 資源要丟錯', async () => {
        await assert.rejects(() => store.getUser('nope'), TypeError);
    });

    it('userId 為 null 時降級到舊 key，不可丟錯變成 500', async () => {
        // 未認證路由上 userId 是 null（index.js 刻意不信任自報的身分）。
        // UserKeys.profile(null) 會丟 TypeError —— 那不該變成一個 500。
        const nullStore = new BotStore(env, null, null);

        await nullStore.putUser('profile', { a: 1 });
        assert.deepEqual(await nullStore.getUser('profile'), { a: 1 });
        assert.deepEqual(
            [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('user:')),
            [],
            '不可用的 userId 不該產生新命名空間的 key'
        );
    });
});

// ---------------------------------------------------------------------------
// openBotStore
// ---------------------------------------------------------------------------

describe('openBotStore', () => {
    it('走新路徑解析 botId（user:<id>:bots 的 currentBotId）', async () => {
        const env = createEnv();
        await seedCurrentBot(env);

        const store = await openBotStore(env, USER);
        assert.equal(store.botId, BOT);
        assert.equal(store.legacyOnly, false);
    });

    it('新路徑沒有時回退舊路徑（current_token → destination）', async () => {
        const env = createEnv();
        await seedLegacyBot(env);

        const store = await openBotStore(env, USER);
        assert.equal(store.botId, BOT);
    });

    it('舊 project 沒有 destination 時降級，而不是猜一個 botId', async () => {
        const env = createEnv();
        await env.KV_LINE_STORAGE.put(V1Keys.currentToken(USER), 'proj');
        await env.KV_LINE_STORAGE.put(
            V1Keys.accessTokens(USER),
            JSON.stringify({ proj: { token: 'tok' } })
        );

        const store = await openBotStore(env, USER);
        assert.equal(store.botId, null);
        assert.equal(store.legacyOnly, true);
    });

    it('完全沒有資料的新使用者也不可丟錯', async () => {
        const store = await openBotStore(createEnv(), USER);
        assert.equal(store.legacyOnly, true);
    });
});
