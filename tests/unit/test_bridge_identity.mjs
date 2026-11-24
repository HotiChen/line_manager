/**
 * Unit Tests — LM-4C LINE 身分換 ref（經 handleBridge，真 D1、記憶體 KV、假 LINE）
 *
 *   後台設定 → 公開頁 → verify → exchange → 產品 token；以及路由分類與缺 0007 遷移時的 fail-closed
 *
 * 安全性質（上線前安全審查的依據）：
 *   - 身分只來自 LINE 驗證成功的 ID token；資料庫、回應、稽核、log 都沒有 LINE userId、ID token、身分碼、secret 明文
 *   - 未驗證（Provider 不確定）不發碼；公開端點對所有「未啟用」情形回同一個回應
 *   - 身分碼 60 秒、單次、綁連結；導回網址只來自產品登記值
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedLink, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { openSecret } from '../../worker_src/lm_service.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import { isIdentityRoute, isBridgeServiceRoute, isLinkRoute } from '../../worker_src/bridge/routes.js';
import { requiresAuthentication } from '../../worker_src/middleware/auth_routes.js';
import * as bdb from '../../worker_src/bridge/db.js';

const ORIGIN = 'https://worker.example.com';
const ADMIN = 'test-admin-secret-not-real';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER_USER = 'Umember000000000000000000000002';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const CHANNEL_ID = '1234567890';
const CHANNEL_SECRET = 'b'.repeat(32);
const LIFF_ID = '1234567890-AbCdEfGh';
const ENDPOINT = `${ORIGIN}/bridge/identity/${BOT}`;
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const PRD = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const KEY = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const SCOPES = ['link:manage', 'contacts:bind', 'identity:read'];
const RETURN_URI = 'https://picker.example.com/lm/identity';
const CUSTOMER = 'Ucustomer00000000000000000000001'; // 這位客人在 OA 的 userId（與 Login channel 同 Provider → 相同）
const STRANGER = 'Ustranger00000000000000000000009';
const REF = 'customer-0001';

let d1;
let env;
let kv;
let lineCalls;
let lineFail; // { token?: status, list?: status, create?: status, verify?: status }
let liffApps;
let seen;
let logs;
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });

const NOW_S = () => Math.floor(Date.now() / 1000);
const claimsFor = (sub, over = {}) => ({ iss: 'https://access.line.me', sub, aud: CHANNEL_ID, exp: NOW_S() + 3600, iat: NOW_S(), ...over });

beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', BRIDGE_ADMIN_SECRET: ADMIN, AUTH_MODE: 'legacy', TOKEN_ENCRYPTION_KEY: ENC_KEY };
    seen = []; logs = []; lineCalls = []; lineFail = {}; liffApps = [];
    const grab = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.error = grab; console.warn = grab; console.log = grab;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const method = init.method || 'GET';
        if (!u.startsWith('https://api.line.me/')) throw new Error(`unexpected fetch ${u}`);
        lineCalls.push({ url: u, method, headers: init.headers || {}, body: init.body });
        const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
        if (u.endsWith('/oauth2/v3/token')) return lineFail.token ? reply({}, lineFail.token) : reply({ access_token: 'LOGIN_TOKEN_X', expires_in: 900 });
        if (u.endsWith('/v2/oauth/accessToken')) return lineFail.token ? reply({}, lineFail.token) : reply({ access_token: 'LOGIN_TOKEN_X' });
        if (u.endsWith('/liff/v1/apps') && method === 'GET') return lineFail.list ? reply({}, lineFail.list) : reply({ apps: liffApps });
        if (u.endsWith('/liff/v1/apps') && method === 'POST') {
            if (lineFail.create) return reply({}, lineFail.create);
            const body = JSON.parse(init.body);
            const id = liffApps.length === 0 ? LIFF_ID : `1234567890-New${liffApps.length}Abcd`;
            liffApps.push({ liffId: id, view: body.view });
            return reply({ liffId: id });
        }
        if (u.includes('/liff/v1/apps/') && method === 'DELETE') {
            const id = decodeURIComponent(u.split('/liff/v1/apps/')[1]);
            liffApps = liffApps.filter((a) => a.liffId !== id);
            return reply({});
        }
        if (u.endsWith('/oauth2/v2.1/verify')) {
            if (lineFail.verify) return reply({ error_description: 'x' }, lineFail.verify);
            const token = new URLSearchParams(init.body).get('id_token');
            if (token === 'tok:expired') return reply({ error_description: 'IdToken expired.' }, 400);
            if (token === 'tok:bad') return reply({ error_description: 'Invalid IdToken.' }, 400);
            if (token === 'tok:wrongaud') return reply(claimsFor(CUSTOMER, { aud: '999999999' }));
            if (token.startsWith('tok:')) return reply(claimsFor(token.slice(4)));
            return reply({ error_description: 'Invalid IdToken.' }, 400);
        }
        throw new Error(`unexpected LINE call ${method} ${u}`);
    };

    await kv.put(BotKeys.permissions(BOT), JSON.stringify({ users: [{ userId: OWNER, role: 'owner' }, { userId: MEMBER_USER, role: 'member' }] }));
    await kv.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }], currentBotId: BOT }));
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(BotKeys.member(BOT, CUSTOMER), JSON.stringify({ memberId: CUSTOMER, tags: [], botIds: [BOT] })); // webhook 建立的會員才有 botIds
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalLog);
});

async function call(method, path, { headers = {}, body, e = env, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = raw ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), e, url.pathname);
    const text = await res.text();
    seen.push(text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* html / 204 */ }
    return { res, text, body: parsed };
}
const errCode = (r) => r.body && r.body.error && r.body.error.code;
const asOwner = (m, p, body, user = OWNER) => call(m, p, { headers: { 'X-User-Id': user, 'X-Bot-Id': BOT }, body });
const saveChannel = (over = {}) => asOwner('PUT', '/bridge/v1/admin/identity', { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET, ...over });
const verifyAs = (sub) => call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT, id_token: `tok:${sub}` } });
const exchange = (over = {}, sub = CUSTOMER) => call('POST', '/bridge/v1/identity/exchange', { body: { bot_id: BOT, id_token: `tok:${sub}`, p: 'ip', to: '/photos?x=1', ...over } });
const redeem = (code, key = KEY) => call('POST', '/bridge/v1/identity/token', { headers: { Authorization: `Bearer ${key}` }, body: { code } });
const codeFrom = (r) => new URL(r.body.redirect_to).searchParams.get('code');

