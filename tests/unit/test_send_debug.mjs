/**
 * Unit Tests — lib/send_debug.js（暫時診斷：記錄真正送給 LINE 的請求）
 *
 * 不變量（這些就是「可以安全開在正式環境」的理由）：
 *   - 預設關閉：env.BRIDGE_DEBUG_SEND 必須精確等於 "1" 才會記任何東西
 *   - 不含 access token：Authorization 只留長度與 SHA-256 前 8 碼指紋
 *   - 不含 LINE userId：payload.to 在 body 文字裡被換成 `<uid:xxxxxx>`（SHA-256 前 6 碼）
 *   - 其餘內容逐字保留（要比對的就是它）；記錄本身不可丟錯
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    sendDebugEnabled,
    maskUserId,
    logSendRequest,
    logSendResponse,
} from '../../worker_src/lib/send_debug.js';

const TOKEN = 'CHANNEL_ACCESS_TOKEN_SECRET_VALUE_0123456789';
const UID = 'U0123456789abcdef0123456789abcdef';
const RETRY_KEY = '123e4567-e89b-42d3-a456-426614174000';
const URL = 'https://api.line.me/v2/bot/message/push';

const headersFor = (retryKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
    ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}),
});

let logs;
const originalLog = console.log;
beforeEach(() => {
    logs = [];
    console.log = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
});
afterEach(() => { console.log = originalLog; });

const text = () => logs.join('\n');
/** 最後一筆 log 的 JSON 部分 */
const lastJson = () => JSON.parse(logs[logs.length - 1].slice(logs[logs.length - 1].indexOf('{')));

describe('sendDebugEnabled', () => {
    it('只有精確字串 "1" 才開啟', () => {
        assert.equal(sendDebugEnabled({ BRIDGE_DEBUG_SEND: '1' }), true);
    });

    it('缺值、空字串、"0"、"true"、1（數字）、null env 都是關閉', () => {
        for (const v of [undefined, '', '0', 'true', 'yes', 1, true, ' 1']) {
            assert.equal(sendDebugEnabled({ BRIDGE_DEBUG_SEND: v }), false, String(v));
        }
        assert.equal(sendDebugEnabled({}), false);
        assert.equal(sendDebugEnabled(null), false);
        assert.equal(sendDebugEnabled(undefined), false);
    });
});

describe('maskUserId', () => {
    it('是 `<uid:` + SHA-256 前 6 碼，且不含原始 userId', async () => {
        const masked = await maskUserId(UID);
        assert.match(masked, /^<uid:[0-9a-f]{6}>$/);
        assert.ok(!masked.includes(UID));
    });

    it('同一個 id 永遠相同、不同 id 不同（可以用來比對兩邊是不是同一個人）', async () => {
        assert.equal(await maskUserId(UID), await maskUserId(UID));
        assert.notEqual(await maskUserId(UID), await maskUserId(`${UID}x`));
    });
});

describe('logSendRequest', () => {
    const payload = { to: UID, messages: [{ type: 'text', text: 'hello' }] };

    it('記下 url、method、header 與 body（body 逐字，只有 userId 被遮）', async () => {
        const body = JSON.stringify(payload);
        await logSendRequest('Push', URL, headersFor(RETRY_KEY), payload, body);
        const entry = lastJson();
        assert.equal(entry.url, URL);
        assert.equal(entry.method, 'POST');
        assert.equal(entry.headers['Content-Type'], 'application/json');
        assert.equal(entry.headers['X-Line-Retry-Key'], RETRY_KEY);
        assert.equal(entry.body, body.replace(UID, await maskUserId(UID)));
        assert.ok(entry.body.includes('"messages":[{"type":"text","text":"hello"}]'));
        assert.equal(entry.body_bytes, new TextEncoder().encode(body).length);
    });

    it('不含 access token：Authorization 只有長度與指紋', async () => {
        await logSendRequest('Push', URL, headersFor(RETRY_KEY), payload, JSON.stringify(payload));
        assert.ok(!text().includes(TOKEN), 'log 含 token');
        const auth = lastJson().headers.Authorization;
        assert.match(auth, /^Bearer <redacted len=\d+ fp=[0-9a-f]{8}>$/);
        assert.ok(auth.includes(`len=${TOKEN.length}`));
    });

    it('同一把 token 指紋相同、不同 token 不同（可以比對是不是同一個 channel）', async () => {
        await logSendRequest('Push', URL, headersFor(), payload, JSON.stringify(payload));
        await logSendRequest('Push', URL, { Authorization: `Bearer ${TOKEN}` }, payload, JSON.stringify(payload));
        await logSendRequest('Push', URL, { Authorization: 'Bearer OTHER_CHANNEL_TOKEN' }, payload, JSON.stringify(payload));
        const fps = logs.map((l) => /fp=([0-9a-f]{8})/.exec(l)[1]);
        assert.equal(fps[0], fps[1]);
        assert.notEqual(fps[0], fps[2]);
    });

    it('不含 LINE userId（body 與整行 log 都沒有）', async () => {
        await logSendRequest('Push', URL, headersFor(RETRY_KEY), payload, JSON.stringify(payload));
        assert.ok(!text().includes(UID), 'log 含 userId');
        assert.ok(lastJson().body.includes(`"to":"${await maskUserId(UID)}"`));
    });

    it('multicast：to 是陣列，每一個都遮掉', async () => {
        const uid2 = 'U9999999999999999999999999999ffff';
        const multi = { to: [UID, uid2], messages: [{ type: 'text', text: 'hi' }] };
        await logSendRequest('Multicast', URL, headersFor(), multi, JSON.stringify(multi));
        const t = text();
        assert.ok(!t.includes(UID) && !t.includes(uid2));
        assert.ok(t.includes(await maskUserId(UID)) && t.includes(await maskUserId(uid2)));
    });

    it('記錄失敗不可讓發送失敗（payload 很怪也只是不記）', async () => {
        const circular = { to: UID };
        circular.self = circular;
        await logSendRequest('Push', URL, headersFor(), circular, '{bad json');
        // 不丟錯就算通過
        assert.ok(true);
    });
});

describe('logSendResponse', () => {
    it('記下狀態碼與 LINE 的 x-line-request-id', async () => {
        await logSendResponse('Push', new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-abc-123' } }));
        const entry = lastJson();
        assert.equal(entry.status, 200);
        assert.equal(entry.request_id, 'req-abc-123');
    });

    it('沒有 request id 時是 null，不丟錯', async () => {
        await logSendResponse('Push', new Response('{}', { status: 500 }));
        assert.equal(lastJson().status, 500);
        assert.equal(lastJson().request_id, null);
    });
});
