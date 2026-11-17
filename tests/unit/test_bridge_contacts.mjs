/**
 * Unit Tests — bridge/contacts.js（LM-3A 聯絡人綁定端點，端到端經 handleBridge，真 D1）
 *
 *   POST /bridge/v1/contacts/bind-tokens · GET|DELETE /bridge/v1/contacts/{external_contact_ref}
 *
 * 安全性質：連結金鑰＋contacts:bind（系統金鑰、無 scope、撤銷連結都擋下）；ref 只在「金鑰所屬連結」範圍內可見；
 * 回應與 audit 不含 LINE userId，audit 也不含 ref 與碼；DELETE 冪等；缺 BRIDGE_DB → 503；旗標關閉 → 404。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedLink, seedSystem, seedKey, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import { isContactsRoute, isLinkRoute, isBridgeServiceRoute, isSystemsRoute } from '../../worker_src/bridge/routes.js';
import { buildBindUrl, deriveContactStatus, CONTACT_REF_RE } from '../../worker_src/bridge/contacts.js';
import { tryConsumeBindCode, markBlocked, BIND_CODE_TTL_MS } from '../../worker_src/bridge/binding.js';
import { ERROR_CODES } from '../../worker_src/bridge/errors.js';

const ORIGIN = 'https://worker.example.com';
const OWNER = 'Uowner0000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const LNK_A = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const PRD_A = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const SYS_KEY = 'brk_cccccc_system-key-0000000000000000000000000';
const LINE_USER = 'Uline0000000000000000000000000001';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const BIND_URL_BASE = 'https://line.me/R/oaMessage/';

let d1;
let env;
let kv;
let seen;
let basicIdResponse;
const originalError = console.error;
const originalFetch = globalThis.fetch;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1' };
    seen = [];
    console.error = () => {};
    basicIdResponse = () => new Response(JSON.stringify({ userId: BOT, basicId: '@123abcde', displayName: 'Shop' }), { status: 200 });
    globalThis.fetch = async (url) => {
        if (String(url) === 'https://api.line.me/v2/bot/info') return basicIdResponse();
        throw new Error(`unexpected fetch ${url}`);
    };
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: 'TOKEN_X', destination: BOT } }));
    await seedLink(d1.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A });
    await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT2, key: KEY_B });
});
afterEach(() => { console.error = originalError; globalThis.fetch = originalFetch; });

async function call(method, path, { key, headers = {}, body, raw, e = env } = {}) {
    const init = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } };
    if (body !== undefined) {
        init.body = raw ? body : JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), e, url.pathname);
    const text = await res.text();
    seen.push(text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 204 或非 JSON */ }
    return { res, text, body: parsed };
}

const errCode = (r) => r.body && r.body.error && r.body.error.code;
const issue = (ref = REF, key = KEY_A) => call('POST', '/bridge/v1/contacts/bind-tokens', { key, body: { external_contact_ref: ref } });
const status = (ref = REF, key = KEY_A) => call('GET', `/bridge/v1/contacts/${ref}`, { key });
const bindVia = async (code, { botId = BOT, userId = LINE_USER } = {}) => tryConsumeBindCode(env, { botId, lineUserId: userId, text: code });

// ───────────────────────── 路由分類 ─────────────────────────

describe('路由分類', () => {
    it('/bridge/v1/contacts 與子路徑是 contacts 路由，不是 service key 路由、不是 systems、也不屬於 links.js', () => {
        for (const p of ['/bridge/v1/contacts', '/bridge/v1/contacts/bind-tokens', `/bridge/v1/contacts/${REF}`]) {
            assert.equal(isContactsRoute(p), true, p);
            assert.equal(isBridgeServiceRoute(p), false, p);
            assert.equal(isSystemsRoute(p), false, p);
            assert.equal(isLinkRoute(p), false, p);
        }
        for (const p of ['/bridge/v1/contactsX', '/bridge/v1/contact/x', '/bridge/v1/raw/push', '/bridge/v1/messages']) {
            assert.equal(isContactsRoute(p), false, p);
        }
        assert.equal(isBridgeServiceRoute('/bridge/v1/contactsX'), true); // 未知路徑仍走 service key 認證 → 最後 404
    });

    it('連結金鑰通不過 /raw/*（仍是 401），也不會因為多了 contacts 路由而變成可用', async () => {
        const r = await call('POST', '/bridge/v1/raw/push', { key: KEY_A, headers: { 'X-Bot-Id': BOT }, body: { to: 'U1', messages: [] } });
        assert.equal(r.res.status, 401);
        assert.deepEqual(r.body, { success: false, error: 'Invalid or revoked service key' });
        const s = await call('GET', '/bridge/v1/systems', { key: KEY_A, headers: { 'X-Bot-Id': BOT } });
        assert.equal(s.res.status, 401);
    });
});