/** 設定好 channel、通過驗證、登記好產品與連結 */
async function ready({ verified = true } = {}) {
    assert.equal((await saveChannel()).res.status, 200);
    if (verified) assert.equal((await verifyAs(CUSTOMER)).res.status, 200);
    await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY, scopes: SCOPES });
    await d1.db.prepare("UPDATE products SET product_key = 'ip', identity_return_uris = ?2, scopes = ?3 WHERE product_id = ?1")
        .bind(PRD, JSON.stringify([RETURN_URI, 'https://picker.example.com/second']), JSON.stringify(SCOPES)).run();
}
const bindCustomer = (link = LNK, ref = REF, user = CUSTOMER) => d1.db.prepare(
    "INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'bound', 1, 1)"
).bind(link, ref, BOT, user).run();

// ───────────────────────── 後台設定 ─────────────────────────

describe('PUT /admin/identity：設定 LINE Login channel 與 LIFF', () => {
    it('加密存 secret、換 token、建立 LIFF（endpoint = 本 Worker + /bridge/identity/{botId}）；回狀態但不回 secret', async () => {
        const r = await saveChannel();
        assert.equal(r.res.status, 200, r.text);
        assert.deepEqual(r.body, {
            configured: true, channel_id: CHANNEL_ID, liff_id: LIFF_ID, liff_url: `https://liff.line.me/${LIFF_ID}`,
            endpoint_url: ENDPOINT, verify_url: `https://liff.line.me/${LIFF_ID}?verify=1`, verified: false, verified_at: null,
        });
        const create = lineCalls.find((c) => c.method === 'POST' && c.url.endsWith('/liff/v1/apps'));
        assert.equal(JSON.parse(create.body).view.url, ENDPOINT);
        assert.equal(create.headers.Authorization, 'Bearer LOGIN_TOKEN_X');
        const token = lineCalls.find((c) => c.url.endsWith('/oauth2/v3/token'));
        assert.equal(new URLSearchParams(token.body).get('client_secret'), CHANNEL_SECRET);

        const row = await d1.db.prepare('SELECT secret_enc FROM identity_channels WHERE bot_id = ?1').bind(BOT).first();
        assert.match(row.secret_enc, /^enc\.v1\./);
        assert.ok(!row.secret_enc.includes(CHANNEL_SECRET));
        assert.equal(await openSecret(env, row.secret_enc), CHANNEL_SECRET);
        assert.ok(!seen.join('\n').includes(CHANNEL_SECRET));
    });

    it('冪等：同一個 endpoint 已有 LIFF 就沿用，不再建立第二個', async () => {
        await saveChannel();
        const creates = () => lineCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/liff/v1/apps')).length;
        assert.equal(creates(), 1);
        const again = await saveChannel();
        assert.equal(again.body.liff_id, LIFF_ID);
        assert.equal(creates(), 1);
        assert.equal(liffApps.length, 1);
    });

    it('只換 secret（channel 與 LIFF 沒變）→ 保留驗證狀態；換 channel → 驗證歸零、舊 channel 上的 LIFF 盡力刪除', async () => {
        await saveChannel();
        await verifyAs(CUSTOMER);
        assert.equal((await saveChannel({ channel_secret: 'c'.repeat(32) })).body.verified, true);
        const swapped = await saveChannel({ channel_id: '9876543210' });
        assert.equal(swapped.res.status, 200);
        assert.equal(swapped.body.verified, false);
        assert.equal(swapped.body.channel_id, '9876543210');
    });

    it('格式不合 → 400；缺 TOKEN_ENCRYPTION_KEY → 503（不降級、不呼叫 LINE）', async () => {
        for (const over of [{ channel_id: 'abc' }, { channel_id: '12' }, { channel_id: undefined }, { channel_secret: 'short' }, { channel_secret: 'z'.repeat(32) }, { channel_secret: undefined }]) {
            assert.equal((await saveChannel(over)).res.status, 400, JSON.stringify(over));
        }
        assert.equal(lineCalls.length, 0);
        const r = await call('PUT', '/bridge/v1/admin/identity', {
            headers: { 'X-User-Id': OWNER, 'X-Bot-Id': BOT }, body: { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET }, e: { ...env, TOKEN_ENCRYPTION_KEY: undefined },
        });
        assert.equal(r.res.status, 503);
        assert.equal(lineCalls.length, 0);
        assert.equal(await count(d1.db, 'identity_channels'), 0);
    });

    it('LINE 拒絕（401／400／403）→ 400 可行動訊息（不回顯 LINE 內容與 secret）；LINE 掛了 → 502 retryable；不寫入', async () => {
        for (const status of [400, 401, 403]) {
            lineFail = { token: status };
            const r = await saveChannel();
            assert.equal(r.res.status, 400, String(status));
            assert.equal(errCode(r), 'INVALID_REQUEST');
            assert.ok(!r.text.includes(CHANNEL_SECRET));
        }
        lineFail = { create: 400 };
        assert.equal((await saveChannel()).res.status, 400, 'LIFF 數量達上限');
        lineFail = { token: 503 };
        const down = await saveChannel();
        assert.equal(down.res.status, 502);
        assert.equal(down.body.error.retryable, true);
        assert.equal(await count(d1.db, 'identity_channels'), 0);
        assert.ok(!logs.join('\n').includes(CHANNEL_SECRET));
    });

    it('GET 狀態（不含 secret）；DELETE 刪除 LIFF 與設定，冪等', async () => {
        assert.deepEqual((await asOwner('GET', '/bridge/v1/admin/identity')).body, { configured: false, verified: false });
        await saveChannel();
        const got = await asOwner('GET', '/bridge/v1/admin/identity');
        assert.equal(got.body.configured, true);
        assert.ok(!got.text.includes(CHANNEL_SECRET) && !got.text.includes('enc.v1'));
        assert.equal((await asOwner('DELETE', '/bridge/v1/admin/identity')).res.status, 204);
        assert.equal(liffApps.length, 0);
        assert.equal(await count(d1.db, 'identity_channels'), 0);
        assert.equal((await asOwner('DELETE', '/bridge/v1/admin/identity')).res.status, 204);
    });

    it('只有這個 OA 的 owner：member、別人、沒有 LIFF 身分都擋下，且不呼叫 LINE', async () => {
        assert.equal((await saveChannel.call(null)).res.status, 200);
        lineCalls = [];
        const asMember = await asOwner('PUT', '/bridge/v1/admin/identity', { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET }, MEMBER_USER);
        assert.ok([403, 404].includes(asMember.res.status));
        const anon = await call('PUT', '/bridge/v1/admin/identity', { headers: { 'X-Bot-Id': BOT }, body: { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET } });
        assert.ok([401, 403].includes(anon.res.status));
        assert.equal(lineCalls.length, 0);
    });

    it('稽核 identity_channel_set 不含 secret 與 channel ID', async () => {
        await saveChannel();
        const rows = JSON.stringify(await all(d1.db, "SELECT * FROM audit_log WHERE action = 'identity_channel_set'"));
        assert.ok(rows.includes('identity_channel_set'));
        for (const s of [CHANNEL_SECRET, CHANNEL_ID, LIFF_ID]) assert.ok(!rows.includes(s), s);
    });
});

