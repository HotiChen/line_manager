/**
 * Unit Tests — bridge/links.js（LM-2A 連結流程，端到端經 handleBridge）
 *
 * 流程：營運者登記產品 → 瀏覽器 authorize（302 到同意頁）→ 人 preview／approve（取得授權碼）
 *       → 產品用產品密鑰＋授權碼＋redirect_uri 換連結與金鑰 → 連結金鑰管理自己這條連結。
 *
 * 安全性質：redirect_uri 精確比對且絕不導向未驗證位址；授權碼單次、並行只有一個成功；過期／已用／不存在／
 * redirect_uri 不符同一個 INVALID_CODE；產品密鑰錯與產品不存在同一個 INVALID_KEY；跨連結一律 NOT_FOUND；
 * 連結金鑰通不過 /raw/* 與 /systems*，系統金鑰通不過連結端點；連結流程永遠不發 raw:push／messages:push；
 * 回應與 audit_log 不含授權碼、金鑰、雜湊、產品密鑰；缺 BRIDGE_DB → 503；BRIDGE_ENABLED 關閉 → 404。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withPinnedWindow } from '../helpers/pin_time.mjs';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedSystem, seedKey, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import { authenticateBridge } from '../../worker_src/bridge/auth.js';
import { isLinkRoute, isBridgeServiceRoute } from '../../worker_src/bridge/routes.js';
import { mountPrefix } from '../../worker_src/bridge/links.js';
import { LINK_SCOPES, FORBIDDEN_LINK_SCOPES } from '../../worker_src/bridge/scopes.js';

const ORIGIN = 'https://worker.example.com';
const ADMIN = 'test-admin-secret-not-real';
const OWNER = 'Uowner0000000000000000000000001';
const OWNER2 = 'Uowner0000000000000000000000003';
const MEMBER = 'Umember000000000000000000000002';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const URI = 'https://picker.example.com/cb';
const STATE = 'st-123';
const ALL_SCOPES = ['link:manage', 'contacts:bind', 'messages:send'];
const NOT_FOUND_LEGACY = { success: false, error: 'Not Found' };

let d1;
let env;
let kv;
let seen; // 本測試中所有回應的文字，用來掃描敏感值
const originalError = console.error;
const originalFetch = globalThis.fetch;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', BRIDGE_ADMIN_SECRET: ADMIN, AUTH_MODE: 'legacy', MOUNT_PATH: '/lm' };
    seen = [];
    console.error = () => {};
    await seedBot(BOT, OWNER, 'Shop A');
    await seedBot(BOT2, OWNER2, 'Shop B');
});
afterEach(() => { console.error = originalError; globalThis.fetch = originalFetch; });

async function seedBot(botId, ownerId, name) {
    await kv.put(BotKeys.permissions(botId), JSON.stringify({ users: [{ userId: ownerId, role: 'owner' }, { userId: MEMBER, role: 'member' }] }));
    await kv.put(BotKeys.info(botId), JSON.stringify({ displayName: name }));
    const existing = JSON.parse((await kv.get(UserKeys.bots(ownerId))) || '{"bots":[]}');
    existing.bots.push({ botId, role: 'owner' });
    await kv.put(UserKeys.bots(ownerId), JSON.stringify(existing));
}

/** 發請求並記下回應文字。回 {res, text, body} */
async function call(method, path, { headers = {}, body, e = env, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        init.body = raw ? body : JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), e, url.pathname);
    const text = await res.text();
    seen.push(text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { res, text, body: parsed };
}

const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const asUser = (userId, extra = {}) => ({ 'X-User-Id': userId, ...extra });
const errCode = (r) => r.body && r.body.error && r.body.error.code;

async function registerProduct(over = {}) {
    const r = await call('POST', '/bridge/v1/admin/products', {
        headers: bearer(ADMIN),
        body: { name: 'Image Picker', redirect_uris: [URI], url_domains: ['picker.example.com'], scopes: ALL_SCOPES, ...over },
    });
    assert.equal(r.res.status, 201, r.text);
    return r.body;
}

const q = (params) => new URLSearchParams(params).toString();
const authParams = (p, over = {}) => ({ product_id: p.product_id, state: STATE, redirect_uri: URI, ...over });

async function approve(p, { user = OWNER, bot = BOT, over = {} } = {}) {
    return call('POST', '/bridge/v1/link/authorize/approve', {
        headers: asUser(user),
        body: { ...authParams(p), bot_id: bot, ...over },
    });
}

function codeFrom(r) {
    assert.equal(r.res.status, 200, r.text);
    const u = new URL(r.body.redirect_to);
    return { code: u.searchParams.get('code'), state: u.searchParams.get('state'), url: u };
}

const exchange = (p, code, { secret = p.product_secret, uri = URI, ip = '203.0.113.7', body, e = env } = {}) =>
    call('POST', '/bridge/v1/links/token', {
        e,
        headers: bearer(secret, { 'CF-Connecting-IP': ip }),
        body: body === undefined ? { code, redirect_uri: uri } : body,
    });

/** 走完整個授權流程，回 {p, code, link:{link_id, service_key, ...}} */
async function fullLink({ bot = BOT, user = OWNER, p } = {}) {
    p = p || await registerProduct();
    const { code } = codeFrom(await approve(p, { user, bot }));
    const r = await exchange(p, code);
    assert.equal(r.res.status, 200, r.text);
    return { p, code, link: r.body };
}

const linkCall = (method, key, linkId, suffix = '') => call(method, `/bridge/v1/links/${linkId}${suffix}`, { headers: bearer(key) });

// ───────────────────────── 產品登記 ─────────────────────────

