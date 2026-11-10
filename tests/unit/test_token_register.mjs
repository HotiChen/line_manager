/**
 * Unit Tests — /token/register
 *
 * 兩件事：
 *
 * 1. 寫入必須加密（A3）。走 token_store.saveAccessToken，缺金鑰時拒絕註冊
 *    而不是降級存明文。
 *
 * 2. 暫時擋住第二個官方帳號（A4）。所有資料的 KV key 綁的是「登入的人」而不是
 *    「官方帳號」，所以同一個登入底下的第二個帳號會跟第一個共用同一份關鍵字、
 *    會員與標籤。使用者看到的是「我切換了帳號但資料沒變」，而他會合理地
 *    回報成資料遺失。
 *
 *    在 botId 統一完成之前，明確拒絕並說明原因，比讓人踩到然後懷疑資料不見
 *    要好。既有已經有兩個帳號的使用者不受影響 —— 只擋新增。
 *
 *    重新註冊同一個帳號必須放行，那是換 token（輪替、過期重設）的正常操作。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const KEY = Buffer.alloc(32, 5).toString('base64');
const NEW_TOKEN = 'brand-new-channel-access-token';

const originalFetch = globalThis.fetch;

/** /v2/bot/info 回傳 userId（= destination）與 displayName */
function mockBotInfo(destination, displayName = '某個官方帳號') {
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ userId: destination, displayName }), { status: 200 });
}

function mockBotInfoFailure() {
    globalThis.fetch = async () => new Response('nope', { status: 401 });
}

function registerRequest(project, token) {
    return new Request('https://example.com/token/register', {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ project, token }),
    });
}

async function load() {
    return import('../../worker_src/handler/token.js');
}

function envWith(kv, withKey = true) {
    return withKey ? { KV_LINE_STORAGE: kv, TOKEN_ENCRYPTION_KEY: KEY } : { KV_LINE_STORAGE: kv };
}

describe('註冊時加密寫入', () => {
    it('KV 裡存的不是明文', async () => {
        const { handleRegisterAccessToken } = await load();
        mockBotInfo(BOT_A);
        try {
            const kv = createMockKV();
            const res = await handleRegisterAccessToken(registerRequest('品禔', NEW_TOKEN), envWith(kv), OWNER);
            assert.equal(res.status, 200);

            const raw = await kv.get(`access_tokens_${OWNER}`);
            assert.ok(!raw.includes(NEW_TOKEN), `KV 裡是明文：${raw}`);
            assert.ok(raw.includes('enc.v1.'), '沒有加密標記');
        } finally { globalThis.fetch = originalFetch; }
    });

    it('註冊後可以照常取回明文 token', async () => {
        const { handleRegisterAccessToken } = await load();
        const { getAccessTokenForProject } = await import('../../worker_src/lib/token_store.js');
        mockBotInfo(BOT_A);
        try {
            const kv = createMockKV();
            const env = envWith(kv);
            await handleRegisterAccessToken(registerRequest('品禔', NEW_TOKEN), env, OWNER);
            assert.equal(await getAccessTokenForProject(env, OWNER, '品禔'), NEW_TOKEN);
        } finally { globalThis.fetch = originalFetch; }
    });

    it('缺金鑰時拒絕註冊，且不留下半筆資料（fail-closed）', async () => {
        const { handleRegisterAccessToken } = await load();
        mockBotInfo(BOT_A);
        try {
            const kv = createMockKV();
            const res = await handleRegisterAccessToken(
                registerRequest('品禔', NEW_TOKEN), envWith(kv, false), OWNER);
            assert.equal(res.status, 503);
            assert.equal(await kv.get(`access_tokens_${OWNER}`), null, '不該留下資料');
            assert.equal(await kv.get(`destination_user_${BOT_A}`), null, '不該留下反查索引');
        } finally { globalThis.fetch = originalFetch; }
    });

    it('destination_user 反查索引照舊建立', async () => {
        const { handleRegisterAccessToken } = await load();
        mockBotInfo(BOT_A);
        try {
            const kv = createMockKV();
            await handleRegisterAccessToken(registerRequest('品禔', NEW_TOKEN), envWith(kv), OWNER);
            assert.equal(await kv.get(`destination_user_${BOT_A}`), OWNER);
        } finally { globalThis.fetch = originalFetch; }
    });

    it('LINE 驗證失敗時不寫入任何東西', async () => {
        const { handleRegisterAccessToken } = await load();
        mockBotInfoFailure();
        try {
            const kv = createMockKV();
            const res = await handleRegisterAccessToken(registerRequest('品禔', 'bad'), envWith(kv), OWNER);
            assert.equal(res.status, 400);
            assert.equal(await kv.get(`access_tokens_${OWNER}`), null);
        } finally { globalThis.fetch = originalFetch; }
    });
});