// ───────────────────────── 公開頁 ─────────────────────────

describe('GET /bridge/identity/{botId}', () => {
    it('沒設定 → 404（一般的 not found，不洩漏）；設定後 → HTML，只內嵌 liffId、botId，附安全標頭', async () => {
        assert.equal((await call('GET', `/bridge/identity/${BOT}`)).res.status, 404);
        await saveChannel();
        const r = await call('GET', `/bridge/identity/${BOT}`);
        assert.equal(r.res.status, 200);
        assert.match(r.res.headers.get('content-type'), /text\/html/);
        assert.equal(r.res.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(r.res.headers.get('cache-control'), 'no-store');
        assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
        const csp = r.res.headers.get('content-security-policy');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /script-src 'self' https:\/\/static\.line-scdn\.net/);
        assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline.*script/);
        assert.ok(r.text.includes(`<meta name="liff-id" content="${LIFF_ID}">`));
        assert.ok(r.text.includes(`<meta name="bot-id" content="${BOT}">`));
        assert.ok(r.text.includes('/js/identity_liff.js'));
        assert.ok(!/<script>[^<]/.test(r.text), '頁面不可有 inline script');
        for (const s of [CHANNEL_SECRET, 'enc.v1']) assert.ok(!r.text.includes(s));
    });

    it('botId 格式不合、查詢字串、非 GET → 一律 404，且不回顯任何輸入', async () => {
        await saveChannel();
        for (const id of ['x"><script>alert(1)</script>', '..%2f..', 'a b', 'U'.repeat(80)]) {
            const r = await call('GET', `/bridge/identity/${encodeURIComponent(id)}`);
            assert.equal(r.res.status, 404, id);
            assert.ok(!r.text.includes('script'));
        }
        const withQuery = await call('GET', `/bridge/identity/${BOT}?p=<script>x</script>`);
        assert.equal(withQuery.res.status, 200);
        assert.ok(!withQuery.text.includes('<script>x'));
        assert.equal((await call('POST', `/bridge/identity/${BOT}`)).res.status, 404);
    });

    it('掛載前綴會帶進 script 與 api-base', async () => {
        await saveChannel();
        const mounted = { ...env, MOUNT_PATH: '/lm' };
        const r = await call('GET', `/bridge/identity/${BOT}`, { e: mounted });
        assert.ok(r.text.includes('src="/lm/js/identity_liff.js"'));
        assert.ok(r.text.includes(`name="api-base" content="${ORIGIN}/lm"`));
    });
});