describe('POST /admin/products', () => {
    const post = (body, headers = bearer(ADMIN), e = env) => call('POST', '/bridge/v1/admin/products', { headers, body, e });
    const valid = { name: 'Image Picker', redirect_uris: [URI], scopes: ALL_SCOPES };

    it('BRIDGE_ADMIN_SECRET 未設定或為空 → 一律 404（fail-closed），不論有沒有帶憑證', async () => {
        for (const v of [undefined, '', null]) {
            const e = { ...env, BRIDGE_ADMIN_SECRET: v };
            for (const headers of [{}, bearer(ADMIN), bearer('')]) {
                const r = await post(valid, headers, e);
                assert.equal(r.res.status, 404);
                assert.equal(errCode(r), 'NOT_FOUND');
            }
        }
        assert.equal(await count(d1.db, 'products'), 0);
    });

    it('沒帶或帶錯憑證 → 401 INVALID_KEY，不建立任何東西', async () => {
        for (const headers of [{}, bearer('wrong'), bearer(`${ADMIN}x`), bearer(ADMIN.slice(0, -1)), { Authorization: ADMIN }]) {
            const r = await post(valid, headers);
            assert.equal(r.res.status, 401);
            assert.equal(errCode(r), 'INVALID_KEY');
        }
        assert.equal(await count(d1.db, 'products'), 0);
    });

    it('只收 POST（GET 與 DELETE 是 404）', async () => {
        for (const m of ['GET', 'DELETE', 'PUT']) {
            assert.equal((await call(m, '/bridge/v1/admin/products', { headers: bearer(ADMIN) })).res.status, 404);
        }
    });

    it('201：回 product_id 與產品密鑰（只這一次，no-store）；資料庫只存 SHA-256', async () => {
        const r = await post(valid);
        assert.equal(r.res.status, 201);
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.match(r.body.product_id, /^prd_[a-f0-9]{12}$/);
        assert.match(r.body.product_secret, /^bps_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
        assert.equal(r.body.product_secret.slice(4, 16), r.body.product_id.slice(4));
        assert.deepEqual(r.body.scopes, ALL_SCOPES);
        const row = (await all(d1.db, 'SELECT * FROM products'))[0];
        assert.equal(row.secret_hash, await sha256Hex(r.body.product_secret));
        assert.doesNotMatch(JSON.stringify(row), new RegExp(r.body.product_secret.slice(17)));
        assert.equal(row.disabled, 0);
    });

    it('兩次登記的產品密鑰與 id 不同', async () => {
        const a = await post(valid);
        const b = await post(valid);
        assert.notEqual(a.body.product_id, b.body.product_id);
        assert.notEqual(a.body.product_secret, b.body.product_secret);
    });

    it('寫一筆 product_registered 稽核，不含產品密鑰', async () => {
        const r = await post(valid);
        const rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'product_registered'");
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: r.body.product_id, scopes: ALL_SCOPES });
        assert.doesNotMatch(JSON.stringify(rows), new RegExp(r.body.product_secret.slice(17)));
    });

    describe('redirect_uris 驗證', () => {
        const bad = async (uris, e = env) => {
            const before = await count(d1.db, 'products');
            const r = await post({ ...valid, redirect_uris: uris }, bearer(ADMIN), e);
            assert.equal(r.res.status, 400, JSON.stringify(uris));
            assert.equal(errCode(r), 'INVALID_REQUEST');
            assert.equal(await count(d1.db, 'products'), before);
        };

        it('必須是 https', async () => {
            for (const u of ['http://picker.example.com/cb', 'ftp://picker.example.com/cb', 'javascript:alert(1)', 'data:text/html,x', '//picker.example.com/cb', 'picker.example.com/cb', '/cb']) {
                await bad([u]);
            }
        });

        it('不可含 fragment（含空的 #）', async () => {
            await bad(['https://picker.example.com/cb#x']);
            await bad(['https://picker.example.com/cb#']);
        });

        it('不可含帳號密碼', async () => {
            await bad(['https://user:pw@picker.example.com/cb']);
            await bad(['https://user@picker.example.com/cb']);
        });

        it('localhost 預設不允許（https 也不行）', async () => {
            for (const u of ['http://localhost:3000/cb', 'https://localhost/cb', 'http://127.0.0.1:8080/cb', 'https://127.0.0.1/cb', 'http://[::1]/cb']) await bad([u]);
        });

        it('測試旗標 BRIDGE_ALLOW_LOCALHOST_REDIRECT=1 才允許 localhost（http 也只限 localhost）', async () => {
            const e = { ...env, BRIDGE_ALLOW_LOCALHOST_REDIRECT: '1' };
            const ok = await post({ ...valid, redirect_uris: ['http://localhost:3000/cb', 'http://127.0.0.1:8080/cb'] }, bearer(ADMIN), e);
            assert.equal(ok.res.status, 201);
            await bad(['http://picker.example.com/cb'], e);
            for (const v of ['true', 'yes', '0', ' 1']) {
                const r = await post({ ...valid, redirect_uris: ['http://localhost:3000/cb'] }, bearer(ADMIN), { ...env, BRIDGE_ALLOW_LOCALHOST_REDIRECT: v });
                assert.equal(r.res.status, 400, v);
            }
        });

        it('不可預先帶 code／state／error 參數（會與導回網址衝突）', async () => {
            for (const k of ['code', 'state', 'error']) await bad([`https://picker.example.com/cb?${k}=1`]);
        });

        it('空陣列、非陣列、超過 10 個、非字串、過長都拒絕', async () => {
            await bad([]);
            await bad('https://picker.example.com/cb');
            await bad(Array.from({ length: 11 }, (_, i) => `https://p${i}.example.com/cb`));
            await bad([123]);
            await bad([`https://picker.example.com/${'a'.repeat(2100)}`]);
        });

        it('帶 query 的合法 https 網址可登記（原樣保存）', async () => {
            const r = await post({ ...valid, redirect_uris: ['https://picker.example.com/cb?tenant=a'] });
            assert.equal(r.res.status, 201);
            assert.deepEqual(r.body.redirect_uris, ['https://picker.example.com/cb?tenant=a']);
        });
    });

    describe('scopes 驗證：連結流程永遠不能發出 raw:push／messages:push', () => {
        const bad = async (scopes) => {
            const r = await post({ ...valid, scopes });
            assert.equal(r.res.status, 400, JSON.stringify(scopes));
            assert.equal(errCode(r), 'INVALID_REQUEST');
            assert.equal(await count(d1.db, 'products'), 0);
        };
        for (const forbidden of FORBIDDEN_LINK_SCOPES) {
            it(`含 ${forbidden} → 400`, async () => {
                await bad([forbidden]);
                await bad(['link:manage', forbidden]);
            });
        }
        it('未知 scope、空陣列、非陣列、非字串都拒絕', async () => {
            await bad(['members:read']);
            await bad(['tags:write']);
            await bad([]);
            await bad('link:manage');
            await bad([1]);
            await bad(['*']);
        });
        it('子集合可以；去重並依固定順序', async () => {
            const r = await post({ ...valid, scopes: ['messages:send', 'link:manage', 'messages:send'] });
            assert.equal(r.res.status, 201);
            assert.deepEqual(r.body.scopes, ['link:manage', 'messages:send']);
        });
    });

    describe('其他欄位驗證', () => {
        it('name 必填、≤100、不含控制字元', async () => {
            for (const name of [undefined, '', '   ', 'x'.repeat(101), 'a\nb', 5]) {
                const r = await post({ ...valid, name });
                assert.equal(r.res.status, 400, String(name));
            }
            assert.equal((await post({ ...valid, name: '  Padded  ' })).body.name, 'Padded');
        });

        it('url_domains：小寫主機名稱；萬用字元、scheme、port、大寫、路徑都拒絕', async () => {
            for (const d of [['*.example.com'], ['https://a.example.com'], ['a.example.com:443'], ['A.example.com'], ['a.example.com/x'], ['localhost'], [1], 'a.example.com']) {
                const r = await post({ ...valid, url_domains: d });
                assert.equal(r.res.status, 400, JSON.stringify(d));
            }
            const ok = await post({ ...valid, url_domains: ['a.example.com', 'a.example.com', 'b.example.co.uk'] });
            assert.deepEqual(ok.body.url_domains, ['a.example.com', 'b.example.co.uk']);
            assert.deepEqual((await post(valid)).body.url_domains, []);
        });

        it('body 不是 JSON 物件 → 400', async () => {
            for (const raw of ['not json', '[]', 'null', '']) {
                const r = await call('POST', '/bridge/v1/admin/products', { headers: bearer(ADMIN), body: raw, raw: true });
                assert.equal(r.res.status, 400, raw);
                assert.equal(errCode(r), 'INVALID_REQUEST');
            }
        });
    });

    it('限流：同一來源連續猜密鑰，超過上限回 429 RATE_LIMITED（含 Retry-After）', async () => withPinnedWindow(async () => {
        let last;
        for (let i = 0; i < 12; i++) last = await call('POST', '/bridge/v1/admin/products', { headers: bearer('wrong', { 'CF-Connecting-IP': '198.51.100.9' }), body: valid });
        assert.equal(last.res.status, 429);
        assert.equal(errCode(last), 'RATE_LIMITED');
        assert.ok(Number(last.res.headers.get('Retry-After')) >= 1);
    }));
});

// ───────────────────────── authorize（瀏覽器） ─────────────────────────

describe('GET /link/authorize', () => {
    const get = (params, e = env) => call('GET', `/bridge/v1/link/authorize?${q(params)}`, { e });

    it('通過驗證 → 302 到同意頁（掛載前綴＋/pages/link_authorize.html），帶回三個參數', async () => {
        const p = await registerProduct();
        const r = await get(authParams(p));
        assert.equal(r.res.status, 302);
        const loc = new URL(r.res.headers.get('Location'));
        assert.equal(loc.origin, ORIGIN);
        assert.equal(loc.pathname, '/lm/pages/link_authorize.html');
        assert.equal(loc.searchParams.get('product_id'), p.product_id);
        assert.equal(loc.searchParams.get('state'), STATE);
        assert.equal(loc.searchParams.get('redirect_uri'), URI);
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.equal(r.res.headers.get('Referrer-Policy'), 'no-referrer');
    });

    it('MOUNT_PATH 未設定、"/"、"lm/" 的組法', async () => {
        const p = await registerProduct();
        for (const [mount, expected] of [[undefined, '/pages/link_authorize.html'], ['/', '/pages/link_authorize.html'], ['', '/pages/link_authorize.html'], ['lm/', '/lm/pages/link_authorize.html'], ['/app/x/', '/app/x/pages/link_authorize.html']]) {
            const r = await get(authParams(p), { ...env, MOUNT_PATH: mount });
            assert.equal(new URL(r.res.headers.get('Location')).pathname, expected, String(mount));
        }
    });

    it('state 含特殊字元也完整往返（由 URL API 編碼）', async () => {
        const p = await registerProduct();
        const state = 'a&b=c#d e+f%20/?é';
        const loc = new URL((await get(authParams(p, { state }))).res.headers.get('Location'));
        assert.equal(loc.searchParams.get('state'), state);
        assert.equal([...loc.searchParams.keys()].length, 3, '特殊字元不可多長出參數');
    });

    it('state 剛好 256 字可以，257 字拒絕', async () => {
        const p = await registerProduct();
        assert.equal((await get(authParams(p, { state: 'a'.repeat(256) }))).res.status, 302);
        assert.equal((await get(authParams(p, { state: 'a'.repeat(257) }))).res.status, 400);
    });

    it('驗證不過 → 400 INVALID_REQUEST，沒有 Location（絕不導向未驗證的 redirect_uri）', async () => {
        const p = await registerProduct();
        const cases = {
            '缺 product_id': { state: STATE, redirect_uri: URI },
            '缺 state': { product_id: p.product_id, redirect_uri: URI },
            '空 state': authParams(p, { state: '' }),
            '缺 redirect_uri': { product_id: p.product_id, state: STATE },
            '產品不存在': authParams(p, { product_id: 'prd_000000000000' }),
            'product_id 格式錯': authParams(p, { product_id: 'x' }),
            'redirect_uri 加 trailing slash': authParams(p, { redirect_uri: `${URI}/` }),
            'redirect_uri 大小寫不同': authParams(p, { redirect_uri: 'https://Picker.example.com/cb' }),
            'redirect_uri 路徑大小寫不同': authParams(p, { redirect_uri: 'https://picker.example.com/CB' }),
            'redirect_uri 多 query': authParams(p, { redirect_uri: `${URI}?x=1` }),
            'redirect_uri 少一個字': authParams(p, { redirect_uri: URI.slice(0, -1) }),
            'redirect_uri 是登記值的前綴延伸': authParams(p, { redirect_uri: `${URI}/evil` }),
            'redirect_uri 帶 fragment': authParams(p, { redirect_uri: `${URI}#x` }),
            'redirect_uri 換 http': authParams(p, { redirect_uri: URI.replace('https', 'http') }),
            'redirect_uri 換網域': authParams(p, { redirect_uri: 'https://evil.example.com/cb' }),
            'redirect_uri 帶帳號': authParams(p, { redirect_uri: 'https://picker.example.com@evil.example.com/cb' }),
        };
        for (const [name, params] of Object.entries(cases)) {
            const r = await get(params);
            assert.equal(r.res.status, 400, name);
            assert.equal(errCode(r), 'INVALID_REQUEST', name);
            assert.equal(r.res.headers.get('Location'), null, name);
        }
    });

    it('產品停用 → 400，與其他失敗同一則訊息（不洩漏原因）', async () => {
        const p = await registerProduct();
        await d1.db.prepare('UPDATE products SET disabled = 1').run();
        const off = await get(authParams(p));
        const missing = await get(authParams(p, { product_id: 'prd_000000000000' }));
        assert.equal(off.res.status, 400);
        assert.deepEqual(off.body, missing.body);
    });

    it('不需要登入、不碰 KV', async () => {
        const p = await registerProduct();
        const before = kv._ops.total;
        await get(authParams(p));
        assert.equal(kv._ops.total, before);
    });

    it('只收 GET', async () => {
        const p = await registerProduct();
        assert.equal((await call('POST', `/bridge/v1/link/authorize?${q(authParams(p))}`)).res.status, 404);
    });
});

