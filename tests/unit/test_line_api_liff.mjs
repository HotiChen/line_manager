/**
 * Unit Tests — lib/line_api.js 的 LINE Login 部分（LM-4C）
 *
 *   issueLoginChannelToken（stateless v3 → 退回 short-lived）、LIFF Server API（list／create／delete）、verifyIdToken
 *
 * 安全性質：失敗時只記 HTTP 狀態，不記 channel secret、access token、ID token、LINE 回的本文。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    issueLoginChannelToken, listLiffApps, createLiffApp, deleteLiffApp, verifyIdToken, LineApiError,
} from '../../worker_src/lib/line_api.js';

const CHANNEL_ID = '1234567890';
const SECRET = 'a'.repeat(32);
const LOGIN_TOKEN = 'LOGIN-ACCESS-TOKEN-SECRET';
const ID_TOKEN = 'eyJ.ID-TOKEN-SECRET.sig';

let calls;
let handler;
let logs;
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

beforeEach(() => {
    calls = []; logs = [];
    handler = () => new Response('{}', { status: 200 });
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
        return handler(String(url), init);
    };
    const grab = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.error = grab; console.warn = grab; console.log = grab;
});
afterEach(() => { globalThis.fetch = originalFetch; Object.assign(console, originalLog); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('issueLoginChannelToken', () => {
    it('stateless：POST /oauth2/v3/token，form 帶 client_credentials、channel ID、secret', async () => {
        handler = () => json({ access_token: LOGIN_TOKEN, token_type: 'Bearer', expires_in: 900 });
        assert.equal(await issueLoginChannelToken(CHANNEL_ID, SECRET), LOGIN_TOKEN);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.line.me/oauth2/v3/token');
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(calls[0].body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_id'), CHANNEL_ID);
        assert.equal(form.get('client_secret'), SECRET);
    });

    it('stateless 被 4xx 拒絕 → 退回 short-lived（POST /v2/oauth/accessToken，同參數）', async () => {
        handler = (url) => (url.endsWith('/oauth2/v3/token') ? json({ error: 'x' }, 400) : json({ access_token: LOGIN_TOKEN, expires_in: 2592000 }));
        assert.equal(await issueLoginChannelToken(CHANNEL_ID, SECRET), LOGIN_TOKEN);
        assert.deepEqual(calls.map((c) => c.url), ['https://api.line.me/oauth2/v3/token', 'https://api.line.me/v2/oauth/accessToken']);
        assert.equal(new URLSearchParams(calls[1].body).get('client_secret'), SECRET);
    });

    it('兩個都被拒絕 → 丟 LineApiError（帶 status）；5xx 與網路錯誤不退回', async () => {
        handler = () => json({}, 401);
        await assert.rejects(() => issueLoginChannelToken(CHANNEL_ID, SECRET), (e) => e instanceof LineApiError && e.status === 401);
        assert.equal(calls.length, 2);
        calls = [];
        handler = () => json({}, 503);
        await assert.rejects(() => issueLoginChannelToken(CHANNEL_ID, SECRET), (e) => e instanceof LineApiError && e.status === 503);
        assert.equal(calls.length, 1);
        calls = [];
        handler = () => { throw new TypeError('fetch failed'); };
        await assert.rejects(() => issueLoginChannelToken(CHANNEL_ID, SECRET), (e) => e instanceof LineApiError && e.status === 0);
        assert.equal(calls.length, 1);
    });

    it('回應沒有 access_token → 丟錯（不回傳 undefined）', async () => {
        handler = () => json({ token_type: 'Bearer' });
        await assert.rejects(() => issueLoginChannelToken(CHANNEL_ID, SECRET), LineApiError);
    });

    it('log 不含 secret、token', async () => {
        handler = () => json({ error_description: SECRET }, 401);
        await assert.rejects(() => issueLoginChannelToken(CHANNEL_ID, SECRET));
        const dump = logs.join('\n');
        assert.ok(!dump.includes(SECRET));
        assert.ok(!dump.includes(LOGIN_TOKEN));
    });
});

describe('LIFF Server API', () => {
    it('listLiffApps：GET，帶 Bearer；404（沒有任何 LIFF）→ []', async () => {
        handler = () => json({ apps: [{ liffId: '1234567890-AbCdEfGh', view: { type: 'full', url: 'https://x.example.com/a' } }] });
        const apps = await listLiffApps(LOGIN_TOKEN);
        assert.equal(apps.length, 1);
        assert.equal(calls[0].url, 'https://api.line.me/liff/v1/apps');
        assert.equal(calls[0].headers.Authorization, `Bearer ${LOGIN_TOKEN}`);
        handler = () => json({ message: 'not found' }, 404);
        assert.deepEqual(await listLiffApps(LOGIN_TOKEN), []);
        handler = () => json({ nope: true });
        assert.deepEqual(await listLiffApps(LOGIN_TOKEN), []);
        handler = () => json({}, 401);
        await assert.rejects(() => listLiffApps(LOGIN_TOKEN), (e) => e.status === 401);
    });

    it('createLiffApp：POST，view.type full、view.url、只要 openid、名稱不含 LINE；回 liffId', async () => {
        handler = () => json({ liffId: '1234567890-AbCdEfGh' });
        const id = await createLiffApp(LOGIN_TOKEN, { endpointUrl: 'https://worker.example.com/bridge/identity/Ubot', description: 'Identity check' });
        assert.equal(id, '1234567890-AbCdEfGh');
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].url, 'https://api.line.me/liff/v1/apps');
        assert.equal(calls[0].headers.Authorization, `Bearer ${LOGIN_TOKEN}`);
        const body = JSON.parse(calls[0].body);
        assert.deepEqual(body.view, { type: 'full', url: 'https://worker.example.com/bridge/identity/Ubot' });
        assert.deepEqual(body.scope, ['openid']);
        assert.equal(body.permanentLinkPattern, 'concat');
        assert.doesNotMatch(body.description, /line/i);
        assert.equal(body.view.url.includes('#'), false);
    });

    it('createLiffApp：400（數量達上限等）→ LineApiError；沒有 liffId → 丟錯', async () => {
        handler = () => json({ message: 'limit' }, 400);
        await assert.rejects(() => createLiffApp(LOGIN_TOKEN, { endpointUrl: 'https://x.example.com/a', description: 'd' }), (e) => e.status === 400);
        handler = () => json({});
        await assert.rejects(() => createLiffApp(LOGIN_TOKEN, { endpointUrl: 'https://x.example.com/a', description: 'd' }), LineApiError);
    });

    it('deleteLiffApp：DELETE /liff/v1/apps/{id}（id 要編碼）；404 也算成功；其他錯誤丟出', async () => {
        await deleteLiffApp(LOGIN_TOKEN, '1234567890-AbCdEfGh');
        assert.equal(calls[0].method, 'DELETE');
        assert.equal(calls[0].url, 'https://api.line.me/liff/v1/apps/1234567890-AbCdEfGh');
        await deleteLiffApp(LOGIN_TOKEN, 'a/../b');
        assert.equal(calls[1].url, 'https://api.line.me/liff/v1/apps/a%2F..%2Fb');
        handler = () => json({}, 404);
        await deleteLiffApp(LOGIN_TOKEN, 'x');
        handler = () => json({}, 500);
        await assert.rejects(() => deleteLiffApp(LOGIN_TOKEN, 'x'), (e) => e.status === 500);
    });

    it('log 不含 Login token', async () => {
        handler = () => json({}, 401);
        await assert.rejects(() => listLiffApps(LOGIN_TOKEN));
        await assert.rejects(() => createLiffApp(LOGIN_TOKEN, { endpointUrl: 'https://x.example.com/a', description: 'd' }));
        assert.ok(!logs.join('\n').includes(LOGIN_TOKEN));
    });
});

describe('verifyIdToken', () => {
    const NOW = 1_800_000_000_000;
    const claims = (over = {}) => ({ iss: 'https://access.line.me', sub: 'Uuser0000000000000000000000000001', aud: CHANNEL_ID, exp: NOW / 1000 + 3600, iat: NOW / 1000, ...over });

    it('POST /oauth2/v2.1/verify，form 帶 id_token 與 client_id；成功回 sub', async () => {
        handler = () => json(claims());
        const r = await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW);
        assert.deepEqual(r, { ok: true, sub: 'Uuser0000000000000000000000000001' });
        assert.equal(calls[0].url, 'https://api.line.me/oauth2/v2.1/verify');
        assert.equal(calls[0].method, 'POST');
        const form = new URLSearchParams(calls[0].body);
        assert.equal(form.get('id_token'), ID_TOKEN);
        assert.equal(form.get('client_id'), CHANNEL_ID);
    });

    it('LINE 說不行（400）→ invalid', async () => {
        handler = () => json({ error: 'invalid_request', error_description: 'IdToken expired.' }, 400);
        assert.deepEqual(await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW), { ok: false, reason: 'invalid' });
    });

    it('LINE 回 200 但本地檢查不過（iss、aud、sub、exp）→ invalid（縱深防禦）', async () => {
        const bad = [
            { iss: 'https://evil.example.com' }, { aud: '999999999' }, { sub: '' }, { sub: undefined }, { sub: 'U'.repeat(200) },
            { exp: NOW / 1000 - 1 }, { exp: 'soon' }, { exp: undefined },
        ];
        for (const over of bad) {
            handler = () => json(claims(over));
            assert.deepEqual(await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW), { ok: false, reason: 'invalid' }, JSON.stringify(over));
        }
        handler = () => json('nope');
        assert.equal((await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW)).ok, false);
    });

    it('aud 是數字也算相符（LINE 回字串；測試兩種）', async () => {
        handler = () => json(claims({ aud: Number(CHANNEL_ID) }));
        assert.equal((await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW)).ok, true);
    });

    it('LINE 暫時不可用（5xx、429、網路）→ unavailable，可重試', async () => {
        for (const status of [500, 502, 503, 429]) {
            handler = () => json({}, status);
            assert.deepEqual(await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW), { ok: false, reason: 'unavailable' }, String(status));
        }
        handler = () => { throw new TypeError('fetch failed'); };
        assert.deepEqual(await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW), { ok: false, reason: 'unavailable' });
    });

    it('空的、非字串、過長的 token 不打 LINE', async () => {
        for (const t of ['', null, undefined, 5, 'x'.repeat(5000)]) {
            assert.deepEqual(await verifyIdToken(t, CHANNEL_ID, NOW), { ok: false, reason: 'invalid' });
        }
        assert.equal(calls.length, 0);
    });

    it('log 不含 ID token', async () => {
        handler = () => json({ error_description: ID_TOKEN }, 400);
        await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW);
        handler = () => { throw new TypeError(`fetch failed ${ID_TOKEN}`); };
        await verifyIdToken(ID_TOKEN, CHANNEL_ID, NOW);
        assert.ok(!logs.join('\n').includes(ID_TOKEN));
    });
});
