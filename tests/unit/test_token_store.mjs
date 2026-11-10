/**
 * Unit Tests — token_store：access token 的單一存取出口
 *
 * 為什麼需要這一層：原本有 9 個地方各自讀 access_tokens_<userId> 再從裡面
 * 挖 token，而且「物件還是字串」的判斷寫了至少三種版本：
 *
 *   (typeof info === "object" && info !== null) ? info.token : info
 *   typeof currentData === 'string' ? currentData : currentData?.token
 *   tokenMap[currentProject]?.token || tokenMap[currentProject]
 *
 * 要加入解密，把它散到 9 個地方等於保證漏掉一個 —— 而漏掉一個就是正式環境
 * 壞掉一個功能，還是最難發現的那種（token 變成密文字串送去 LINE）。
 *
 * 所以收斂成四個函式，對應那 9 處的四種取用模式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const PLAIN = 'line-channel-access-token-plain';
const KEY = Buffer.alloc(32, 3).toString('base64');

async function load() {
    return import('../../worker_src/lib/token_store.js');
}

function envWith(kv, withKey = true) {
    return withKey ? { KV_LINE_STORAGE: kv, TOKEN_ENCRYPTION_KEY: KEY } : { KV_LINE_STORAGE: kv };
}

/** 直接塞明文資料，模擬加密上線前的既有 KV 內容 */
async function seedPlaintext(kv, entries, current) {
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify(entries));
    if (current) await kv.put(`current_token_${OWNER}`, current);
}

describe('getCurrentAccessToken', () => {
    it('取得當前專案的 token（明文資料）', async () => {
        const { getCurrentAccessToken } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { '品禔': { token: PLAIN, destination: BOT_A } }, '品禔');
        assert.equal(await getCurrentAccessToken(envWith(kv), OWNER), PLAIN);
    });

    it('沒有設定當前專案時回 null', async () => {
        const { getCurrentAccessToken } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { '品禔': { token: PLAIN, destination: BOT_A } });
        assert.equal(await getCurrentAccessToken(envWith(kv), OWNER), null);
    });

    it('當前專案不存在時回 null', async () => {
        const { getCurrentAccessToken } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { '品禔': { token: PLAIN } }, '已刪除');
        assert.equal(await getCurrentAccessToken(envWith(kv), OWNER), null);
    });

    it('舊格式（值直接是字串 token）也要支援', async () => {
        const { getCurrentAccessToken } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { '舊專案': PLAIN }, '舊專案');
        assert.equal(await getCurrentAccessToken(envWith(kv), OWNER), PLAIN);
    });

    it('完全沒資料時回 null', async () => {
        const { getCurrentAccessToken } = await load();
        assert.equal(await getCurrentAccessToken(envWith(createMockKV()), OWNER), null);
    });
});

describe('getAccessTokenForProject', () => {
    it('依專案名稱取得', async () => {
        const { getAccessTokenForProject } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { 'A': { token: 'tok-a' }, 'B': { token: 'tok-b' } });
        assert.equal(await getAccessTokenForProject(envWith(kv), OWNER, 'B'), 'tok-b');
    });

    it('專案不存在回 null', async () => {
        const { getAccessTokenForProject } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { 'A': { token: 'tok-a' } });
        assert.equal(await getAccessTokenForProject(envWith(kv), OWNER, 'Z'), null);
    });
});

describe('getAccessTokenForDestination', () => {
    it('依 destination 取得 token 與專案名稱', async () => {
        const { getAccessTokenForDestination } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, {
            '熱茶測試中': { token: 'tok-a', destination: BOT_A },
            '熱茶小秘書': { token: 'tok-b', destination: BOT_B },
        });
        const found = await getAccessTokenForDestination(envWith(kv), OWNER, BOT_B);
        assert.equal(found.token, 'tok-b');
        assert.equal(found.projectName, '熱茶小秘書');
    });

    it('找不到 destination 時 token 為 null', async () => {
        const { getAccessTokenForDestination } = await load();
        const kv = createMockKV();
        await seedPlaintext(kv, { 'A': { token: 'tok-a', destination: BOT_A } });
        const found = await getAccessTokenForDestination(envWith(kv), OWNER, BOT_B);
        assert.equal(found.token, null);
        assert.equal(found.projectName, null);
    });
});

describe('saveAccessToken — 寫入時一律加密', () => {
    it('存進 KV 的值不是明文', async () => {
        const { saveAccessToken } = await load();
        const kv = createMockKV();
        await saveAccessToken(envWith(kv), OWNER, '品禔', {
            token: PLAIN, destination: BOT_A, displayName: '品禔 photo studio',
        });

        const raw = await kv.get(`access_tokens_${OWNER}`);
        assert.ok(!raw.includes(PLAIN), `KV 裡是明文：${raw}`);
        assert.ok(raw.includes('enc.v1.'), 'KV 裡沒有密文標記');
    });

    it('存進去之後讀回來是明文', async () => {
        const { saveAccessToken, getCurrentAccessToken } = await load();
        const kv = createMockKV();
        const env = envWith(kv);
        await saveAccessToken(env, OWNER, '品禔', { token: PLAIN, destination: BOT_A });
        await kv.put(`current_token_${OWNER}`, '品禔');

        assert.equal(await getCurrentAccessToken(env, OWNER), PLAIN);
    });

    it('destination 與 displayName 不加密（不是祕密，要能查詢）', async () => {
        const { saveAccessToken } = await load();
        const kv = createMockKV();
        await saveAccessToken(envWith(kv), OWNER, '品禔', {
            token: PLAIN, destination: BOT_A, displayName: '品禔 photo studio',
        });
        const stored = await kv.get(`access_tokens_${OWNER}`, { type: 'json' });
        assert.equal(stored['品禔'].destination, BOT_A);
        assert.equal(stored['品禔'].displayName, '品禔 photo studio');
    });

    it('新增第二個專案不會覆蓋第一個', async () => {
        const { saveAccessToken } = await load();
        const kv = createMockKV();
        const env = envWith(kv);
        await saveAccessToken(env, OWNER, 'A', { token: 'tok-a', destination: BOT_A });
        await saveAccessToken(env, OWNER, 'B', { token: 'tok-b', destination: BOT_B });
        const stored = await kv.get(`access_tokens_${OWNER}`, { type: 'json' });
        assert.deepEqual(Object.keys(stored).sort(), ['A', 'B']);
    });

    it('沒有金鑰時拒絕寫入（fail-closed，不可降級存明文）', async () => {
        const { saveAccessToken } = await load();
        const kv = createMockKV();
        await assert.rejects(
            () => saveAccessToken(envWith(kv, false), OWNER, '品禔', { token: PLAIN, destination: BOT_A }),
            /TOKEN_ENCRYPTION_KEY/);
        assert.equal(await kv.get(`access_tokens_${OWNER}`), null, '失敗時不該留下半筆資料');
    });
});

describe('明文與密文混存', () => {
    it('同一份資料裡一個加密一個明文，兩個都讀得出來', async () => {
        const { saveAccessToken, getAccessTokenForProject } = await load();
        const kv = createMockKV();
        const env = envWith(kv);
        // 既有明文
        await seedPlaintext(kv, { '舊的': { token: 'old-plain', destination: BOT_A } });
        // 新加入的會被加密
        await saveAccessToken(env, OWNER, '新的', { token: 'new-secret', destination: BOT_B });

        assert.equal(await getAccessTokenForProject(env, OWNER, '舊的'), 'old-plain');
        assert.equal(await getAccessTokenForProject(env, OWNER, '新的'), 'new-secret');
    });
});