describe('暫時只允許一個官方帳號', () => {
    async function registerFirst(kv) {
        const { handleRegisterAccessToken } = await load();
        mockBotInfo(BOT_A, '品禔 photo studio');
        await handleRegisterAccessToken(registerRequest('品禔', NEW_TOKEN), envWith(kv), OWNER);
    }

    it('第一個帳號正常註冊', async () => {
        const kv = createMockKV();
        try {
            await registerFirst(kv);
            const stored = await kv.get(`access_tokens_${OWNER}`, { type: 'json' });
            assert.deepEqual(Object.keys(stored), ['品禔']);
        } finally { globalThis.fetch = originalFetch; }
    });

    it('第二個不同的官方帳號被拒絕，並說明原因', async () => {
        const kv = createMockKV();
        try {
            await registerFirst(kv);

            const { handleRegisterAccessToken } = await load();
            mockBotInfo(BOT_B, '另一個帳號');
            const res = await handleRegisterAccessToken(
                registerRequest('另一個', 'another-token'), envWith(kv), OWNER);

            assert.equal(res.status, 409);
            const body = await res.json();
            assert.match(body.error, /一個|one/i, `錯誤訊息要說明限制：${body.error}`);
            assert.ok(body.existingDisplayName, '要告訴使用者目前綁的是哪個帳號');
        } finally { globalThis.fetch = originalFetch; }
    });

    it('被拒絕時不可改動既有資料', async () => {
        const kv = createMockKV();
        try {
            await registerFirst(kv);
            const before = await kv.get(`access_tokens_${OWNER}`);

            const { handleRegisterAccessToken } = await load();
            mockBotInfo(BOT_B, '另一個帳號');
            await handleRegisterAccessToken(registerRequest('另一個', 'another-token'), envWith(kv), OWNER);

            assert.equal(await kv.get(`access_tokens_${OWNER}`), before, '既有資料被改動了');
            assert.equal(await kv.get(`destination_user_${BOT_B}`), null, '不該建立新索引');
        } finally { globalThis.fetch = originalFetch; }
    });

    it('重新註冊同一個官方帳號要放行（換 token 是正常操作）', async () => {
        const kv = createMockKV();
        try {
            await registerFirst(kv);

            const { handleRegisterAccessToken } = await load();
            const { getAccessTokenForProject } = await import('../../worker_src/lib/token_store.js');
            mockBotInfo(BOT_A, '品禔 photo studio');
            const res = await handleRegisterAccessToken(
                registerRequest('品禔', 'rotated-token'), envWith(kv), OWNER);

            assert.equal(res.status, 200);
            assert.equal(await getAccessTokenForProject(envWith(kv), OWNER, '品禔'), 'rotated-token');
        } finally { globalThis.fetch = originalFetch; }
    });

    it('同一個官方帳號換個專案名稱重新註冊也放行', async () => {
        const kv = createMockKV();
        try {
            await registerFirst(kv);
            const { handleRegisterAccessToken } = await load();
            mockBotInfo(BOT_A, '品禔 photo studio');
            const res = await handleRegisterAccessToken(
                registerRequest('品禔改名', NEW_TOKEN), envWith(kv), OWNER);
            assert.equal(res.status, 200);
        } finally { globalThis.fetch = originalFetch; }
    });

    it('已經有兩個帳號的既有使用者不受影響（只擋新增）', async () => {
        const kv = createMockKV();
        try {
            // 模擬加上限制之前就存在的兩個帳號
            await kv.put(`access_tokens_${OWNER}`, JSON.stringify({
                '熱茶測試中': { token: 'plain-a', destination: BOT_A, displayName: '熱茶測試中' },
                '熱茶小秘書': { token: 'plain-b', destination: BOT_B, displayName: '熱茶小秘書' },
            }));

            const { getAccessTokenForProject } = await import('../../worker_src/lib/token_store.js');
            const env = envWith(kv);
            assert.equal(await getAccessTokenForProject(env, OWNER, '熱茶測試中'), 'plain-a');
            assert.equal(await getAccessTokenForProject(env, OWNER, '熱茶小秘書'), 'plain-b');

            // 但第三個要被擋
            const { handleRegisterAccessToken } = await load();
            mockBotInfo('Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb03', '第三個');
            const res = await handleRegisterAccessToken(registerRequest('第三個', 'tok-c'), env, OWNER);
            assert.equal(res.status, 409);
        } finally { globalThis.fetch = originalFetch; }
    });
});