// ───────────────────────── verify ─────────────────────────

describe('POST /bridge/v1/identity/verify（確認 Login channel 與 OA 同一個 Provider）', () => {
    it('這個 sub 是 OA 的會員 → 200，記錄 verified_at', async () => {
        await saveChannel();
        const r = await verifyAs(CUSTOMER);
        assert.equal(r.res.status, 200, r.text);
        assert.deepEqual(r.body, { verified: true });
        assert.equal((await asOwner('GET', '/bridge/v1/admin/identity')).body.verified, true);
        const verifyCall = lineCalls.find((c) => c.url.endsWith('/oauth2/v2.1/verify'));
        assert.equal(new URLSearchParams(verifyCall.body).get('client_id'), CHANNEL_ID);
    });

    it('名單污染：手動寫入同名會員（沒有 botIds）不能讓驗證通過；webhook 建立的才算', async () => {
        await saveChannel();
        // 低權限成員用 /member/save 寫進一筆「外部 Provider 的 sub」當會員 → 沒有 botIds
        await kv.put(BotKeys.member(BOT, STRANGER), JSON.stringify({ memberId: STRANGER, source: 'webhook', tags: [] }));
        const poisoned = await verifyAs(STRANGER);
        assert.equal(poisoned.res.status, 400);
        assert.equal((await asOwner('GET', '/bridge/v1/admin/identity')).body.verified, false);
        await kv.put(BotKeys.member(BOT, STRANGER), JSON.stringify({ memberId: STRANGER, botIds: [BOT2] }));
        assert.equal((await verifyAs(STRANGER)).res.status, 400, '別的 OA 的 botIds 不算');
    });

    it('不是會員（可能是不同 Provider）→ 400 說明怎麼處理，不記錄驗證', async () => {
        await saveChannel();
        const r = await verifyAs(STRANGER);
        assert.equal(r.res.status, 400);
        assert.equal(errCode(r), 'INVALID_REQUEST');
        assert.match(r.body.error.message, /Provider/);
        assert.equal((await asOwner('GET', '/bridge/v1/admin/identity')).body.verified, false);
    });

    it('ID token 無效／過期／aud 不符 → 404（與「未設定」同一個回應，不洩漏這個 OA 有設定）；LINE 暫時掛了 → 502', async () => {
        const unconfigured = await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT, id_token: 'tok:bad' } });
        await saveChannel();
        for (const t of ['tok:bad', 'tok:expired', 'tok:wrongaud', 'garbage']) {
            const r = await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT, id_token: t } });
            assert.equal(r.res.status, 404, t);
            assert.equal(r.text, unconfigured.text, '已設定與未設定的回應必須相同');
        }
        lineFail = { verify: 503 };
        assert.equal((await verifyAs(CUSTOMER)).res.status, 502);
    });

    it('沒設定的 OA、格式不合的 bot_id → 同一個「未啟用」回應；缺欄位 → 400', async () => {
        const a = await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT, id_token: 'tok:x' } });
        const b = await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: 'nope', id_token: 'tok:x' } });
        const c = await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT2, id_token: 'tok:x' } });
        for (const r of [a, b, c]) {
            assert.equal(r.res.status, 404);
            assert.equal(r.text, a.text);
        }
        await saveChannel();
        assert.equal((await call('POST', '/bridge/v1/identity/verify', { body: { bot_id: BOT } })).res.status, 400);
        assert.equal((await call('POST', '/bridge/v1/identity/verify', { body: 'not json', raw: true })).res.status, 400);
        assert.equal((await call('GET', '/bridge/v1/identity/verify')).res.status, 404);
    });
});

// ───────────────────────── exchange ─────────────────────────