// ───────────────────────── preview ／ approve（人主體） ─────────────────────────

describe('GET /link/authorize/preview', () => {
    const preview = (params, headers) => call('GET', `/bridge/v1/link/authorize/preview?${q(params)}`, { headers });

    it('沒登入 → 401（不洩漏產品資訊）', async () => {
        const p = await registerProduct();
        const r = await preview(authParams(p), {});
        assert.equal(r.res.status, 401);
        assert.equal(errCode(r), 'INVALID_KEY');
        assert.doesNotMatch(r.text, /Image Picker/);
    });

    it('LIFF 模式（AUTH_MODE 未設）下 X-User-Id 不被信任 → 401', async () => {
        const p = await registerProduct();
        const e = { ...env, AUTH_MODE: undefined };
        const r = await call('GET', `/bridge/v1/link/authorize/preview?${q(authParams(p))}`, { headers: asUser(OWNER), e });
        assert.equal(r.res.status, 401);
    });

    it('回產品名稱、授權範圍、這個人「擁有」的 bot、取消導向網址', async () => {
        const p = await registerProduct();
        const r = await preview(authParams(p), asUser(OWNER));
        assert.equal(r.res.status, 200);
        assert.deepEqual(r.body.product, { product_id: p.product_id, name: 'Image Picker' });
        assert.deepEqual(r.body.scopes, ALL_SCOPES);
        assert.deepEqual(r.body.bots, [{ bot_id: BOT, display_name: 'Shop A' }]);
        const cancel = new URL(r.body.cancel_redirect_to);
        assert.equal(`${cancel.origin}${cancel.pathname}`, URI);
        assert.equal(cancel.searchParams.get('error'), 'access_denied');
        assert.equal(cancel.searchParams.get('state'), STATE);
        assert.equal(cancel.searchParams.get('code'), null);
    });

    it('被邀請的 member 看不到那個 bot；沒有 bot 的人得到空清單', async () => {
        const p = await registerProduct();
        await kv.put(UserKeys.bots(MEMBER), JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }] })); // 索引說謊也沒用
        assert.deepEqual((await preview(authParams(p), asUser(MEMBER))).body.bots, []);
        assert.deepEqual((await preview(authParams(p), asUser('Unobody000000000000000000000009'))).body.bots, []);
    });

    it('別人的 bot 不會出現在清單', async () => {
        const p = await registerProduct();
        assert.deepEqual((await preview(authParams(p), asUser(OWNER2))).body.bots, [{ bot_id: BOT2, display_name: 'Shop B' }]);
    });

    it('產品登記的 scope 較少 → 只列那些', async () => {
        const p = await registerProduct({ scopes: ['messages:send', 'link:manage'] });
        assert.deepEqual((await preview(authParams(p), asUser(OWNER))).body.scopes, ['link:manage', 'messages:send']);
    });

    it('參數不通過（redirect_uri 差一個字元、產品停用）→ 400', async () => {
        const p = await registerProduct();
        assert.equal((await preview(authParams(p, { redirect_uri: `${URI}/` }), asUser(OWNER))).res.status, 400);
        await d1.db.prepare('UPDATE products SET disabled = 1').run();
        assert.equal((await preview(authParams(p), asUser(OWNER))).res.status, 400);
    });

    it('產品名稱原樣回傳（轉義是前端的事）；其他回應欄位不含不該有的東西', async () => {
        const p = await registerProduct({ name: '<img src=x onerror=alert(1)>' });
        const r = await preview(authParams(p), asUser(OWNER));
        assert.equal(r.body.product.name, '<img src=x onerror=alert(1)>');
        assert.doesNotMatch(r.text, /secret_hash|product_secret/);
    });
});

describe('POST /link/authorize/approve', () => {
    it('沒登入 → 401，不發碼', async () => {
        const p = await registerProduct();
        const r = await call('POST', '/bridge/v1/link/authorize/approve', { body: { ...authParams(p), bot_id: BOT } });
        assert.equal(r.res.status, 401);
        assert.equal(await count(d1.db, 'auth_codes'), 0);
    });

    it('owner 同意 → 回導回網址：code 與原樣的 state；授權碼只存雜湊、5 分鐘、scope 全開', async () => {
        const p = await registerProduct();
        const now = Date.now();
        const r = await approve(p);
        const { code, state, url } = codeFrom(r);
        assert.equal(`${url.origin}${url.pathname}`, URI);
        assert.match(code, /^lmc_[A-Za-z0-9_-]{43}$/);
        assert.equal(state, STATE);
        const row = (await all(d1.db, 'SELECT * FROM auth_codes'))[0];
        assert.equal(row.code_hash, await sha256Hex(code));
        assert.equal(row.product_id, p.product_id);
        assert.equal(row.bot_id, BOT);
        assert.equal(row.redirect_uri, URI);
        assert.equal(row.created_by, OWNER);
        assert.equal(row.used_at, null);
        assert.deepEqual(JSON.parse(row.scopes), ALL_SCOPES);
        assert.ok(row.expires_at - now >= 5 * 60 * 1000 - 5 && row.expires_at - now <= 5 * 60 * 1000 + 5000, String(row.expires_at - now));
        assert.doesNotMatch(JSON.stringify(row), new RegExp(code.slice(4)));
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
    });

    it('導回網址用 URL API 組：state 含 & = # 空白也不會破壞或多出參數；原有 query 保留', async () => {
        const p = await registerProduct({ redirect_uris: ['https://picker.example.com/cb?tenant=a'] });
        const state = 'x&code=evil#frag y';
        const r = await call('POST', '/bridge/v1/link/authorize/approve', {
            headers: asUser(OWNER), body: { product_id: p.product_id, state, redirect_uri: 'https://picker.example.com/cb?tenant=a', bot_id: BOT },
        });
        const u = new URL(r.body.redirect_to);
        assert.equal(u.searchParams.get('tenant'), 'a');
        assert.equal(u.searchParams.get('state'), state);
        assert.equal(u.searchParams.getAll('code').length, 1);
        assert.equal(u.hash, '');
    });

    it('每次發的碼都不同', async () => {
        const p = await registerProduct();
        const a = codeFrom(await approve(p)).code;
        const b = codeFrom(await approve(p)).code;
        assert.notEqual(a, b);
    });

    it('bot 不是自己的（owner 了別的 bot）→ 404，不發碼；與「bot 不存在」同一個回應', async () => {
        const p = await registerProduct();
        const cross = await approve(p, { user: OWNER, bot: BOT2 });
        const ghost = await approve(p, { user: OWNER, bot: 'Unotexist00000000000000000000009' });
        assert.equal(cross.res.status, 404);
        assert.equal(errCode(cross), 'NOT_FOUND');
        assert.deepEqual(cross.body, ghost.body);
        assert.equal(await count(d1.db, 'auth_codes'), 0);
    });

    it('member（非 owner）→ 404，不發碼', async () => {
        const p = await registerProduct();
        assert.equal((await approve(p, { user: MEMBER, bot: BOT })).res.status, 404);
        assert.equal(await count(d1.db, 'auth_codes'), 0);
    });

    it('body 裡自報 ownerId／userId／created_by 完全無效：授權碼的發碼者永遠是已認證的人', async () => {
        const p = await registerProduct();
        const denied = await approve(p, { user: MEMBER, bot: BOT, over: { ownerId: OWNER, userId: OWNER, owner_id: OWNER, created_by: OWNER } });
        assert.equal(denied.res.status, 404);
        const ok = await approve(p, { user: OWNER, over: { ownerId: OWNER2, created_by: OWNER2 } });
        assert.equal(ok.res.status, 200);
        assert.equal((await all(d1.db, 'SELECT created_by FROM auth_codes'))[0].created_by, OWNER);
    });

    it('缺 bot_id 或格式不對 → 400', async () => {
        const p = await registerProduct();
        for (const bot of [undefined, '', 5, 'a:b', 'x'.repeat(65)]) {
            const r = await call('POST', '/bridge/v1/link/authorize/approve', { headers: asUser(OWNER), body: { ...authParams(p), bot_id: bot } });
            assert.equal(r.res.status, 400, String(bot));
        }
    });

    it('參數不通過（redirect_uri 差一個字元、產品停用、state 太長）→ 400，不發碼', async () => {
        const p = await registerProduct();
        for (const over of [{ redirect_uri: `${URI}/` }, { redirect_uri: URI.toUpperCase() }, { redirect_uri: `${URI}?a=1` }, { state: 'a'.repeat(257) }, { product_id: 'prd_000000000000' }]) {
            assert.equal((await approve(p, { over })).res.status, 400, JSON.stringify(over));
        }
        await d1.db.prepare('UPDATE products SET disabled = 1').run();
        assert.equal((await approve(p)).res.status, 400);
        assert.equal(await count(d1.db, 'auth_codes'), 0);
    });

    it('授權碼的 scope 受產品登記上限約束；就算資料庫被竄改含 raw:push 也不會發出去', async () => {
        const p = await registerProduct({ scopes: ['messages:send'] });
        await approve(p);
        assert.deepEqual(JSON.parse((await all(d1.db, 'SELECT scopes FROM auth_codes'))[0].scopes), ['messages:send']);
        await d1.db.prepare(`UPDATE products SET scopes = '["raw:push","messages:push","link:manage"]'`).run();
        await approve(p);
        const scopes = (await all(d1.db, 'SELECT scopes FROM auth_codes')).map((r) => JSON.parse(r.scopes));
        assert.deepEqual(scopes[1], ['link:manage']);
    });

    it('限流之外：人主體的 rate limit 仍適用（沿用 authenticateUser）', async () => withPinnedWindow(async () => {
        const p = await registerProduct();
        let last;
        for (let i = 0; i < 101; i++) last = await call('GET', `/bridge/v1/link/authorize/preview?${q(authParams(p))}`, { headers: asUser(OWNER) });
        assert.equal(last.res.status, 429);
        assert.equal(errCode(last), 'RATE_LIMITED');
        assert.ok(last.res.headers.get('Retry-After'));
    }));
});

