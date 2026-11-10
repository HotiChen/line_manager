/**
 * Unit Tests — /token/list
 *
 * 兩個問題，同一個函式：
 *
 * 1. 它會崩潰。`Promise.all([kv.get(..) || {}, kv.get(..) || { bots: [] }])` 的
 *    `||` 作用在 Promise 上，而 Promise 永遠 truthy，所以預設值從來不會生效。
 *    沒有 user:<id>:bots 這個 key 的使用者，`userBotsData` 是 null，
 *    接著 `userBotsData.bots` 就拋 TypeError。正式環境只有兩個使用者有那個
 *    key，其餘的打 /token/list 都是 500 —— 而後台列專案只靠這一個端點。
 *
 * 2. 它外洩憑證。回傳的是 `{ ...accessTokens }`，而每個值是
 *    `{ token, destination, displayName }` —— 完整的 LINE channel access token
 *    被送進瀏覽器。配上前端還有的裸 innerHTML，任何一處 XSS 就能拿到那個
 *    官方帳號的完全控制權。前端沒有任何地方讀這個值（profile.js 把它解構成
 *    `token` 但只用了 key），所以拿掉是安全的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const SECRET_TOKEN = 'channel-access-token-must-never-leave-the-worker';

async function load() {
    return import('../../worker_src/handler/token.js');
}

function envWith(kv) {
    return { KV_LINE_STORAGE: kv };
}

async function seedAccessTokens(kv) {
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({
        '品禔': { token: SECRET_TOKEN, destination: BOT_A, displayName: '品禔 photo studio' },
    }));
}

describe('/token/list 不可崩潰', () => {
    it('沒有 user:<id>:bots 時照常回傳，不可 500', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);

        const res = await handleListUserProjects(envWith(kv), OWNER);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(Object.keys(body), ['品禔']);
    });

    it('兩個 key 都沒有時回空物件，不可 500', async () => {
        const { handleListUserProjects } = await load();
        const res = await handleListUserProjects(envWith(createMockKV()), OWNER);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {});
    });

    it('user:<id>:bots 存在但 bots 欄位缺失時也不可 500', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);
        await kv.put(`user:${OWNER}:bots`, JSON.stringify({ currentBotId: BOT_A }));

        const res = await handleListUserProjects(envWith(kv), OWNER);
        assert.equal(res.status, 200);
    });
});

describe('/token/list 不可外洩 access token', () => {
    it('回應裡任何地方都不得出現 token 值', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);

        const res = await handleListUserProjects(envWith(kv), OWNER);
        const raw = JSON.stringify(await res.json());
        assert.ok(!raw.includes(SECRET_TOKEN), `token 出現在回應裡：${raw}`);
    });

    it('值是 botId 字串，不是帶 token 的物件', async () => {
        // 形狀統一成字串，而不是只把 token 欄位挖掉。理由是前端有三個消費者
        // （token_manager.js:29、team_management.js:505、
        // flow_designer_data_loader.js:303）都把值當 botId 字串用，而現在的
        // 回應是混合的：access_tokens 來的是物件、user:<id>:bots 來的是字串，
        // 所以那三處今天就在把物件插進模板，渲染成 [object Object]。
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);

        const body = await (await handleListUserProjects(envWith(kv), OWNER)).json();
        assert.equal(typeof body['品禔'], 'string', `值不是字串：${JSON.stringify(body['品禔'])}`);
        assert.equal(body['品禔'], BOT_A);
    });

    it('每一個值都是字串，新舊來源都一樣', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);
        await kv.put(`user:${OWNER}:bots`, JSON.stringify({ bots: [{ botId: BOT_B }] }));
        await kv.put(`bot:${BOT_B}:info`, JSON.stringify({ name: '熱茶小秘書' }));

        const body = await (await handleListUserProjects(envWith(kv), OWNER)).json();
        for (const [name, value] of Object.entries(body)) {
            assert.equal(typeof value, 'string', `${name} 的值不是字串`);
        }
    });

    it('舊格式（值直接是字串 token）也不可外洩', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ '舊專案': SECRET_TOKEN }));

        const res = await handleListUserProjects(envWith(kv), OWNER);
        const raw = JSON.stringify(await res.json());
        assert.ok(!raw.includes(SECRET_TOKEN), `舊格式的 token 外洩：${raw}`);
        assert.ok(Object.keys(await (await handleListUserProjects(envWith(kv), OWNER)).json()).includes('舊專案'),
            '專案名稱應該還在');
    });
});

describe('/token/list 的新舊資料合併', () => {
    it('user:<id>:bots 裡的 bot 會被加進來', async () => {
        const { handleListUserProjects } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);
        await kv.put(`user:${OWNER}:bots`, JSON.stringify({ bots: [{ botId: BOT_B }] }));
        await kv.put(`bot:${BOT_B}:info`, JSON.stringify({ name: '熱茶小秘書' }));

        const body = await (await handleListUserProjects(envWith(kv), OWNER)).json();
        assert.ok(Object.keys(body).includes('品禔'));
        assert.ok(Object.keys(body).includes('熱茶小秘書'), `合併失敗：${Object.keys(body)}`);
    });
});

describe('/token/current 也不可外洩 access token', () => {
    // 這個端點全 repo 零呼叫者，而前端完全不直接呼叫 api.line.me，所以它沒有
    // 任何正當理由需要 token。它的註解原本寫明是刻意回傳「密鑰 token」。
    // 保留端點但移除祕密：萬一有我看不到的呼叫端，它還是能知道當前專案是哪個。
    it('回應裡不得出現 token 值', async () => {
        const { handleGetCurrentToken } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);
        await kv.put(`current_token_${OWNER}`, '品禔');

        const res = await handleGetCurrentToken(envWith(kv), OWNER);
        assert.equal(res.status, 200);
        const raw = JSON.stringify(await res.json());
        assert.ok(!raw.includes(SECRET_TOKEN), `token 出現在回應裡：${raw}`);
    });

    it('仍回傳當前專案名稱與 botId', async () => {
        const { handleGetCurrentToken } = await load();
        const kv = createMockKV();
        await seedAccessTokens(kv);
        await kv.put(`current_token_${OWNER}`, '品禔');

        const body = await (await handleGetCurrentToken(envWith(kv), OWNER)).json();
        assert.equal(body.project, '品禔');
        assert.equal(body.botId, BOT_A);
        assert.ok(!('token' in body), 'token 欄位仍在');
    });

    it('沒有設定當前專案時回 404', async () => {
        const { handleGetCurrentToken } = await load();
        const res = await handleGetCurrentToken(envWith(createMockKV()), OWNER);
        assert.equal(res.status, 404);
    });

    it('舊格式（值是字串 token）不得把字串當成資料回傳', async () => {
        const { handleGetCurrentToken } = await load();
        const kv = createMockKV();
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ '舊專案': SECRET_TOKEN }));
        await kv.put(`current_token_${OWNER}`, '舊專案');

        const res = await handleGetCurrentToken(envWith(kv), OWNER);
        const raw = JSON.stringify(await res.json());
        assert.ok(!raw.includes(SECRET_TOKEN), `舊格式的 token 外洩：${raw}`);
    });
});