describe('POST /bridge/v1/identity/exchange', () => {
    it('成功：回產品登記的第一個導回網址 + code + to；碼只存雜湊；已綁定時碼對應 ref', async () => {
        await ready();
        await bindCustomer();
        const r = await exchange();
        assert.equal(r.res.status, 200, r.text);
        assert.equal(r.res.headers.get('cache-control'), 'no-store');
        const url = new URL(r.body.redirect_to);
        assert.equal(`${url.origin}${url.pathname}`, RETURN_URI);
        assert.match(url.searchParams.get('code'), /^lmi_[A-Za-z0-9_-]{43}$/);
        assert.equal(url.searchParams.get('to'), '/photos?x=1');
        const code = url.searchParams.get('code');
        const rows = await all(d1.db, 'SELECT * FROM identity_codes');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].code_hash, await sha256Hex(code));
        assert.equal(rows[0].ref, REF);
        assert.equal(rows[0].link_id, LNK);
        assert.equal(rows[0].expires_at - rows[0].created_at, 60_000);
        assert.ok(!JSON.stringify(rows).includes(code));
    });

    it('沒有 to → 不帶 to；未綁定 → 碼存的 ref 是 NULL', async () => {
        await ready();
        const r = await exchange({ to: undefined });
        assert.equal(r.res.status, 200);
        assert.equal(new URL(r.body.redirect_to).searchParams.has('to'), false);
        assert.equal((await all(d1.db, 'SELECT ref FROM identity_codes'))[0].ref, null);
    });

    it('導回網址只來自登記值：請求裡的 redirect_uri／redirect_to／return_to 一律忽略', async () => {
        await ready();
        const r = await exchange({ redirect_uri: 'https://evil.example.com/x', redirect_to: 'https://evil.example.com/y', return_to: 'https://evil.example.com/z' });
        assert.equal(r.res.status, 200);
        assert.ok(r.body.redirect_to.startsWith(RETURN_URI));
        assert.ok(!r.text.includes('evil'));
    });

    it('s（產品自己的 state）原樣帶回成 state=…；不合規定 → 400（不發碼）', async () => {
        await ready();
        const ok = await exchange({ s: 'abc_DEF-123' });
        assert.equal(new URL(ok.body.redirect_to).searchParams.get('state'), 'abc_DEF-123');
        assert.equal(new URL((await exchange({ s: undefined })).body.redirect_to).searchParams.has('state'), false);
        const before = await count(d1.db, 'identity_codes');
        for (const s of ['a b', '<x>', 'x'.repeat(129), '', 5, {}]) assert.equal((await exchange({ s })).res.status, 400, JSON.stringify(s));
        assert.equal(await count(d1.db, 'identity_codes'), before);
    });

    it('to 不合規定 → 400（不發碼）', async () => {
        await ready();
        for (const to of ['https://evil.example.com/', '//evil.example.com', 'photos', '/a b', '/<script>', `/${'a'.repeat(250)}`, 5, {}]) {
            const r = await exchange({ to });
            assert.equal(r.res.status, 400, JSON.stringify(to));
        }
        assert.equal(await count(d1.db, 'identity_codes'), 0);
    });

    it('還沒通過驗證 → 不發碼（回「未啟用」）', async () => {
        await ready({ verified: false });
        const r = await exchange();
        assert.equal(r.res.status, 404);
        assert.equal(await count(d1.db, 'identity_codes'), 0);
    });

    it('各種「未啟用」條件回完全相同的回應：product_key 不符、連結撤銷、產品停用、連結缺 identity:read、產品沒有導回網址、沒有 p', async () => {
        await ready();
        const baseline = await exchange({ p: 'zz' });
        assert.equal(baseline.res.status, 404);
        const mutate = [
            () => d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK).run(),
            () => d1.db.prepare('UPDATE products SET disabled = 1 WHERE product_id = ?1').bind(PRD).run(),
            () => d1.db.prepare('UPDATE links SET scopes = ?2 WHERE link_id = ?1').bind(LNK, JSON.stringify(['contacts:bind'])).run(),
            () => d1.db.prepare('UPDATE products SET identity_return_uris = NULL WHERE product_id = ?1').bind(PRD).run(),
            () => d1.db.prepare("UPDATE products SET identity_return_uris = '[]' WHERE product_id = ?1").bind(PRD).run(),
        ];
        for (const m of mutate) {
            await d1.db.prepare("UPDATE links SET status = 'active', scopes = ?2 WHERE link_id = ?1").bind(LNK, JSON.stringify(SCOPES)).run();
            await d1.db.prepare('UPDATE products SET disabled = 0, identity_return_uris = ?2 WHERE product_id = ?1').bind(PRD, JSON.stringify([RETURN_URI])).run();
            await m();
            const r = await exchange();
            assert.equal(r.res.status, 404);
            assert.equal(r.text, baseline.text);
        }
        assert.equal((await exchange({ p: undefined })).res.status, 404);
        assert.equal((await exchange({ p: 'IP!' })).res.status, 404);
        assert.equal(await count(d1.db, 'identity_codes'), 0);
    });

    it('ID token 無效／過期／aud 不符 → 404（不發碼，與未啟用同一個回應）；LINE 暫時掛了 → 502', async () => {
        await ready();
        const baseline = await exchange({ p: 'zz' });
        for (const t of ['tok:bad', 'tok:expired', 'tok:wrongaud']) {
            const r = await call('POST', '/bridge/v1/identity/exchange', { body: { bot_id: BOT, id_token: t, p: 'ip' } });
            assert.equal(r.res.status, 404, t);
            assert.equal(r.text, baseline.text);
        }
        lineFail = { verify: 500 };
        assert.equal((await exchange()).res.status, 502);
        assert.equal(await count(d1.db, 'identity_codes'), 0);
    });

    it('每 bot 的桶只在 ID token 驗證成功後才計：垃圾請求擠不掉正常客人；限流計數在 D1（原子）', async () => {
        await ready(); // 內含一次成功的 verify，會先計一格
        const botCount = async () => (await all(d1.db, "SELECT n FROM counters WHERE scope_key LIKE 'idpub:bot:%'")).reduce((sum, r) => sum + r.n, 0);
        const baseline = await botCount();
        for (let i = 0; i < 5; i++) {
            await call('POST', '/bridge/v1/identity/exchange', { headers: { 'CF-Connecting-IP': `203.0.113.${i + 1}` }, body: { bot_id: BOT, id_token: 'tok:bad', p: 'ip' } });
        }
        assert.equal(await botCount(), baseline, '垃圾請求不該計入每 bot 的桶');
        assert.equal((await exchange()).res.status, 200);
        assert.equal(await botCount(), baseline + 1);
        const ipRows = await all(d1.db, "SELECT scope_key FROM counters WHERE scope_key LIKE 'idpub:ip:%'");
        assert.ok(ipRows.length >= 5);
        assert.ok(ipRows.every((r) => !r.scope_key.includes('203.0.113')), 'IP 只以雜湊進計數鍵');
    });

    it('並發：同時送出遠超過上限的請求，放行數不超過上限（D1 原子計數）', async () => {
        await ready();
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            const results = await Promise.all(Array.from({ length: 45 }, () =>
                call('POST', '/bridge/v1/identity/exchange', { body: { bot_id: BOT, id_token: 'tok:bad', p: 'ip' } })));
            const limited = results.filter((r) => r.res.status === 429).length;
            assert.ok(results.length - limited <= 30, `放行 ${results.length - limited} 次，超過每 IP 每分鐘 30 次的上限`);
            assert.ok(limited >= 15);
        } finally {
            Date.now = realNow;
        }
    });

    it('限流：每 IP 每分鐘 30 次，超過 → 429 + Retry-After', async () => {
        await ready();
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            let last;
            for (let i = 0; i < 31; i++) last = await call('POST', '/bridge/v1/identity/exchange', { body: { bot_id: BOT, id_token: 'tok:bad', p: 'ip' } });
            assert.equal(last.res.status, 429);
            assert.ok(last.res.headers.get('retry-after'));
        } finally {
            Date.now = realNow;
        }
    });
});