// ───────────────────────── links/token ─────────────────────────

describe('POST /links/token', () => {
    it('成功：回 link_id、service_key（brk_）、scopes、bot_display_name；no-store', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        const r = await exchange(p, code);
        assert.equal(r.res.status, 200);
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.match(r.body.link_id, /^lnk_[a-f0-9]{16}$/);
        assert.match(r.body.service_key, /^brk_[0-9a-f]{6}_[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(r.body.scopes, ALL_SCOPES);
        assert.equal(r.body.bot_display_name, 'Shop A');
        assert.deepEqual(Object.keys(r.body).sort(), ['bot_display_name', 'link_id', 'scopes', 'service_key']);
    });

    it('資料庫：連結 active、只存金鑰雜湊（link_id 關聯）、授權碼標記已用', async () => {
        const { p, link } = await fullLink();
        const l = (await all(d1.db, 'SELECT * FROM links'))[0];
        assert.equal(l.link_id, link.link_id);
        assert.equal(l.product_id, p.product_id);
        assert.equal(l.bot_id, BOT);
        assert.equal(l.status, 'active');
        assert.equal(l.created_by, OWNER);
        assert.deepEqual(JSON.parse(l.scopes), ALL_SCOPES);
        const k = (await all(d1.db, 'SELECT * FROM service_keys'))[0];
        assert.equal(k.key_hash, await sha256Hex(link.service_key));
        assert.equal(k.link_id, link.link_id);
        assert.equal(k.revoked_at, null);
        assert.doesNotMatch(JSON.stringify(k), new RegExp(link.service_key.slice(11)));
        assert.notEqual((await all(d1.db, 'SELECT used_at FROM auth_codes'))[0].used_at, null);
    });

    it('授權碼只能用一次：第二次回 INVALID_CODE，不再建立任何東西', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        assert.equal((await exchange(p, code)).res.status, 200);
        const again = await exchange(p, code);
        assert.equal(again.res.status, 400);
        assert.equal(errCode(again), 'INVALID_CODE');
        assert.equal(await count(d1.db, 'links'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('並行 8 個交換同一個授權碼，只有 1 個成功，且只建立 1 條連結與 1 把金鑰', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => exchange(p, code, { ip: `203.0.113.${i + 10}` })));
        assert.equal(results.filter((r) => r.res.status === 200).length, 1);
        for (const r of results.filter((x) => x.res.status !== 200)) assert.equal(errCode(r), 'INVALID_CODE');
        assert.equal(await count(d1.db, 'links'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 1);
    });

    it('過期的碼（5 分鐘後）→ INVALID_CODE', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        await d1.db.prepare('UPDATE auth_codes SET expires_at = ?1').bind(Date.now() - 1).run();
        const r = await exchange(p, code);
        assert.equal(r.res.status, 400);
        assert.equal(errCode(r), 'INVALID_CODE');
        assert.equal(await count(d1.db, 'links'), 0);
    });

    it('過期、已用、不存在、格式亂、redirect_uri 不符：回應完全一樣（同一個 INVALID_CODE）', async () => {
        const p = await registerProduct();
        const used = codeFrom(await approve(p)).code;
        await exchange(p, used);
        const expired = codeFrom(await approve(p)).code;
        await d1.db.prepare('UPDATE auth_codes SET expires_at = 1 WHERE used_at IS NULL').run();
        const wrongUri = codeFrom(await approve(p)).code;
        const bodies = [
            (await exchange(p, used)).body,
            (await exchange(p, expired)).body,
            (await exchange(p, `lmc_${'A'.repeat(43)}`)).body,
            (await exchange(p, 'garbage')).body,
            (await exchange(p, wrongUri, { uri: `${URI}/` })).body,
        ];
        for (const b of bodies) assert.deepEqual(b, bodies[0]);
        assert.equal(bodies[0].error.code, 'INVALID_CODE');
        assert.equal(bodies[0].error.retryable, false);
    });

    it('redirect_uri 與發碼時差一個字元（trailing slash、大小寫、query、前後空白）→ INVALID_CODE，且碼不被燒掉', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        for (const uri of [`${URI}/`, URI.toUpperCase(), 'https://Picker.example.com/cb', `${URI}?a=1`, `${URI}#x`, ` ${URI}`, `${URI} `, URI.slice(0, -1), 'https://picker.example.com/cb/../cb']) {
            const r = await exchange(p, code, { uri });
            assert.equal(r.res.status, 400, uri);
            assert.equal(errCode(r), 'INVALID_CODE', uri);
        }
        assert.equal(await count(d1.db, 'links'), 0);
        assert.equal((await exchange(p, code)).res.status, 200, '正確的 redirect_uri 仍可換');
    });

    it('redirect_uri 必須與「發碼時」相同：產品之後新增了第二個登記網址，用第二個換不到', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        const other = 'https://picker.example.com/other';
        await d1.db.prepare('UPDATE products SET redirect_uris = ?1').bind(JSON.stringify([URI, other])).run();
        assert.equal(errCode(await exchange(p, code, { uri: other })), 'INVALID_CODE');
        assert.equal((await exchange(p, code)).res.status, 200);
    });

    it('A 產品的碼不能用 B 產品的密鑰換（INVALID_CODE），也不燒掉 A 的碼', async () => {
        const a = await registerProduct();
        const b = await registerProduct();
        const { code } = codeFrom(await approve(a));
        const r = await exchange(b, code);
        assert.equal(errCode(r), 'INVALID_CODE');
        assert.equal((await exchange(a, code)).res.status, 200);
    });

    describe('產品密鑰', () => {
        it('錯密鑰、不存在的產品、格式亂、沒帶：一律同一個 INVALID_KEY（401），回應完全一樣', async () => {
            const p = await registerProduct();
            const { code } = codeFrom(await approve(p));
            const wrongSecret = `bps_${p.product_id.slice(4)}_${'A'.repeat(43)}`;
            const ghost = `bps_${'0'.repeat(12)}_${'A'.repeat(43)}`;
            const results = [
                await exchange(p, code, { secret: wrongSecret }),
                await exchange(p, code, { secret: ghost }),
                await exchange(p, code, { secret: 'garbage' }),
                await exchange(p, code, { secret: p.product_secret.slice(0, -1) }),
                await exchange(p, code, { secret: `${p.product_secret}x` }),
                await call('POST', '/bridge/v1/links/token', { headers: {}, body: { code, redirect_uri: URI } }),
                await call('POST', '/bridge/v1/links/token', { headers: { Authorization: p.product_secret }, body: { code, redirect_uri: URI } }),
            ];
            for (const r of results) {
                assert.equal(r.res.status, 401);
                assert.deepEqual(r.body, results[0].body);
            }
            assert.equal(results[0].body.error.code, 'INVALID_KEY');
            assert.equal(await count(d1.db, 'links'), 0);
            assert.equal((await exchange(p, code)).res.status, 200, '碼沒被錯密鑰的請求燒掉');
        });

        it('連結金鑰、營運密鑰都不能當產品密鑰', async () => {
            const { p, link } = await fullLink();
            const { code } = codeFrom(await approve(p));
            assert.equal((await exchange(p, code, { secret: link.service_key })).res.status, 401);
            assert.equal((await exchange(p, code, { secret: ADMIN })).res.status, 401);
        });

        it('產品停用 → INVALID_KEY（與密鑰錯無法區分），碼不被消耗', async () => {
            const p = await registerProduct();
            const { code } = codeFrom(await approve(p));
            await d1.db.prepare('UPDATE products SET disabled = 1').run();
            const r = await exchange(p, code);
            assert.equal(r.res.status, 401);
            assert.equal(errCode(r), 'INVALID_KEY');
            assert.equal((await all(d1.db, 'SELECT used_at FROM auth_codes'))[0].used_at, null);
        });

        it('停用在核發碼之後、交換之前發生也擋得住', async () => {
            const p = await registerProduct();
            const { code } = codeFrom(await approve(p));
            await d1.db.prepare('UPDATE products SET disabled = 1').run();
            assert.equal((await exchange(p, code)).res.status, 401);
            assert.equal(await count(d1.db, 'links'), 0);
        });
    });

    it('缺欄位或 body 不是 JSON → INVALID_REQUEST（400）；碼格式錯才是 INVALID_CODE', async () => {
        const p = await registerProduct();
        for (const body of [{}, { code: 'x' }, { redirect_uri: URI }, { code: 1, redirect_uri: URI }, { code: 'x', redirect_uri: 5 }]) {
            const r = await exchange(p, null, { body });
            assert.equal(r.res.status, 400, JSON.stringify(body));
            assert.equal(errCode(r), 'INVALID_REQUEST');
        }
        const raw = await call('POST', '/bridge/v1/links/token', { headers: bearer(p.product_secret), body: 'nope', raw: true });
        assert.equal(errCode(raw), 'INVALID_REQUEST');
    });

    it('只收 POST', async () => {
        const p = await registerProduct();
        assert.equal((await call('GET', '/bridge/v1/links/token', { headers: bearer(p.product_secret) })).res.status, 404);
    });

    describe('限流 (IP, product_id)', () => {
        it('同一來源同一產品超過上限 → 429 RATE_LIMITED（含 Retry-After）；之後連正確的也被擋', async () => withPinnedWindow(async () => {
            const p = await registerProduct();
            let last;
            for (let i = 0; i < 31; i++) last = await exchange(p, `lmc_${'A'.repeat(43)}`, { ip: '198.51.100.1' });
            assert.equal(last.res.status, 429);
            assert.equal(errCode(last), 'RATE_LIMITED');
            assert.equal(last.body.error.retryable, true);
            assert.ok(Number(last.res.headers.get('Retry-After')) >= 1);
            const { code } = codeFrom(await approve(p));
            assert.equal((await exchange(p, code, { ip: '198.51.100.1' })).res.status, 429);
        }));

        it('桶是 (來源, 產品)：換來源或換產品不受影響', async () => {
            const p = await registerProduct();
            const other = await registerProduct();
            for (let i = 0; i < 31; i++) await exchange(p, `lmc_${'A'.repeat(43)}`, { ip: '198.51.100.1' });
            const { code } = codeFrom(await approve(p));
            assert.equal((await exchange(p, code, { ip: '198.51.100.2' })).res.status, 200);
            const { code: c2 } = codeFrom(await approve(other));
            assert.equal((await exchange(other, c2, { ip: '198.51.100.1' })).res.status, 200);
        });

        it('亂猜的格式錯誤密鑰也算進 (來源, unknown) 的桶', async () => withPinnedWindow(async () => {
            let last;
            for (let i = 0; i < 31; i++) last = await call('POST', '/bridge/v1/links/token', { headers: bearer('junk', { 'CF-Connecting-IP': '198.51.100.3' }), body: {} });
            assert.equal(last.res.status, 429);
        }));

        it('缺 KV binding → 沿用限流器既有行為：fail-open（不限流），交換仍可進行', async () => {
            const e = { ...env, KV_LINE_STORAGE: undefined };
            const p = await registerProduct();
            // approve 需要 KV 做 owner 檢查，所以直接在資料庫放一個碼
            await d1.db.prepare("INSERT INTO auth_codes (code_hash, product_id, bot_id, redirect_uri, scopes, created_by, expires_at) VALUES (?1,?2,?3,?4,?5,'Uowner',?6)")
                .bind(await sha256Hex(`lmc_${'B'.repeat(43)}`), p.product_id, BOT, URI, JSON.stringify(ALL_SCOPES), Date.now() + 60000).run();
            let last;
            for (let i = 0; i < 40; i++) last = await exchange(p, `lmc_${'A'.repeat(43)}`, { ip: '198.51.100.4', e });
            assert.equal(last.res.status, 400, '沒有 KV 就沒有 429');
            const r = await call('POST', '/bridge/v1/links/token', { headers: bearer(p.product_secret), body: { code: `lmc_${'B'.repeat(43)}`, redirect_uri: URI }, e });
            assert.equal(r.res.status, 200);
            assert.equal(r.body.bot_display_name, 'LINE 官方帳號', '沒有 KV 查不到名稱時用通用名稱');
        });
    });

    it('連結 scope 受產品「現在」的登記上限約束（產品被縮小後交換）；縮到空 → INVALID_CODE', async () => {
        const p = await registerProduct();
        const { code } = codeFrom(await approve(p));
        await d1.db.prepare(`UPDATE products SET scopes = '["contacts:bind"]'`).run();
        const r = await exchange(p, code);
        assert.deepEqual(r.body.scopes, ['contacts:bind']);
        const { code: c2 } = codeFrom(await approve(p));
        await d1.db.prepare(`UPDATE products SET scopes = '["raw:push"]'`).run();
        assert.equal(errCode(await exchange(p, c2)), 'INVALID_CODE');
    });

    it('稽核：link_authorized（含 product_id、link_id、scopes）；失敗寫 code_exchange_failed（只有 product_id 與錯誤碼）', async () => {
        const { p, link } = await fullLink();
        await exchange(p, `lmc_${'A'.repeat(43)}`);
        await exchange(p, null, { secret: `bps_${p.product_id.slice(4)}_${'A'.repeat(43)}` });
        await exchange(p, null, { secret: `bps_${'0'.repeat(12)}_${'A'.repeat(43)}` }); // 產品不存在：不記
        const rows = await all(d1.db, 'SELECT action, result, actor_type, bot_id, detail FROM audit_log ORDER BY id');
        const byAction = (a) => rows.filter((r) => r.action === a);
        assert.equal(byAction('link_authorized').length, 1);
        assert.deepEqual(JSON.parse(byAction('link_authorized')[0].detail), { product_id: p.product_id, link_id: link.link_id, scopes: ALL_SCOPES });
        assert.equal(byAction('link_authorized')[0].bot_id, BOT);
        const failed = byAction('code_exchange_failed').map((r) => JSON.parse(r.detail));
        assert.deepEqual(failed, [
            { product_id: p.product_id, error_code: 'INVALID_CODE' },
            { product_id: p.product_id, error_code: 'INVALID_KEY' },
        ]);
    });
});

