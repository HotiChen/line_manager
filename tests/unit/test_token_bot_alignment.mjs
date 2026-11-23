/**
 * Unit Tests — token 必須跟資料所屬的那個 bot 對齊
 *
 * 症狀：名單裡的會員是 A 帳號的，推播卻用 B 帳號的 token 送出去 ——
 * LINE 回 400 Invalid user id，而後台畫面上一切正常。
 *
 * 原因：資料與 token 的「帳號」來自兩條不同的路：
 *
 *   資料（bot_store）  resolveBotId → user:<userId>:bots 的 currentBotId
 *   token             getCurrentAccessToken → current_token_<userId>（專案名稱）
 *
 * 正常情況兩者指向同一個帳號，所以平常看不出來。但只要兩筆 KV 不同步
 * （mode=repair 建了 user:bots、後台又切過專案、舊資料只有其中一筆），
 * 就會錯開 —— 而且錯開的時候不會報錯，只是送到別的帳號去。
 *
 * webhook 路徑更嚴重：store 的 botId 是事件的 destination（正確的），
 * 但 token 讀的是「owner 此刻在後台選的帳號」。A 帳號有人加好友，
 * 可能用 B 帳號的 token 去掛圖文選單。
 *
 * 修法：token 的查詢改以 botId（destination）為準。
 *
 *   getAccessTokenForStore(store)            用 store 已經確定的 botId
 *   getAccessTokenForCurrentBot(env, userId) 沒有 store 時自己解析一次
 *
 * 兩者在「算不出 botId」時才退回 current_token —— 那是舊資料的常態，
 * 不是錯開。但 botId 算得出來、卻找不到它的 token 時一律回 null：
 * 這時退回 current_token 等於把這個 bug 原封不動放回來。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const MEMBER = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
const TOKEN_A = 'token-of-bot-a';
const TOKEN_B = 'token-of-bot-b';
const KEY = Buffer.alloc(32, 3).toString('base64');

/**
 * 兩個帳號都登記了 token，但「current」刻意錯開：
 *   user:bots.currentBotId = BOT_A（資料走這條）
 *   current_token          = B 專案（token 原本走這條）
 */
async function seedMisaligned(kv, { currentBotId = BOT_A, currentProject = 'B專案' } = {}) {
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({
        'A專案': { token: TOKEN_A, destination: BOT_A, displayName: '熱茶測試中' },
        'B專案': { token: TOKEN_B, destination: BOT_B, displayName: '另一個帳號' },
    }));
    if (currentProject) await kv.put(`current_token_${OWNER}`, currentProject);
    if (currentBotId) await kv.put(`user:${OWNER}:bots`, JSON.stringify({ currentBotId }));
}

function envOf(kv) {
    return { KV_LINE_STORAGE: kv, TOKEN_ENCRYPTION_KEY: KEY };
}

describe('getAccessTokenForStore — 用 store 已經確定的 botId', () => {
    let kv, env;
    beforeEach(async () => {
        kv = createMockKV();
        env = envOf(kv);
        await seedMisaligned(kv);
    });

    it('以 store.botId 為準，不理 current_token', async () => {
        const { getAccessTokenForStore } = await import('../../worker_src/lib/token_store.js');
        const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

        const store = openBotStoreFor(env, OWNER, BOT_A);
        assert.equal(await getAccessTokenForStore(store), TOKEN_A,
            'current_token 指向 B 專案，token 卻該是 A 帳號的');
    });

    it('webhook 的 store（botId = destination）拿到的是那個帳號的 token', async () => {
        const { getAccessTokenForStore } = await import('../../worker_src/lib/token_store.js');
        const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

        const store = openBotStoreFor(env, OWNER, BOT_B);
        assert.equal(await getAccessTokenForStore(store), TOKEN_B);
    });

    it('botId 有、但那個 bot 沒有登記 token 時回 null（不退回 current_token）', async () => {
        const { getAccessTokenForStore } = await import('../../worker_src/lib/token_store.js');
        const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

        const UNKNOWN = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb09';
        const store = openBotStoreFor(env, OWNER, UNKNOWN);
        assert.equal(await getAccessTokenForStore(store), null,
            '退回 current_token 等於把「用錯帳號的 token」這個 bug 放回來');
    });

    it('算不出 botId 時退回 current_token（舊資料的常態，不可退步）', async () => {
        const { getAccessTokenForStore } = await import('../../worker_src/lib/token_store.js');
        const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

        const store = openBotStoreFor(env, OWNER, null);
        assert.equal(await getAccessTokenForStore(store), TOKEN_B, 'current_token 指向 B 專案');
    });

    it('沒有 userId 可用時回 null，不去讀 access_tokens_null', async () => {
        const { getAccessTokenForStore } = await import('../../worker_src/lib/token_store.js');
        const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

        const store = openBotStoreFor(env, null, BOT_A);
        assert.equal(await getAccessTokenForStore(store), null);
    });
});