// ───────────────────────── 認證 ─────────────────────────

describe('認證與 scope', () => {
    const endpoints = [
        ['POST', '/bridge/v1/contacts/bind-tokens', { external_contact_ref: REF }],
        ['GET', `/bridge/v1/contacts/${REF}`, undefined],
        ['DELETE', `/bridge/v1/contacts/${REF}`, undefined],
    ];

    it('沒有金鑰 / 亂金鑰 → 401 INVALID_KEY（bridgeError 格式）', async () => {
        for (const [m, p, body] of endpoints) {
            for (const key of [undefined, 'brk_nope', '']) {
                const r = await call(m, p, { key, body });
                assert.equal(r.res.status, 401, `${m} ${p}`);
                assert.equal(errCode(r), 'INVALID_KEY');
                assert.equal(r.body.error.retryable, false);
            }
        }
    });

    it('系統金鑰（無 link_id）→ INVALID_KEY，與其他連結端點相同', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', scopes: ['raw:push'] });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYS_KEY, scopes: ['raw:push', 'contacts:bind'] });
        for (const [m, p, body] of endpoints) {
            const r = await call(m, p, { key: SYS_KEY, headers: { 'X-Bot-Id': BOT }, body });
            assert.equal(r.res.status, 401);
            assert.equal(errCode(r), 'INVALID_KEY');
        }
    });

    it('連結沒有 contacts:bind scope → 403 SCOPE_DENIED', async () => {
        await seedLink(d1.db, { linkId: 'lnk_cccccccccccccccc', productId: 'prd_cccccccccccc', botId: BOT, key: 'brk_noscope', scopes: ['link:manage', 'messages:send'] });
        for (const [m, p, body] of endpoints) {
            const r = await call(m, p, { key: 'brk_noscope', body });
            assert.equal(r.res.status, 403);
            assert.equal(errCode(r), 'SCOPE_DENIED');
        }
    });

    it('連結已撤銷、產品停用 → 403 LINK_REVOKED', async () => {
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK_A).run();
        await d1.db.prepare('UPDATE products SET disabled = 1 WHERE product_id = ?1').bind(PRD_B).run();
        for (const [m, p, body] of endpoints) {
            for (const key of [KEY_A, KEY_B]) {
                const r = await call(m, p, { key, body });
                assert.equal(r.res.status, 403);
                assert.equal(errCode(r), 'LINK_REVOKED');
            }
        }
    });

    it('旗標關閉 → 與未知路由相同的 404（不認證、不碰 D1）', async () => {
        for (const flag of [undefined, '0', 'true']) {
            const r = await call('POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: { external_contact_ref: REF }, e: { ...env, BRIDGE_ENABLED: flag } });
            assert.equal(r.res.status, 404);
            assert.deepEqual(r.body, { success: false, error: 'Not Found' });
        }
        assert.equal(await count(d1.db, 'bind_codes'), 0);
    });

    it('缺 BRIDGE_DB → 503 INTERNAL bridge_not_configured', async () => {
        const r = await call('GET', `/bridge/v1/contacts/${REF}`, { key: KEY_A, e: { ...env, BRIDGE_DB: undefined } });
        assert.equal(r.res.status, 503);
        assert.equal(errCode(r), 'INTERNAL');
    });

    it('路徑與方法：未知路徑、不允許的方法 → 404 NOT_FOUND（bridgeError 格式）', async () => {
        for (const [m, p] of [
            ['GET', '/bridge/v1/contacts'], ['GET', '/bridge/v1/contacts/'], ['GET', '/bridge/v1/contacts/bind-tokens'],
            ['DELETE', '/bridge/v1/contacts/bind-tokens'], ['PUT', `/bridge/v1/contacts/${REF}`], ['POST', `/bridge/v1/contacts/${REF}`],
            ['GET', `/bridge/v1/contacts/${REF}/extra`], ['POST', '/bridge/v1/contacts/bind-tokens/extra'],
        ]) {
            const r = await call(m, p, { key: KEY_A });
            assert.equal(r.res.status, 404, `${m} ${p}`);
            assert.equal(errCode(r), 'NOT_FOUND');
        }
        assert.equal(await count(d1.db, 'bind_codes'), 0);
    });
});