// ───────────────────────── 重新授權 ─────────────────────────

describe('重新授權（撤銷舊連結、發新連結）', () => {
    it('舊金鑰立即失效（LINK_REVOKED），只剩一條 active 連結與一把有效金鑰；新連結 id 不同', async () => {
        const first = await fullLink();
        const { code } = codeFrom(await approve(first.p));
        const second = (await exchange(first.p, code)).body;
        assert.notEqual(second.link_id, first.link.link_id);

        const old = await linkCall('GET', first.link.service_key, first.link.link_id);
        assert.equal(old.res.status, 403);
        assert.equal(errCode(old), 'LINK_REVOKED');
        assert.equal((await linkCall('GET', second.service_key, second.link_id)).res.status, 200);

        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await count(d1.db, 'links'), 2);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 2);
    });

    it('舊連結用舊金鑰也不能再輪替或刪除', async () => {
        const first = await fullLink();
        const { code } = codeFrom(await approve(first.p));
        await exchange(first.p, code);
        assert.equal(errCode(await linkCall('POST', first.link.service_key, first.link.link_id, '/rotate-key')), 'LINK_REVOKED');
        assert.equal(errCode(await linkCall('DELETE', first.link.service_key, first.link.link_id)), 'LINK_REVOKED');
    });

    it('稽核：link_authorized 兩筆、被取代的舊連結記一筆 link_revoked', async () => {
        const first = await fullLink();
        const { code } = codeFrom(await approve(first.p));
        await exchange(first.p, code);
        const revoked = await all(d1.db, "SELECT detail FROM audit_log WHERE action = 'link_revoked'");
        assert.deepEqual(revoked.map((r) => JSON.parse(r.detail)), [{ product_id: first.p.product_id, link_id: first.link.link_id }]);
        assert.equal(await count(d1.db, 'audit_log', "action = 'link_authorized'"), 2);
    });

    it('不同 bot 是各自獨立的連結：連 B bot 不影響 A bot 的連結', async () => {
        const a = await fullLink({ bot: BOT, user: OWNER });
        const { code } = codeFrom(await approve(a.p, { user: OWNER2, bot: BOT2 }));
        const b = (await exchange(a.p, code)).body;
        assert.equal((await linkCall('GET', a.link.service_key, a.link.link_id)).res.status, 200);
        assert.equal((await linkCall('GET', b.service_key, b.link_id)).res.status, 200);
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 2);
    });

    it('同一 bot 對不同產品是各自獨立的連結', async () => {
        const a = await fullLink();
        const b = await fullLink({ p: await registerProduct() });
        assert.equal((await linkCall('GET', a.link.service_key, a.link.link_id)).res.status, 200);
        assert.equal((await linkCall('GET', b.link.service_key, b.link.link_id)).res.status, 200);
    });
});

// ───────────────────────── 連結金鑰管理自己這條連結 ─────────────────────────