// ───────────────────────── 產品兌換 ─────────────────────────

describe('POST /bridge/v1/identity/token', () => {
    it('已綁定 → 200 {link_id, contact:{external_contact_ref, status}}；未綁定 → contact null；no-store', async () => {
        await ready();
        await bindCustomer();
        const r = await redeem(codeFrom(await exchange()));
        assert.equal(r.res.status, 200, r.text);
        assert.equal(r.res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(r.body, { link_id: LNK, contact: { external_contact_ref: REF, status: 'bound' } });
        await d1.db.prepare('DELETE FROM contacts').run();
        const none = await redeem(codeFrom(await exchange()));
        assert.deepEqual(none.body, { link_id: LNK, contact: null });
    });

    it('單次：第二次兌換 → 400 INVALID_CODE；並行兌換恰好一個成功', async () => {
        await ready();
        const code = codeFrom(await exchange());
        const results = await Promise.all([redeem(code), redeem(code), redeem(code)]);
        assert.equal(results.filter((x) => x.res.status === 200).length, 1);
        for (const r of results.filter((x) => x.res.status !== 200)) {
            assert.equal(r.res.status, 400);
            assert.equal(errCode(r), 'INVALID_CODE');
        }
    });

    it('過期（60 秒）→ INVALID_CODE', async () => {
        await ready();
        const code = codeFrom(await exchange());
        await d1.db.prepare('UPDATE identity_codes SET expires_at = ?1').bind(Date.now() - 1).run();
        assert.equal(errCode(await redeem(code)), 'INVALID_CODE');
    });

    it('必須用發碼那條連結的金鑰：別條連結的金鑰 → INVALID_CODE，而且不消耗這個碼', async () => {
        await ready();
        await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT2, key: KEY_B, scopes: SCOPES });
        const code = codeFrom(await exchange());
        const wrong = await redeem(code, KEY_B);
        assert.equal(wrong.res.status, 400);
        assert.equal(errCode(wrong), 'INVALID_CODE');
        assert.equal((await redeem(code)).res.status, 200, '正確的連結仍可兌換');
    });

    it('格式不合、亂碼、不存在 → INVALID_CODE（同一種回應）', async () => {
        await ready();
        const bad = ['', 'lmi_short', `lmi_${'A'.repeat(43)}`, `lmc_${'A'.repeat(43)}`, 'x'.repeat(500), 5, null];
        const texts = new Set();
        for (const code of bad) {
            const r = await redeem(code);
            assert.equal(r.res.status, 400, String(code));
            assert.equal(errCode(r), 'INVALID_CODE');
            texts.add(r.text);
        }
        assert.equal(texts.size, 1);
        assert.equal((await call('POST', '/bridge/v1/identity/token', { headers: { Authorization: `Bearer ${KEY}` }, body: 'nope', raw: true })).res.status, 400);
    });

    it('認證：沒金鑰／亂金鑰 → 401；沒有 identity:read → 403 SCOPE_DENIED；連結撤銷 → 403 LINK_REVOKED；GET → 404', async () => {
        await ready();
        const code = codeFrom(await exchange());
        assert.equal((await call('POST', '/bridge/v1/identity/token', { body: { code } })).res.status, 401);
        assert.equal((await redeem(code, 'brk_nope')).res.status, 401);
        await d1.db.prepare('UPDATE service_keys SET scopes = ?2 WHERE link_id = ?1').bind(LNK, JSON.stringify(['contacts:bind'])).run();
        await d1.db.prepare('UPDATE links SET scopes = ?2 WHERE link_id = ?1').bind(LNK, JSON.stringify(['contacts:bind'])).run();
        assert.equal(errCode(await redeem(code)), 'SCOPE_DENIED');
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK).run();
        assert.equal(errCode(await redeem(code)), 'LINK_REVOKED');
        assert.equal((await call('GET', '/bridge/v1/identity/token', { headers: { Authorization: `Bearer ${KEY}` } })).res.status, 404);
    });

    it('發碼後連結被撤銷或產品被停用 → 碼失效（資料層就擋下）', async () => {
        await ready();
        const code = codeFrom(await exchange());
        await d1.db.prepare('UPDATE products SET disabled = 1 WHERE product_id = ?1').bind(PRD).run();
        assert.equal(await bdb.consumeIdentityCode(env, { codeHash: await sha256Hex(code), linkId: LNK }), null);
    });

    it('限流：每連結每分鐘 60 次', async () => {
        await ready();
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            let last;
            for (let i = 0; i < 61; i++) last = await redeem(`lmi_${'A'.repeat(43)}`);
            assert.equal(last.res.status, 429);
            assert.equal(errCode(last), 'RATE_LIMITED');
        } finally {
            Date.now = realNow;
        }
    });
});