describe('getAccessTokenForCurrentBot — 沒有 store 時自己解析一次', () => {
    let kv, env;
    beforeEach(async () => {
        kv = createMockKV();
        env = envOf(kv);
    });

    it('user:bots 與 current_token 錯開時以 botId 為準', async () => {
        await seedMisaligned(kv);
        const { getAccessTokenForCurrentBot } = await import('../../worker_src/lib/token_store.js');
        assert.equal(await getAccessTokenForCurrentBot(env, OWNER), TOKEN_A);
    });

    it('沒有 user:bots 時沿用舊路徑（current_token 的專案自己帶 destination）', async () => {
        await seedMisaligned(kv, { currentBotId: null, currentProject: 'B專案' });
        const { getAccessTokenForCurrentBot } = await import('../../worker_src/lib/token_store.js');
        assert.equal(await getAccessTokenForCurrentBot(env, OWNER), TOKEN_B);
    });

    it('完全算不出 botId 時退回 current_token（舊格式：值是字串）', async () => {
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ '舊專案': TOKEN_B }));
        await kv.put(`current_token_${OWNER}`, '舊專案');
        const { getAccessTokenForCurrentBot } = await import('../../worker_src/lib/token_store.js');
        assert.equal(await getAccessTokenForCurrentBot(env, OWNER), TOKEN_B,
            '舊格式沒有 destination，只能走 current_token —— 不可因此變成 null');
    });
});

describe('推播用的 token 必須是名單所屬帳號的', () => {
    const originalFetch = globalThis.fetch;

    it('/api/send-message 用 A 帳號的 token，即使 current_token 指向 B', async () => {
        const kv = createMockKV();
        const env = envOf(kv);
        await seedMisaligned(kv);
        await kv.put(`bot:${BOT_A}:member:${MEMBER}`, JSON.stringify({ memberId: MEMBER, lineName: '王小明' }));

        const seen = [];
        globalThis.fetch = async (url, init) => {
            seen.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
            return new Response('{}', { status: 200 });
        };

        try {
            const { handleSendPushMessage } = await import('../../worker_src/handler/push_message.js');
            const request = new Request('https://example.com/api/send-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: MEMBER, messages: [{ type: 'text', text: '推播測試' }] }),
            });

            const res = await handleSendPushMessage(request, env, OWNER);
            const body = await res.json();
            assert.equal(body.success, true, `推播失敗：${body.error}`);

            const push = seen.find(r => r.url.includes('/v2/bot/message/push'));
            assert.ok(push, '沒有呼叫 LINE push API');
            assert.equal(push.auth, `Bearer ${TOKEN_A}`,
                '用了 current_token 指向的 B 帳號 token —— LINE 會回 400 Invalid user id');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('webhook 路徑：圖文選單要用事件來源帳號的 token', () => {
    const originalFetch = globalThis.fetch;

    it('A 帳號的會員同步選單時用 A 的 token，即使後台選的是 B', async () => {
        const kv = createMockKV();
        const env = envOf(kv);
        // 後台選的是 B 帳號（兩條路都指向 B），但事件來自 A
        await seedMisaligned(kv, { currentBotId: BOT_B, currentProject: 'B專案' });
        await kv.put(`bot:${BOT_A}:member:${MEMBER}`, JSON.stringify({
            memberId: MEMBER, lineName: '王小明', tags: ['VIP'],
        }));
        await kv.put(`bot:${BOT_A}:richmenu_segmented_rules`, JSON.stringify([
            { tag: 'VIP', richMenuId: 'richmenu-aaa', priority: 1 },
        ]));

        const seen = [];
        globalThis.fetch = async (url, init) => {
            seen.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
            return new Response('{}', { status: 200 });
        };

        try {
            const { syncMemberRichMenu } = await import('../../worker_src/lib/segmented_richmenu_logic.js');
            const { openBotStoreFor } = await import('../../worker_src/lib/bot_store.js');

            await syncMemberRichMenu(openBotStoreFor(env, OWNER, BOT_A), MEMBER);

            const link = seen.find(r => r.url.includes('/richmenu/'));
            assert.ok(link, '沒有呼叫 LINE richmenu API');
            assert.equal(link.auth, `Bearer ${TOKEN_A}`,
                '用了後台當下選的 B 帳號 token —— 選單會掛到錯的官方帳號');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