describe('GET/DELETE /links/{id}、POST /links/{id}/rotate-key', () => {
    it('GET：連結狀態，不含任何金鑰或雜湊', async () => {
        const { link } = await fullLink();
        const r = await linkCall('GET', link.service_key, link.link_id);
        assert.equal(r.res.status, 200);
        assert.deepEqual(Object.keys(r.body).sort(), ['bot_display_name', 'created_at', 'link_id', 'revoked_at', 'scopes', 'status']);
        assert.equal(r.body.status, 'active');
        assert.equal(r.body.bot_display_name, 'Shop A');
        assert.equal(r.body.revoked_at, null);
        assert.ok(!Number.isNaN(Date.parse(r.body.created_at)));
        assert.doesNotMatch(r.text, /brk_|key_hash|secret/);
    });

    it('DELETE：204，立即生效；舊金鑰此後 LINK_REVOKED；稽核 link_revoked', async () => {
        const { p, link } = await fullLink();
        const r = await linkCall('DELETE', link.service_key, link.link_id);
        assert.equal(r.res.status, 204);
        assert.equal(r.text, '');
        const after = await linkCall('GET', link.service_key, link.link_id);
        assert.equal(after.res.status, 403);
        assert.equal(errCode(after), 'LINK_REVOKED');
        assert.equal(after.body.error.retryable, false);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 0);
        const audit = await all(d1.db, "SELECT actor_type, detail FROM audit_log WHERE action = 'link_revoked'");
        assert.deepEqual(audit.map((a) => [a.actor_type, JSON.parse(a.detail)]), [['service_key', { product_id: p.product_id, link_id: link.link_id }]]);
    });

    it('rotate-key：新金鑰可用、舊金鑰立即 INVALID_KEY；連結 id 不變；稽核 key_rotated', async () => {
        const { link } = await fullLink();
        const r = await linkCall('POST', link.service_key, link.link_id, '/rotate-key');
        assert.equal(r.res.status, 200);
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(Object.keys(r.body), ['service_key']);
        assert.match(r.body.service_key, /^brk_[0-9a-f]{6}_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(r.body.service_key, link.service_key);
        const old = await linkCall('GET', link.service_key, link.link_id);
        assert.equal(old.res.status, 401);
        assert.equal(errCode(old), 'INVALID_KEY');
        assert.equal((await linkCall('GET', r.body.service_key, link.link_id)).res.status, 200);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        assert.equal(await count(d1.db, 'audit_log', "action = 'key_rotated'"), 1);
    });

    it('並行 rotate-key 6 次後，恰好一把有效，且連結仍 active', async () => {
        const { link } = await fullLink();
        const results = await Promise.all(Array.from({ length: 6 }, () => linkCall('POST', link.service_key, link.link_id, '/rotate-key')));
        const ok = results.filter((r) => r.res.status === 200);
        assert.ok(ok.length >= 1);
        for (const r of results.filter((x) => x.res.status !== 200)) assert.equal(r.res.status, 401);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        const valid = [];
        for (const r of ok) if ((await linkCall('GET', r.body.service_key, link.link_id)).res.status === 200) valid.push(r.body.service_key);
        assert.equal(valid.length, 1, '回出去的金鑰裡只有一把還能用');
    });

    it('連續輪替後只有最新一把有效', async () => {
        const { link } = await fullLink();
        let key = link.service_key;
        const olds = [];
        for (let i = 0; i < 3; i++) {
            olds.push(key);
            key = (await linkCall('POST', key, link.link_id, '/rotate-key')).body.service_key;
        }
        for (const k of olds) assert.equal((await linkCall('GET', k, link.link_id)).res.status, 401);
        assert.equal((await linkCall('GET', key, link.link_id)).res.status, 200);
    });

    describe('只能操作自己這條連結：link_id 不符 → NOT_FOUND（不洩漏他人連結是否存在）', () => {
        it('用 A 的金鑰操作 B 的連結、不存在的連結、亂格式：三種回應完全一樣（404 NOT_FOUND）', async () => {
            const a = await fullLink({ bot: BOT, user: OWNER });
            const b = await fullLink({ bot: BOT2, user: OWNER2, p: a.p });
            const ghost = 'lnk_0000000000000000';
            for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['POST', '/rotate-key']]) {
                const cross = await linkCall(method, a.link.service_key, b.link.link_id, suffix);
                const missing = await linkCall(method, a.link.service_key, ghost, suffix);
                const weird = await linkCall(method, a.link.service_key, 'x', suffix);
                const traversal = await linkCall(method, a.link.service_key, '..%2F..%2Fsystems', suffix);
                for (const r of [cross, missing, weird, traversal]) {
                    assert.equal(r.res.status, 404, `${method}${suffix}`);
                    assert.equal(errCode(r), 'NOT_FOUND');
                }
                assert.deepEqual(cross.body, missing.body);
            }
            // B 的連結與金鑰完全沒被動到
            assert.equal((await linkCall('GET', b.link.service_key, b.link.link_id)).res.status, 200);
            assert.equal(await count(d1.db, 'links', "status = 'active'"), 2);
            assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 2);
        });

        it('同產品同 bot 的舊連結（已被取代）也算「不是自己這條」', async () => {
            const first = await fullLink();
            const { code } = codeFrom(await approve(first.p));
            const second = (await exchange(first.p, code)).body;
            const r = await linkCall('GET', second.service_key, first.link.link_id);
            assert.equal(r.res.status, 404);
        });
    });

    describe('認證順序：金鑰 → 連結 active → 產品未停用 → scope', () => {
        it('沒帶、格式錯、不存在的金鑰 → 401 INVALID_KEY（回應相同）', async () => {
            const { link } = await fullLink();
            const rs = [
                await call('GET', `/bridge/v1/links/${link.link_id}`, { headers: {} }),
                await call('GET', `/bridge/v1/links/${link.link_id}`, { headers: { Authorization: 'Bearer ' } }),
                await call('GET', `/bridge/v1/links/${link.link_id}`, { headers: { Authorization: link.service_key } }),
                await linkCall('GET', 'brk_000000_nope', link.link_id),
            ];
            for (const r of rs) {
                assert.equal(r.res.status, 401);
                assert.equal(errCode(r), 'INVALID_KEY');
            }
        });

        it('金鑰已撤銷（輪替掉）與不存在同為 INVALID_KEY，訊息相同', async () => {
            const { link } = await fullLink();
            await linkCall('POST', link.service_key, link.link_id, '/rotate-key');
            const revoked = await linkCall('GET', link.service_key, link.link_id);
            const ghost = await linkCall('GET', 'brk_000000_nope', link.link_id);
            assert.deepEqual(revoked.body, ghost.body);
        });

        it('連結被撤銷 → LINK_REVOKED（403），即使金鑰也一併撤銷了', async () => {
            const { link } = await fullLink();
            await d1.db.prepare("UPDATE links SET status = 'revoked', revoked_at = 1").run();
            const r = await linkCall('GET', link.service_key, link.link_id);
            assert.equal(r.res.status, 403);
            assert.equal(errCode(r), 'LINK_REVOKED');
        });

        it('產品停用 → 連結金鑰立即 LINK_REVOKED；重新啟用即恢復', async () => {
            const { link } = await fullLink();
            await d1.db.prepare('UPDATE products SET disabled = 1').run();
            assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'LINK_REVOKED');
            await d1.db.prepare('UPDATE products SET disabled = 0').run();
            assert.equal((await linkCall('GET', link.service_key, link.link_id)).res.status, 200);
        });

        it('scope 不足 → SCOPE_DENIED（403）：沒有 link:manage 的連結管不了自己', async () => {
            const p = await registerProduct({ scopes: ['messages:send', 'contacts:bind'] });
            const { link } = await fullLink({ p });
            assert.deepEqual(link.scopes, ['contacts:bind', 'messages:send']);
            for (const [m, s] of [['GET', ''], ['DELETE', ''], ['POST', '/rotate-key']]) {
                const r = await linkCall(m, link.service_key, link.link_id, s);
                assert.equal(r.res.status, 403);
                assert.equal(errCode(r), 'SCOPE_DENIED');
            }
            assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        });

        it('金鑰的 scopes 被縮小（資料庫）或連結沒有該 scope → SCOPE_DENIED', async () => {
            const { link } = await fullLink();
            await d1.db.prepare(`UPDATE service_keys SET scopes = '["messages:send"]'`).run();
            assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'SCOPE_DENIED');
            await d1.db.prepare(`UPDATE service_keys SET scopes = '["link:manage"]'`).run();
            await d1.db.prepare(`UPDATE links SET scopes = '["messages:send"]'`).run();
            assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'SCOPE_DENIED');
        });

        it('金鑰與連結的 bot 不一致（資料毀損）→ INVALID_KEY', async () => {
            const { link } = await fullLink();
            await d1.db.prepare('UPDATE service_keys SET bot_id = ?1').bind(BOT2).run();
            assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'INVALID_KEY');
        });

        it('孤兒連結金鑰（連結列不存在）→ INVALID_KEY', async () => {
            const { link } = await fullLink();
            await d1.db.prepare('DELETE FROM links').run();
            assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'INVALID_KEY');
        });
    });

    it('未知的子路徑與方法 → 404 NOT_FOUND（新格式）', async () => {
        const { link } = await fullLink();
        for (const [m, path] of [['PUT', `/bridge/v1/links/${link.link_id}`], ['GET', `/bridge/v1/links/${link.link_id}/rotate-key`], ['POST', `/bridge/v1/links/${link.link_id}/other`], ['GET', '/bridge/v1/links'], ['GET', '/bridge/v1/link'], ['GET', '/bridge/v1/admin'], ['GET', '/bridge/v1/link/authorize/x']]) {
            const r = await call(m, path, { headers: bearer(link.service_key) });
            assert.equal(r.res.status, 404, `${m} ${path}`);
            assert.equal(errCode(r), 'NOT_FOUND');
        }
    });
});

// ───────────────────────── 金鑰種類隔離 ─────────────────────────