// ───────────────────────── POST bind-tokens ─────────────────────────

describe('POST /contacts/bind-tokens', () => {
    it('201 {bind_code, bind_url, expires_at}；碼格式正確、7 天後過期、bind_url 帶完整碼', async () => {
        const before = Date.now();
        const r = await issue();
        assert.equal(r.res.status, 201);
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(Object.keys(r.body).sort(), ['bind_code', 'bind_url', 'expires_at']);
        assert.match(r.body.bind_code, /^LM-[0-9A-HJKMNP-TV-Z]{8}$/);
        assert.equal(r.body.bind_url, `${BIND_URL_BASE}@123abcde/?${r.body.bind_code}`);
        const exp = Date.parse(r.body.expires_at);
        assert.equal(new Date(exp).toISOString(), r.body.expires_at);
        assert.ok(exp >= before + BIND_CODE_TTL_MS && exp <= Date.now() + BIND_CODE_TTL_MS);
    });

    it('資料庫只存雜湊：沒有明文碼，也沒有 line_user_id', async () => {
        const r = await issue();
        const rows = await all(d1.db, 'SELECT * FROM bind_codes');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].code_hash, await sha256Hex(r.body.bind_code));
        assert.equal(rows[0].link_id, LNK_A);
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].external_contact_ref, REF);
        assert.equal(rows[0].used_at, null);
        assert.ok(!JSON.stringify(rows).includes(r.body.bind_code));
    });

    it('用該 bot owner 的 token 取 basic ID', async () => {
        const urls = [];
        globalThis.fetch = async (url, init) => { urls.push([String(url), init.headers.Authorization]); return basicIdResponse(); };
        await issue();
        assert.deepEqual(urls, [['https://api.line.me/v2/bot/info', 'Bearer TOKEN_X']]);
    });

    it('取不到 basic ID（LINE 失敗、沒有欄位、格式怪異、沒有 token）→ bind_url 為 null，其他欄位照常', async () => {
        for (const impl of [
            () => new Response('boom', { status: 500 }),
            () => new Response(JSON.stringify({ userId: BOT }), { status: 200 }),
            () => new Response(JSON.stringify({ basicId: '@bad id/../x' }), { status: 200 }),
            () => new Response(JSON.stringify({ basicId: '@' }), { status: 200 }),
            () => { throw new Error('network'); },
        ]) {
            basicIdResponse = impl;
            const r = await issue();
            assert.equal(r.res.status, 201);
            assert.equal(r.body.bind_url, null);
            assert.match(r.body.bind_code, /^LM-/);
        }
        await kv.delete(BotKeys.owner(BOT));
        const r = await issue();
        assert.equal(r.res.status, 201);
        assert.equal(r.body.bind_url, null);
    });

    it('buildBindUrl：@ 留在路徑、其餘字元編碼；沒有 @ 前綴時補上；格式不合 → null', () => {
        assert.equal(buildBindUrl('@123abcde', 'LM-ABCD2345'), 'https://line.me/R/oaMessage/@123abcde/?LM-ABCD2345');
        assert.equal(buildBindUrl('123abcde', 'LM-ABCD2345'), 'https://line.me/R/oaMessage/@123abcde/?LM-ABCD2345');
        assert.equal(buildBindUrl('@my.shop_1-a', 'LM-ABCD2345'), 'https://line.me/R/oaMessage/@my.shop_1-a/?LM-ABCD2345');
        for (const bad of [null, undefined, '', '@', 'a b', '@a/b', '@a?b', '@a#b', '@a%40b', '@' + 'x'.repeat(65), 5]) {
            assert.equal(buildBindUrl(bad, 'LM-ABCD2345'), null, String(bad));
        }
    });

    it('external_contact_ref 不合法 → 400 INVALID_REQUEST，不寫入任何東西', async () => {
        for (const ref of [undefined, null, '', 'short', 'a'.repeat(65), 'has space1', 'bad/slash1', 'pct%20encoded', '中文名稱中文名稱', 12345678, ['customer-0001'], { a: 1 }]) {
            const r = await call('POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: { external_contact_ref: ref } });
            assert.equal(r.res.status, 400, JSON.stringify(ref));
            assert.equal(errCode(r), 'INVALID_REQUEST');
        }
        for (const raw of ['{oops', '[]', 'null', '"x"']) {
            const r = await call('POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: raw, raw: true });
            assert.equal(r.res.status, 400);
            assert.equal(errCode(r), 'INVALID_REQUEST');
        }
        assert.equal(await count(d1.db, 'bind_codes'), 0);
        assert.equal(CONTACT_REF_RE.test('a'.repeat(8)) && CONTACT_REF_RE.test('a'.repeat(64)), true);
    });

    it('同 (連結, ref) 再要一次碼 → 舊碼作廢、只留新碼；其他 ref 不受影響', async () => {
        const first = await issue(REF);
        const other = await issue(REF2);
        const second = await issue(REF);
        assert.notEqual(first.body.bind_code, second.body.bind_code);
        assert.equal(await count(d1.db, 'bind_codes'), 2);
        assert.equal((await bindVia(first.body.bind_code)).handled, false);
        assert.equal((await bindVia(other.body.bind_code, { userId: 'Uother000000000000000000000000001' })).handled, true);
        assert.equal((await bindVia(second.body.bind_code)).handled, true);
    });

    it('每連結限流：1 分鐘 30 次，第 31 次 429 RATE_LIMITED + Retry-After；其他連結不受影響', async () => {
        // 固定視窗限流：把時間釘在視窗中段，避免 31 次請求跨過整分鐘邊界而偶發失敗（CI 曾因此紅燈）
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            for (let i = 0; i < 30; i++) assert.equal((await issue(`customer-${String(i).padStart(4, '0')}`)).res.status, 201);
            const r = await issue('customer-9999');
            assert.equal(r.res.status, 429);
            assert.equal(errCode(r), 'RATE_LIMITED');
            assert.ok(Number(r.res.headers.get('Retry-After')) >= 1);
            assert.equal((await issue(REF, KEY_B)).res.status, 201);
        } finally {
            Date.now = realNow;
        }
    });

    it('每連結有效未用碼上限 1000：超過回 429 RATE_LIMITED，既有 ref 仍可換新碼', async () => {
        await d1.db.prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
             INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at)
             SELECT 'seed' || i, ?1, ?2, 'seeded-' || i, 1, ?3 FROM n`
        ).bind(LNK_A, BOT, Date.now() + 1e9).run();
        assert.equal(await count(d1.db, 'bind_codes'), 1000);
        const r = await issue('brand-new-ref');
        assert.equal(r.res.status, 429);
        assert.equal(errCode(r), 'RATE_LIMITED');
        assert.equal(await count(d1.db, 'bind_codes'), 1000);
        assert.equal((await issue('seeded-5')).res.status, 201); // 已有碼的 ref：換新碼
        assert.equal(await count(d1.db, 'bind_codes'), 1000);
        assert.equal((await issue('brand-new-ref', KEY_B)).res.status, 201); // 別條連結不受影響
    });

    it('audit contact_bind_token_created：actor 是連結，detail 只有 product_id 與 link_id', async () => {
        const r = await issue();
        const rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'contact_bind_token_created'");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].actor_type, 'service_key');
        assert.equal(rows[0].actor_id, LNK_A);
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].result, 'ok');
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: PRD_A, link_id: LNK_A });
        const dump = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        for (const secret of [REF, r.body.bind_code, await sha256Hex(r.body.bind_code), KEY_A, await sha256Hex(KEY_A)]) {
            assert.ok(!dump.includes(secret));
        }
    });

    it('D1 查詢失敗 → 503 INTERNAL，且沒有 stack', async () => {
        await d1.db.prepare('ALTER TABLE bind_codes RENAME TO bind_codes_hidden').run();
        try {
            const r = await issue();
            assert.equal(r.res.status, 503);
            assert.equal(errCode(r), 'INTERNAL');
            assert.doesNotMatch(r.text, /stack|at .*\.js/i);
        } finally {
            await d1.db.prepare('ALTER TABLE bind_codes_hidden RENAME TO bind_codes').run();
        }
    });
});

// ───────────────────────── GET 狀態 ─────────────────────────

describe('GET /contacts/{ref}：狀態推導', () => {
    it('unbound → pending → bound → blocked → bound（follow 還原）', async () => {
        let r = await status();
        assert.equal(r.res.status, 200);
        assert.deepEqual(r.body, { external_contact_ref: REF, status: 'unbound', bound_at: null });

        const issued = await issue();
        r = await status();
        assert.deepEqual(r.body, { external_contact_ref: REF, status: 'pending', bound_at: null });

        const t0 = Date.now();
        assert.equal((await bindVia(issued.body.bind_code)).handled, true);
        r = await status();
        assert.equal(r.body.status, 'bound');
        assert.equal(r.body.external_contact_ref, REF);
        const boundAt = Date.parse(r.body.bound_at);
        assert.ok(boundAt >= t0 && boundAt <= Date.now());
        assert.equal(new Date(boundAt).toISOString(), r.body.bound_at);

        await markBlocked(env, { botId: BOT, lineUserId: LINE_USER });
        r = await status();
        assert.equal(r.body.status, 'blocked');
        assert.equal(r.body.bound_at, new Date(boundAt).toISOString()); // bound_at 不因封鎖而改變

        const { restoreFollow } = await import('../../worker_src/bridge/binding.js');
        await restoreFollow(env, { botId: BOT, lineUserId: LINE_USER });
        assert.equal((await status()).body.status, 'bound');
    });

    it('已綁定後又要新碼 → 仍是 bound（有列優先於 pending）', async () => {
        await bindVia((await issue()).body.bind_code);
        await issue();
        assert.equal((await status()).body.status, 'bound');
    });

    it('待用碼過期後 pending 變回 unbound', async () => {
        await issue();
        await d1.db.prepare('UPDATE bind_codes SET expires_at = 1').run();
        assert.equal((await status()).body.status, 'unbound');
    });

    it('deriveContactStatus：五種狀態（含 disabled）', () => {
        const base = { linkStatus: 'active', productDisabled: false, contact: null, hasPendingCode: false };
        assert.equal(deriveContactStatus(base), 'unbound');
        assert.equal(deriveContactStatus({ ...base, hasPendingCode: true }), 'pending');
        assert.equal(deriveContactStatus({ ...base, contact: { status: 'bound' } }), 'bound');
        assert.equal(deriveContactStatus({ ...base, contact: { status: 'bound' }, hasPendingCode: true }), 'bound');
        assert.equal(deriveContactStatus({ ...base, contact: { status: 'blocked' } }), 'blocked');
        assert.equal(deriveContactStatus({ ...base, linkStatus: 'revoked', contact: { status: 'bound' } }), 'disabled');
        assert.equal(deriveContactStatus({ ...base, productDisabled: true, contact: { status: 'blocked' }, hasPendingCode: true }), 'disabled');
        assert.equal(deriveContactStatus(null), 'disabled');
    });

    it('連結撤銷 → 綁定資料還在（不逐列改寫），但金鑰立即 LINK_REVOKED；資料層的狀態是 disabled', async () => {
        await bindVia((await issue()).body.bind_code);
        await d1.db.prepare("UPDATE links SET status = 'revoked', revoked_at = 9 WHERE link_id = ?1").bind(LNK_A).run();
        assert.equal(errCode(await status()), 'LINK_REVOKED');
        assert.equal(await count(d1.db, 'contacts', "status = 'bound'"), 1);
        const { getContactSnapshot } = await import('../../worker_src/bridge/db.js');
        assert.equal(deriveContactStatus(await getContactSnapshot(env, { linkId: LNK_A, ref: REF })), 'disabled');
    });

    it('路徑上的 ref 不合法或無法解碼 → 404 NOT_FOUND（驗證後才認證通過；與連結是否存在無關）', async () => {
        for (const p of ['short', 'a'.repeat(65), 'bad.char.ref', '%E0%A4%A', 'has%20space1', 'x%2Fy%2Fzzzzz', '%E4%B8%AD%E6%96%87%E4%B8%AD%E6%96%87']) {
            const r = await call('GET', `/bridge/v1/contacts/${p}`, { key: KEY_A });
            assert.equal(r.res.status, 404, p);
            assert.equal(errCode(r), 'NOT_FOUND');
            const d = await call('DELETE', `/bridge/v1/contacts/${p}`, { key: KEY_A });
            assert.equal(d.res.status, 404, p);
        }
    });

    it('跨連結隔離：連結 B 的金鑰看不到連結 A 的綁定與待用碼（unbound），也刪不掉', async () => {
        const issued = await issue(REF, KEY_A);
        await bindVia(issued.body.bind_code);
        await issue(REF2, KEY_A); // A 有一個待用碼

        assert.equal((await status(REF, KEY_B)).body.status, 'unbound');
        assert.equal((await status(REF2, KEY_B)).body.status, 'unbound');
        assert.equal((await status(REF, KEY_B)).body.bound_at, null);
        assert.equal((await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_B })).res.status, 204);
        assert.equal((await call('DELETE', `/bridge/v1/contacts/${REF2}`, { key: KEY_B })).res.status, 204);
        // A 的資料毫髮無傷
        assert.equal((await status(REF, KEY_A)).body.status, 'bound');
        assert.equal((await status(REF2, KEY_A)).body.status, 'pending');
        // B 對同名 ref 發碼，不會碰到 A 的碼
        await issue(REF2, KEY_B);
        assert.equal((await status(REF2, KEY_A)).body.status, 'pending');
        assert.equal(await count(d1.db, 'bind_codes', 'link_id = ?1', LNK_A), 2);
    });

    it('跨 bot：連結 A 發的碼在 BOT2 的 webhook 無效；連結 B 不能對 BOT 的使用者綁定', async () => {
        const issued = await issue(REF, KEY_A);
        assert.equal((await bindVia(issued.body.bind_code, { botId: BOT2 })).handled, false);
        assert.equal((await status(REF, KEY_A)).body.status, 'pending');
    });
});

// ───────────────────────── DELETE ─────────────────────────

describe('DELETE /contacts/{ref}', () => {
    it('已綁定 → 204，狀態回到 unbound；再刪一次仍 204（冪等）；audit 只記一次', async () => {
        await bindVia((await issue()).body.bind_code);
        const r = await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal(r.res.status, 204);
        assert.equal(r.text, '');
        assert.equal(await count(d1.db, 'contacts'), 0);
        assert.equal((await status()).body.status, 'unbound');
        assert.equal((await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A })).res.status, 204);
        assert.equal(await count(d1.db, 'audit_log', "action = 'contact_unbound'"), 1);
    });

    it('從沒有過的 ref → 204，不寫 audit（不洩漏是否存在）', async () => {
        assert.equal((await call('DELETE', '/bridge/v1/contacts/never-existed-1', { key: KEY_A })).res.status, 204);
        assert.equal(await count(d1.db, 'audit_log'), 0);
    });

    it('只有待用碼 → 一併作廢：碼無法再綁定，pending 變 unbound', async () => {
        const issued = await issue();
        assert.equal((await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A })).res.status, 204);
        assert.equal(await count(d1.db, 'bind_codes'), 0);
        assert.equal((await bindVia(issued.body.bind_code)).handled, false);
        assert.equal((await status()).body.status, 'unbound');
        assert.equal(await count(d1.db, 'audit_log', "action = 'contact_unbound'"), 1);
    });

    it('刪除後可以重新綁定', async () => {
        await bindVia((await issue()).body.bind_code);
        await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal((await bindVia((await issue()).body.bind_code, { userId: 'Unew00000000000000000000000000001' })).handled, true);
        assert.equal((await status()).body.status, 'bound');
    });

    it('audit contact_unbound：detail 只有 product_id 與 link_id', async () => {
        await bindVia((await issue()).body.bind_code);
        await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        const row = (await all(d1.db, "SELECT * FROM audit_log WHERE action = 'contact_unbound'"))[0];
        assert.equal(row.actor_type, 'service_key');
        assert.equal(row.actor_id, LNK_A);
        assert.deepEqual(JSON.parse(row.detail), { product_id: PRD_A, link_id: LNK_A });
    });
});

// ───────────────────────── 隱私掃描 ─────────────────────────

describe('隱私：LINE userId 與碼不外流', () => {
    it('走完整流程後：所有回應都不含 LINE userId；碼只出現在 POST 的回應；audit 不含 userId、ref、碼', async () => {
        const logs = [];
        console.error = (...a) => logs.push(a.join(' '));
        const issued = await issue();
        const code = issued.body.bind_code;
        await bindVia(code);
        await status();
        await markBlocked(env, { botId: BOT, lineUserId: LINE_USER });
        await status();
        await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        await status();
        await status('short');

        assert.ok(seen.length >= 6);
        for (const text of seen) assert.ok(!text.includes(LINE_USER), 'LINE userId 出現在回應');
        const withCode = seen.filter((t) => t.includes(code));
        assert.equal(withCode.length, 1);
        assert.equal(withCode[0], issued.text);

        const audit = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        assert.ok(await count(d1.db, 'audit_log') >= 3);
        for (const secret of [LINE_USER, REF, code, await sha256Hex(code)]) assert.ok(!audit.includes(secret));
        assert.ok(!logs.join('\n').includes(LINE_USER));
        assert.ok(!logs.join('\n').includes(code));
    });

    it('錯誤回應只用契約內的錯誤碼', async () => {
        for (const r of [await issue('x'), await status('short'), await call('GET', '/bridge/v1/contacts/x', {})]) {
            assert.ok(ERROR_CODES.includes(errCode(r)), r.text);
        }
    });
});

// ───────────────────────── 重新授權：綁定跟著新連結 ─────────────────────────

describe('重新授權（同產品同 bot）：綁定與待用碼遷移到新連結', () => {
    const NEW_LNK = 'lnk_dddddddddddddddd';
    const NEW_KEY = 'brk_dddddd_link-key-for-new-0000000000000000000';
    const OTHER_USER = 'Uother000000000000000000000000001';
    let bdb;
    before(async () => { bdb = await import('../../worker_src/bridge/db.js'); });

    const reconsent = async ({ productId = PRD_A, botId = BOT, linkId = NEW_LNK, key = NEW_KEY } = {}) => {
        const r = await bdb.createLinkWithKey(env, {
            linkId, productId, botId, scopes: ['link:manage', 'contacts:bind', 'messages:send'],
            createdBy: 'Uowner', keyHash: await sha256Hex(key),
        });
        return r;
    };

    it('新連結仍看到 bound；待用碼仍可用；舊連結名下不再有列；其他產品／其他 bot 不受影響', async () => {
        // 連結 A（PRD_A, BOT）：REF 已綁定、REF2 有待用碼
        await bindVia((await issue(REF)).body.bind_code);
        const pending = await issue(REF2);
        // 同 bot 另一個產品、同產品另一個 bot 的連結，各有一筆綁定
        await seedLink(d1.db, { linkId: 'lnk_eeeeeeeeeeeeeeee', productId: 'prd_eeeeeeeeeeee', botId: BOT, key: 'brk_other_product' });
        await seedLink(d1.db, { linkId: 'lnk_ffffffffffffffff', productId: PRD_A, botId: BOT2, key: 'brk_other_bot' });
        const otherCode = (await issue(REF, 'brk_other_product')).body.bind_code;
        await bindVia(otherCode, { userId: OTHER_USER });
        const otherBotCode = (await issue(REF, 'brk_other_bot')).body.bind_code;
        await bindVia(otherBotCode, { botId: BOT2, userId: OTHER_USER });
        // 已用與已過期的碼不遷移
        await d1.db.prepare(
            `INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at, used_at)
             VALUES ('expired', ?1, ?2, 'customer-expired', 1, 2, NULL)`
        ).bind(LNK_A, BOT).run();

        const { revokedLinkIds } = await reconsent();
        assert.deepEqual(revokedLinkIds, [LNK_A]);

        // 新連結：REF bound，REF2 pending
        assert.deepEqual((await status(REF, NEW_KEY)).body.status, 'bound');
        assert.deepEqual((await status(REF2, NEW_KEY)).body.status, 'pending');
        // 舊連結名下沒有任何列（已用／過期的碼也不留在舊連結以外的地方：過期碼留在舊連結）
        assert.equal(await count(d1.db, 'contacts', 'link_id = ?1', LNK_A), 0);
        assert.equal(await count(d1.db, 'bind_codes', "link_id = ?1 AND code_hash <> 'expired' AND used_at IS NULL", LNK_A), 0);
        assert.equal(await count(d1.db, 'bind_codes', "link_id = ?1 AND code_hash = 'expired'", NEW_LNK), 0);
        // 舊碼仍可用，綁到新連結
        assert.equal((await bindVia(pending.body.bind_code, { userId: OTHER_USER })).handled, true);
        assert.equal(await count(d1.db, 'contacts', 'link_id = ?1', NEW_LNK), 2);
        // 其他連結不受影響
        assert.equal((await status(REF, 'brk_other_product')).body.status, 'bound');
        assert.equal((await status(REF, 'brk_other_bot')).body.status, 'bound');
        assert.equal(await count(d1.db, 'contacts', 'link_id IN (?1, ?2)', 'lnk_eeeeeeeeeeeeeeee', 'lnk_ffffffffffffffff'), 2);
        // 舊金鑰已失效
        assert.equal(errCode(await status(REF, KEY_A)), 'LINK_REVOKED');
    });

    it('遷移後 unfollow／follow 仍作用在遷移後的列', async () => {
        await bindVia((await issue(REF)).body.bind_code);
        await reconsent();
        await markBlocked(env, { botId: BOT, lineUserId: LINE_USER });
        assert.equal((await status(REF, NEW_KEY)).body.status, 'blocked');
    });

    it('明確撤銷後再授權：不遷移（撤銷即切斷），新連結是 unbound，舊碼無效', async () => {
        await bindVia((await issue(REF)).body.bind_code);
        const pending = await issue(REF2);
        assert.equal((await call('DELETE', `/bridge/v1/links/${LNK_A}`, { key: KEY_A })).res.status, 204);
        await reconsent();
        assert.equal((await status(REF, NEW_KEY)).body.status, 'unbound');
        assert.equal((await status(REF2, NEW_KEY)).body.status, 'unbound');
        assert.equal((await bindVia(pending.body.bind_code)).handled, false);
        assert.equal(await count(d1.db, 'contacts', 'link_id = ?1', NEW_LNK), 0);
    });

    it('遷移沒有新增 audit 識別碼：audit_log 沒有 ref 與 LINE userId', async () => {
        await bindVia((await issue(REF)).body.bind_code);
        await reconsent();
        const dump = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        for (const secret of [REF, LINE_USER]) assert.ok(!dump.includes(secret));
    });
});