// ───────────────────────── 個資與稽核 ─────────────────────────

describe('LINE userId、ID token、身分碼、secret 不外流', () => {
    it('整個流程之後：所有回應、稽核、log、資料庫（除了 contacts 與會員）都沒有 userId、ID token、碼、secret 明文', async () => {
        await ready();
        await bindCustomer();
        const code = codeFrom(await exchange());
        await redeem(code);
        await exchange({}, STRANGER); // 另一位使用者：ID token 有效，但沒有綁定
        const stored = [
            logs.join('\n'),
            JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log')),
            JSON.stringify(await all(d1.db, 'SELECT * FROM identity_codes')),
            JSON.stringify(await all(d1.db, 'SELECT bot_id, channel_id, liff_id, liff_url, verified_at FROM identity_channels')),
        ].join('\n');
        // 碼本身只會出現在發給使用者的導回網址與產品的兌換請求裡；log、稽核、資料庫都不能有明文
        assert.ok(!stored.includes(code), '身分碼明文進了 log／稽核／資料庫');
        const responses = seen.join('\n');
        for (const s of [CUSTOMER, STRANGER, 'tok:', CHANNEL_SECRET, 'LOGIN_TOKEN_X']) {
            assert.ok(!stored.includes(s), `stored: ${s}`);
            assert.ok(!responses.includes(s), `responses: ${s}`);
        }
        // 資料庫裡 secret 只有密文
        const row = await d1.db.prepare('SELECT secret_enc FROM identity_channels').first();
        assert.ok(!row.secret_enc.includes(CHANNEL_SECRET));
    });

    it('稽核 identity_issued／identity_redeemed／identity_verified 只有 product_id、link_id、has_contact', async () => {
        await ready();
        await bindCustomer();
        await redeem(codeFrom(await exchange()));
        const rows = await all(d1.db, "SELECT action, detail FROM audit_log WHERE action LIKE 'identity_%' ORDER BY id");
        assert.deepEqual(rows.map((r) => r.action), ['identity_channel_set', 'identity_verified', 'identity_issued', 'identity_redeemed']);
        assert.deepEqual(JSON.parse(rows[2].detail), { product_id: PRD, link_id: LNK, has_contact: true });
        assert.deepEqual(JSON.parse(rows[3].detail), { product_id: PRD, link_id: LNK, has_contact: true });
    });
});

// ───────────────────────── 產品登記 ─────────────────────────