describe('連結金鑰與系統金鑰互不通用', () => {
    const SYSTEM_KEY = 'brk_aaaaaa_systemkeyvalue0000000000000000000000000';

    async function withSystemKey(scopes = ['raw:push']) {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', scopes });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYSTEM_KEY, scopes });
    }

    it('連結金鑰打 /raw/push、/raw/multicast → 401（舊格式），不會送出任何東西', async () => {
        const { link } = await fullLink();
        let pushed = 0;
        globalThis.fetch = async () => { pushed++; return new Response('{}', { status: 200 }); };
        for (const path of ['/bridge/v1/raw/push', '/bridge/v1/raw/multicast']) {
            const r = await call('POST', path, { headers: bearer(link.service_key, { 'X-Bot-Id': BOT }), body: { to: 'Utarget', messages: [{ type: 'text', text: 'x' }] } });
            assert.equal(r.res.status, 401, path);
            assert.deepEqual(r.body, { success: false, error: 'Invalid or revoked service key' }, '/raw/* 維持舊格式');
        }
        assert.equal(pushed, 0);
    });

    it('即使把連結金鑰竄改成帶 raw:push scope、並補上同名系統，/raw/* 仍然拒絕（link_id 非空一律不通過）', async () => {
        const { link } = await fullLink();
        await seedSystem(d1.db, { botId: BOT, system: 'link:fake', scopes: ['raw:push'] });
        await d1.db.prepare(`UPDATE service_keys SET scopes = '["raw:push"]'`).run();
        await d1.db.prepare(`UPDATE links SET scopes = '["raw:push"]'`).run();
        const r = await call('POST', '/bridge/v1/raw/push', { headers: bearer(link.service_key, { 'X-Bot-Id': BOT }), body: { to: 'Utarget', messages: [{ type: 'text', text: 'x' }] } });
        assert.equal(r.res.status, 401);
        const direct = await authenticateBridge(new Request(`${ORIGIN}/bridge/v1/raw/push`, { method: 'POST', headers: bearer(link.service_key, { 'X-Bot-Id': BOT }) }), env);
        assert.equal(direct.authenticated, false);
        assert.equal(direct.status, 401);
    });

    it('連結金鑰打 /systems*（人主體路由）→ 被拒（它不是 LIFF token）', async () => {
        const { link } = await fullLink();
        globalThis.fetch = async () => new Response('{}', { status: 401 });
        const e = { ...env, AUTH_MODE: undefined, LIFF_CHANNEL_ID: '123' };
        for (const [m, path] of [['GET', '/bridge/v1/systems'], ['POST', '/bridge/v1/systems'], ['DELETE', '/bridge/v1/systems/imgpicker'], ['POST', '/bridge/v1/systems/imgpicker/keys/rotate']]) {
            const r = await call(m, path, { headers: bearer(link.service_key, { 'X-Bot-Id': BOT }), e, body: m === 'POST' ? { system: 'abc', name: 'n' } : undefined });
            assert.equal(r.res.status, 401, `${m} ${path}`);
        }
        assert.equal(await count(d1.db, 'systems'), 0);
    });

    it('系統金鑰打連結端點 → INVALID_KEY（與不存在的金鑰回應相同），什麼都沒被動到', async () => {
        const { link } = await fullLink();
        await withSystemKey();
        for (const [m, suffix] of [['GET', ''], ['DELETE', ''], ['POST', '/rotate-key']]) {
            const r = await linkCall(m, SYSTEM_KEY, link.link_id, suffix);
            const ghost = await linkCall(m, 'brk_000000_nope', link.link_id, suffix);
            assert.equal(r.res.status, 401, `${m}${suffix}`);
            assert.equal(errCode(r), 'INVALID_KEY');
            assert.deepEqual(r.body, ghost.body);
        }
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 2);
    });

    it('系統金鑰就算帶 link:manage scope 也不能呼叫連結端點（link_id 為空）', async () => {
        const { link } = await fullLink();
        await withSystemKey(['link:manage', 'raw:push']);
        assert.equal(errCode(await linkCall('DELETE', SYSTEM_KEY, link.link_id)), 'INVALID_KEY');
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
    });

    it('既有系統金鑰仍可正常打 /raw/*（認證通過，行為不變）', async () => {
        await withSystemKey();
        const r = await authenticateBridge(new Request(`${ORIGIN}/bridge/v1/raw/push`, { method: 'POST', headers: bearer(SYSTEM_KEY, { 'X-Bot-Id': BOT }) }), env);
        assert.equal(r.authenticated, true);
        assert.equal(r.principal.system, 'imgpicker');
    });

    it('系統金鑰不能呼叫連結流程的人主體／產品密鑰端點', async () => {
        await withSystemKey();
        const p = await registerProduct();
        const r1 = await call('POST', '/bridge/v1/links/token', { headers: bearer(SYSTEM_KEY), body: { code: `lmc_${'A'.repeat(43)}`, redirect_uri: URI } });
        assert.equal(r1.res.status, 401);
        const r2 = await call('POST', '/bridge/v1/admin/products', { headers: bearer(SYSTEM_KEY), body: { name: 'x', redirect_uris: [URI], scopes: ALL_SCOPES } });
        assert.equal(r2.res.status, 401);
        assert.equal(await count(d1.db, 'products'), 1);
        assert.ok(p);
    });
});

// ───────────────────────── 連結流程永遠不發 raw:push ─────────────────────────

describe('連結流程永遠不能發出 raw:push／messages:push', () => {
    it('完整流程（核發、交換、輪替、重新授權）後，資料庫與所有回應裡都沒有這兩個 scope', async () => {
        const first = await fullLink();
        await linkCall('POST', first.link.service_key, first.link.link_id, '/rotate-key');
        const { code } = codeFrom(await approve(first.p));
        await exchange(first.p, code);
        for (const [table, col] of [['products', 'scopes'], ['links', 'scopes'], ['auth_codes', 'scopes'], ['service_keys', 'scopes']]) {
            for (const row of await all(d1.db, `SELECT ${col} AS s FROM ${table}`)) {
                for (const s of JSON.parse(row.s)) assert.ok(LINK_SCOPES.includes(s), `${table}: ${s}`);
            }
        }
        for (const text of seen) assert.doesNotMatch(text, /raw:push|messages:push/);
        assert.doesNotMatch(JSON.stringify(await all(d1.db, 'SELECT detail FROM audit_log')), /raw:push|messages:push/);
    });

    it('產品登記資料被竄改成含 raw:push／messages:push，核發與交換出來的 scope 仍只含連結 scope', async () => {
        const p = await registerProduct();
        await d1.db.prepare(`UPDATE products SET scopes = '["raw:push","messages:push","link:manage","messages:send"]'`).run();
        const { code } = codeFrom(await approve(p));
        const r = await exchange(p, code);
        assert.deepEqual(r.body.scopes, ['link:manage', 'messages:send']);
        const keyScopes = JSON.parse((await all(d1.db, 'SELECT scopes FROM service_keys'))[0].scopes);
        assert.deepEqual(keyScopes, ['link:manage', 'messages:send']);
    });

    it('認證層把 principal.scopes 過濾成連結 scope：資料庫被寫入 raw:push 也不會被當成權限', async () => {
        const { link } = await fullLink();
        await d1.db.prepare(`UPDATE service_keys SET scopes = '["link:manage","raw:push","messages:push"]'`).run();
        await d1.db.prepare(`UPDATE links SET scopes = '["link:manage","raw:push","messages:push"]'`).run();
        const { authenticateLink } = await import('../../worker_src/bridge/auth.js');
        const ok = await authenticateLink(new Request(ORIGIN, { headers: bearer(link.service_key) }), env, 'link:manage');
        assert.deepEqual(ok.principal.scopes, ['link:manage']);
        for (const s of FORBIDDEN_LINK_SCOPES) {
            const denied = await authenticateLink(new Request(ORIGIN, { headers: bearer(link.service_key) }), env, s);
            assert.equal(denied.authenticated, false, s);
            assert.equal(denied.response.status, 403);
        }
    });
});

// ───────────────────────── 後台（人主體 + owner） ─────────────────────────

describe('GET /admin/links 與 DELETE /admin/links/{id}', () => {
    const list = (user, bot = BOT, extra = {}) => call('GET', '/bridge/v1/admin/links', { headers: asUser(user, bot ? { 'X-Bot-Id': bot, ...extra } : extra) });
    const del = (user, linkId, bot = BOT) => call('DELETE', `/bridge/v1/admin/links/${linkId}`, { headers: asUser(user, bot ? { 'X-Bot-Id': bot } : {}) });

    it('沒登入 → 401', async () => {
        assert.equal((await call('GET', '/bridge/v1/admin/links', { headers: { 'X-Bot-Id': BOT } })).res.status, 401);
        assert.equal((await call('DELETE', '/bridge/v1/admin/links/lnk_0000000000000000', { headers: { 'X-Bot-Id': BOT } })).res.status, 401);
    });

    it('列出這個 bot 的連結（含已撤銷），不含金鑰、授權碼、雜湊；產品名稱原樣', async () => {
        const first = await fullLink();
        const { code } = codeFrom(await approve(first.p));
        const second = (await exchange(first.p, code)).body;
        const r = await list(OWNER);
        assert.equal(r.res.status, 200);
        assert.deepEqual(r.body.links.map((l) => [l.link_id, l.status]), [[second.link_id, 'active'], [first.link.link_id, 'revoked']]);
        const l = r.body.links[0];
        assert.deepEqual(Object.keys(l).sort(), ['created_at', 'link_id', 'product_id', 'product_key', 'product_name', 'revoked_at', 'scopes', 'status']);
        assert.equal(l.product_name, 'Image Picker');
        assert.deepEqual(l.scopes, ALL_SCOPES);
        assert.doesNotMatch(r.text, /brk_|lmc_|bps_|key_hash|secret/);
    });

    it('只看得到自己 bot 的連結（別的 bot 的不會出現）', async () => {
        const a = await fullLink({ bot: BOT, user: OWNER });
        const { code } = codeFrom(await approve(a.p, { user: OWNER2, bot: BOT2 }));
        const b = (await exchange(a.p, code)).body;
        assert.deepEqual((await list(OWNER, BOT)).body.links.map((l) => l.link_id), [a.link.link_id]);
        assert.deepEqual((await list(OWNER2, BOT2)).body.links.map((l) => l.link_id), [b.link_id]);
    });

    it('不是該 bot 的 owner（陌生人、member、別的 owner）→ 404；不存在的 bot 回應相同', async () => {
        const a = await fullLink();
        const rs = [await list(MEMBER), await list(OWNER2, BOT), await list(OWNER, 'Unotexist00000000000000000000009')];
        for (const r of rs) {
            assert.equal(r.res.status, 404);
            assert.deepEqual(r.body, rs[0].body);
        }
        assert.doesNotMatch(JSON.stringify(rs), new RegExp(a.link.link_id));
    });

    it('沒給 bot → 400；也可用 ?bot_id=', async () => {
        assert.equal((await call('GET', '/bridge/v1/admin/links', { headers: asUser(OWNER) })).res.status, 400);
        const r = await call('GET', `/bridge/v1/admin/links?bot_id=${BOT}`, { headers: asUser(OWNER) });
        assert.equal(r.res.status, 200);
    });

    it('DELETE：撤銷後舊金鑰立即 LINK_REVOKED；稽核由 user 記；再撤銷一次仍 204（冪等）', async () => {
        const { p, link } = await fullLink();
        const r = await del(OWNER, link.link_id);
        assert.equal(r.res.status, 204);
        assert.equal(errCode(await linkCall('GET', link.service_key, link.link_id)), 'LINK_REVOKED');
        const audit = await all(d1.db, "SELECT actor_type, actor_id, bot_id, detail FROM audit_log WHERE action = 'link_revoked'");
        assert.deepEqual(audit.map((a) => [a.actor_type, a.actor_id, a.bot_id, JSON.parse(a.detail)]), [['user', OWNER, BOT, { product_id: p.product_id, link_id: link.link_id }]]);
        assert.equal((await del(OWNER, link.link_id)).res.status, 204);
        assert.equal(await count(d1.db, 'audit_log', "action = 'link_revoked'"), 1, '冪等的第二次不重複記稽核');
    });

    it('DELETE：別的 bot 的連結（即使自己是另一個 bot 的 owner）→ 404，且沒被撤銷', async () => {
        const a = await fullLink({ bot: BOT, user: OWNER });
        const cross = await del(OWNER2, a.link.link_id, BOT2);
        const ghost = await del(OWNER2, 'lnk_0000000000000000', BOT2);
        assert.equal(cross.res.status, 404);
        assert.deepEqual(cross.body, ghost.body);
        assert.equal((await linkCall('GET', a.link.service_key, a.link.link_id)).res.status, 200);
    });

    it('DELETE：非 owner → 404；亂格式的 id → 404', async () => {
        const { link } = await fullLink();
        assert.equal((await del(MEMBER, link.link_id)).res.status, 404);
        assert.equal((await del(OWNER2, link.link_id, BOT)).res.status, 404);
        assert.equal((await del(OWNER, 'x')).res.status, 404);
        assert.equal((await del(OWNER, '%E0%A4%A')).res.status, 404);
        assert.equal((await linkCall('GET', link.service_key, link.link_id)).res.status, 200);
    });

    it('撤銷後可以重新授權取得新連結', async () => {
        const first = await fullLink();
        await del(OWNER, first.link.link_id);
        const { code } = codeFrom(await approve(first.p));
        const second = await exchange(first.p, code);
        assert.equal(second.res.status, 200);
        assert.equal((await linkCall('GET', second.body.service_key, second.body.link_id)).res.status, 200);
    });
});