describe('產品登記：identity:read 與 identity_return_uris', () => {
    const admin = (m, p, body) => call(m, p, { headers: { Authorization: `Bearer ${ADMIN}` }, body });
    const base = { name: 'Image Picker', redirect_uris: ['https://picker.example.com/cb'], url_domains: ['picker.example.com'] };
    const register = (over = {}) => admin('POST', '/bridge/v1/admin/products', { ...base, scopes: ['contacts:bind', 'identity:read'], product_key: 'ip', identity_return_uris: [RETURN_URI], ...over });

    it('identity:read + product_key + identity_return_uris → 201，回傳登記值', async () => {
        const r = await register();
        assert.equal(r.res.status, 201, r.text);
        assert.deepEqual(r.body.identity_return_uris, [RETURN_URI]);
    });

    it('缺 product_key、缺或壞的 identity_return_uris、沒有 identity:read 卻給 uris → 400，不建立', async () => {
        const cases = [
            { product_key: undefined }, { identity_return_uris: undefined }, { identity_return_uris: [] }, { identity_return_uris: 'x' },
            { identity_return_uris: ['http://picker.example.com/x'] }, { identity_return_uris: ['https://picker.example.com/x#f'] },
            { identity_return_uris: ['https://picker.example.com/x?code=1'] }, { identity_return_uris: Array.from({ length: 11 }, (_, i) => `https://picker.example.com/${i}`) },
            { scopes: ['contacts:bind'] },
        ];
        for (const over of cases) assert.equal((await register(over)).res.status, 400, JSON.stringify(over));
        assert.equal(await count(d1.db, 'products'), 0);
    });

    it('PATCH 補登 identity_return_uris 與 identity:read（只增不減）', async () => {
        const reg = await register({ scopes: ['contacts:bind'], product_key: 'ip', identity_return_uris: undefined });
        const id = reg.body.product_id;
        const patch = (b) => admin('PATCH', `/bridge/v1/admin/products/${id}`, b);
        assert.equal((await patch({ scopes: ['contacts:bind', 'identity:read'] })).res.status, 400, '缺導回網址');
        assert.equal((await patch({ identity_return_uris: [RETURN_URI] })).res.status, 400, '沒有 identity:read');
        const ok = await patch({ scopes: ['contacts:bind', 'identity:read'], identity_return_uris: [RETURN_URI] });
        assert.equal(ok.res.status, 200, ok.text);
        assert.deepEqual(ok.body.identity_return_uris, [RETURN_URI]);
        assert.equal((await patch({ scopes: ['contacts:bind'] })).res.status, 400);
        const changed = await patch({ identity_return_uris: ['https://picker.example.com/new'] });
        assert.deepEqual(changed.body.identity_return_uris, ['https://picker.example.com/new']);
    });
});

// ───────────────────────── 路由與 fail-closed ─────────────────────────

describe('路由分類與公開路徑', () => {
    it('isIdentityRoute 精確比對；不是 service key 路由', () => {
        for (const p of [`/bridge/identity/${BOT}`, '/bridge/v1/identity/verify', '/bridge/v1/identity/exchange', '/bridge/v1/identity/token', '/bridge/v1/admin/identity']) {
            assert.equal(isIdentityRoute(p), true, p);
            assert.equal(isBridgeServiceRoute(p), false, p);
        }
        for (const p of ['/bridge/identity', '/bridge/identity/', '/bridge/v1/identity', '/bridge/v1/identity/other', '/bridge/v1/identityX/token', '/bridge/v1/admin/identity/x', '/bridge/v1/admin/identityX']) {
            assert.equal(isIdentityRoute(p), false, p);
        }
        assert.equal(isLinkRoute('/bridge/v1/admin/identity'), true, '其他 /admin 子路徑的分類不變');
    });

    it('公開的只有頁面與 verify／exchange；token、後台設定、其餘 /bridge 仍受保護', () => {
        assert.equal(requiresAuthentication(`/bridge/identity/${BOT}`), false);
        assert.equal(requiresAuthentication('/bridge/v1/identity/verify'), false);
        assert.equal(requiresAuthentication('/bridge/v1/identity/exchange'), false);
        for (const p of ['/bridge/v1/identity/token', '/bridge/v1/admin/identity', '/bridge/identity', '/bridge/v1/messages', '/bridge/v1/systems']) {
            assert.equal(requiresAuthentication(p), true, p);
        }
    });

    it('旗標關閉 → 全部 404，不碰 D1、LINE', async () => {
        const off = { ...env, BRIDGE_ENABLED: undefined };
        for (const [m, p] of [['GET', `/bridge/identity/${BOT}`], ['POST', '/bridge/v1/identity/verify'], ['POST', '/bridge/v1/identity/exchange'], ['POST', '/bridge/v1/identity/token']]) {
            assert.equal((await call(m, p, { e: off, body: m === 'POST' ? {} : undefined })).res.status, 404);
        }
        assert.equal(lineCalls.length, 0);
    });
});

describe('缺 0007 遷移 → fail-closed', () => {
    it('公開端點回「未啟用」、產品 token 與後台回 503，不放行、不丟 500', async () => {
        const old = await createTestD1({ upTo: '0006' });
        try {
            await seedLink(old.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY, scopes: SCOPES });
            const e = { ...env, BRIDGE_DB: old.db };
            assert.equal((await call('GET', `/bridge/identity/${BOT}`, { e })).res.status, 404);
            assert.equal((await call('POST', '/bridge/v1/identity/verify', { e, body: { bot_id: BOT, id_token: 'tok:x' } })).res.status, 404);
            assert.equal((await call('POST', '/bridge/v1/identity/exchange', { e, body: { bot_id: BOT, id_token: 'tok:x', p: 'ip' } })).res.status, 404);
            const token = await call('POST', '/bridge/v1/identity/token', { e, headers: { Authorization: `Bearer ${KEY}` }, body: { code: `lmi_${'A'.repeat(43)}` } });
            assert.equal(token.res.status, 503);
            const admin = await call('PUT', '/bridge/v1/admin/identity', { e, headers: { 'X-User-Id': OWNER, 'X-Bot-Id': BOT }, body: { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET } });
            assert.ok([503, 502].includes(admin.res.status), String(admin.res.status));
        } finally {
            await old.dispose();
        }
    });
});