// ───────────────────────── 旗標、binding、掃描 ─────────────────────────

describe('BRIDGE_ENABLED 關閉 → 全部 404（舊格式，與未知路由相同），不認證、不碰 KV／D1', () => {
    it('每個連結流程端點都是', async () => {
        const p = await registerProduct();
        let dbCalls = 0;
        const spy = { prepare: (...a) => { dbCalls++; return d1.db.prepare(...a); }, batch: (...a) => { dbCalls++; return d1.db.batch(...a); } };
        const kvBefore = kv._ops.total;
        for (const v of [undefined, '0', 'true', '']) {
            const e = { ...env, BRIDGE_ENABLED: v, BRIDGE_DB: spy };
            for (const [m, path] of [
                ['POST', '/bridge/v1/admin/products'],
                ['GET', `/bridge/v1/link/authorize?${q(authParams(p))}`],
                ['GET', `/bridge/v1/link/authorize/preview?${q(authParams(p))}`],
                ['POST', '/bridge/v1/link/authorize/approve'],
                ['POST', '/bridge/v1/links/token'],
                ['GET', '/bridge/v1/links/lnk_0000000000000000'],
                ['DELETE', '/bridge/v1/links/lnk_0000000000000000'],
                ['POST', '/bridge/v1/links/lnk_0000000000000000/rotate-key'],
                ['GET', '/bridge/v1/admin/links'],
                ['DELETE', '/bridge/v1/admin/links/lnk_0000000000000000'],
            ]) {
                const r = await call(m, path, { headers: { ...bearer(ADMIN), ...asUser(OWNER), 'X-Bot-Id': BOT }, e, body: m === 'POST' ? {} : undefined });
                assert.equal(r.res.status, 404, `${m} ${path}`);
                assert.deepEqual(r.body, NOT_FOUND_LEGACY);
            }
        }
        assert.equal(dbCalls, 0);
        assert.equal(kv._ops.total, kvBefore);
    });
});

describe('缺 BRIDGE_DB 綁定 → 503（新格式），不退回 KV', () => {
    it('每個需要資料庫的端點', async () => {
        const p = await registerProduct();
        const { link } = await fullLink();
        const e = { ...env, BRIDGE_DB: undefined };
        const cases = [
            ['POST', '/bridge/v1/admin/products', { headers: bearer(ADMIN), body: { name: 'x', redirect_uris: [URI], scopes: ALL_SCOPES } }],
            ['GET', `/bridge/v1/link/authorize?${q(authParams(p))}`, {}],
            ['GET', `/bridge/v1/link/authorize/preview?${q(authParams(p))}`, { headers: asUser(OWNER) }],
            ['POST', '/bridge/v1/link/authorize/approve', { headers: asUser(OWNER), body: { ...authParams(p), bot_id: BOT } }],
            ['POST', '/bridge/v1/links/token', { headers: bearer(p.product_secret), body: { code: `lmc_${'A'.repeat(43)}`, redirect_uri: URI } }],
            ['GET', `/bridge/v1/links/${link.link_id}`, { headers: bearer(link.service_key) }],
            ['DELETE', `/bridge/v1/links/${link.link_id}`, { headers: bearer(link.service_key) }],
            ['POST', `/bridge/v1/links/${link.link_id}/rotate-key`, { headers: bearer(link.service_key) }],
            ['GET', '/bridge/v1/admin/links', { headers: asUser(OWNER, { 'X-Bot-Id': BOT }) }],
            ['DELETE', `/bridge/v1/admin/links/${link.link_id}`, { headers: asUser(OWNER, { 'X-Bot-Id': BOT }) }],
        ];
        for (const [m, path, opts] of cases) {
            const r = await call(m, path, { ...opts, e });
            assert.equal(r.res.status, 503, `${m} ${path}`);
            assert.equal(errCode(r), 'INTERNAL');
            assert.equal(r.body.error.message, 'bridge_not_configured');
            assert.equal(r.body.error.retryable, true);
        }
    });

    it('資料庫壞掉（缺表）也是 503，不洩漏 SQL 細節，不含 stack', async () => {
        const p = await registerProduct();
        await d1.db.prepare('ALTER TABLE auth_codes RENAME TO auth_codes_hidden').run();
        try {
            const r = await approve(p);
            assert.equal(r.res.status, 503);
            assert.doesNotMatch(r.text, /auth_codes|SQLITE|no such table|\n\s+at /);
        } finally {
            await d1.db.prepare('ALTER TABLE auth_codes_hidden RENAME TO auth_codes').run();
        }
    });
});

describe('回應與稽核不含授權碼、金鑰、雜湊、產品密鑰', () => {
    it('走完整流程後掃描所有回應文字與 audit_log', async () => {
        const first = await fullLink();
        const rotated = (await linkCall('POST', first.link.service_key, first.link.link_id, '/rotate-key')).body.service_key;
        await linkCall('GET', rotated, first.link.link_id);
        const { code: code2 } = codeFrom(await approve(first.p));
        await exchange(first.p, code2);
        await exchange(first.p, code2); // 失敗一次，產生 code_exchange_failed
        await exchange(first.p, null, { secret: `bps_${first.p.product_id.slice(4)}_${'A'.repeat(43)}` });
        await linkCall('DELETE', rotated, first.link.link_id);

        const secrets = [first.code, code2, first.link.service_key, rotated, first.p.product_secret, ADMIN];
        const hashes = [];
        for (const s of secrets) hashes.push(await sha256Hex(s));
        const audit = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        assert.ok(JSON.parse(audit).length >= 6, '有稽核紀錄可掃');

        // 授權碼、連結金鑰、產品密鑰只允許出現在「該發給誰」的那一個回應裡；稽核裡一個都不能有
        for (const s of secrets) assert.ok(!audit.includes(s), '稽核含敏感值');
        for (const h of hashes) assert.ok(!audit.includes(h), '稽核含雜湊');
        // 任何回應都不含雜湊、營運密鑰
        const all_ = seen.join('\n');
        for (const h of hashes) assert.ok(!all_.includes(h), '回應含雜湊');
        assert.ok(!all_.includes(ADMIN));
        assert.doesNotMatch(all_, /secret_hash|key_hash|code_hash|\n\s+at /);
    });

    it('授權碼原文只出現在 approve 的回應；金鑰原文只出現在 token／rotate-key 的回應', async () => {
        const p = await registerProduct();
        const approveRes = await approve(p);
        const { code } = codeFrom(approveRes);
        const tokenRes = await exchange(p, code);
        const key = tokenRes.body.service_key;
        const rotateRes = await linkCall('POST', key, tokenRes.body.link_id, '/rotate-key');
        const holders = (needle) => seen.filter((t) => t.includes(needle));
        assert.deepEqual(holders(code), [approveRes.text]);
        assert.deepEqual(holders(key), [tokenRes.text]);
        assert.deepEqual(holders(rotateRes.body.service_key), [rotateRes.text]);
        assert.deepEqual(holders(p.product_secret), [seen[0]], '產品密鑰只出現在登記回應');
    });
});

describe('路由分類與小工具', () => {
    it('isLinkRoute：admin／link／links 三個根（以「段」為單位）', () => {
        for (const p of ['/bridge/v1/admin', '/bridge/v1/admin/products', '/bridge/v1/admin/links/x', '/bridge/v1/link', '/bridge/v1/link/authorize', '/bridge/v1/links', '/bridge/v1/links/token', '/bridge/v1/links/lnk_x/rotate-key']) {
            assert.equal(isLinkRoute(p), true, p);
            assert.equal(isBridgeServiceRoute(p), false, p);
        }
        for (const p of ['/bridge/v1/linksX', '/bridge/v1/linkage', '/bridge/v1/administrator', '/bridge/v1/raw/push', '/bridge/v1/systems', '/bridge/v1/health', '/api/link/authorize', undefined, null]) {
            assert.equal(isLinkRoute(p), false, String(p));
        }
        assert.equal(isBridgeServiceRoute('/bridge/v1/raw/push'), true);
    });

    it('mountPrefix 與 lib/mount.js 的 normalizeMount 規則一致', async () => {
        const { normalizeMount } = await import('../../worker_src/lib/mount.js');
        for (const v of [undefined, null, 5, '', ' ', '/', '/lm', '/lm/', 'lm', ' /lm ', '/a/b/', 'a']) {
            assert.equal(mountPrefix({ MOUNT_PATH: v }), normalizeMount(v), JSON.stringify(v));
        }
        assert.equal(mountPrefix(undefined), '');
    });
});
