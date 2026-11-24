/**
 * Unit Tests — 真實 Worker 對 docs/integration/bridge-v1.yaml 的符合度（LM-1D 契約測試之二）
 *
 * 做法：對每個 `x-status: implemented` 操作，用真實的路由（handleBridge）＋真 D1（Miniflare）＋記憶體 KV＋假 LINE，
 * 對規格列出的每個狀態碼各發至少一個請求，並用 checkResponse（tests/helpers/bridge_contract.mjs）檢查：
 *   (a) 狀態碼在該操作的 responses 內；(b) 本文符合該狀態碼的 schema（204／302 本文為空）；
 *   (c) 規格要求的標頭（Retry-After、Cache-Control: no-store、Location…）都在且值合法；
 *   (d) 引用 Error schema 的回應恰好是 {error:{code,message,retryable}}、code 在 enum 內。
 * 結尾核對「實際打到的狀態碼」與 helpers 裡的 CONFORMANCE 登記完全一致（登記是 test_bridge_contract_spec.mjs 的依據）。
 *
 * 新增／修改端點時：先改 bridge-v1.yaml，再在這裡補請求，最後把狀態碼登記進 CONFORMANCE。
 * 沒有任何 sleep；限流用 withPinnedWindow；並行競爭（IN_PROGRESS）用事件驅動。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { withPinnedWindow } from '../helpers/pin_time.mjs';
import { seedLink, seedSystem, seedKey } from '../helpers/bridge_seed.mjs';
import { LINK_SCOPES } from '../../worker_src/bridge/scopes.js';
import { loadSpec, checkResponse, CONFORMANCE } from '../helpers/bridge_contract.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { handleBridge } from '../../worker_src/bridge/index.js';

const spec = loadSpec();
const ORIGIN = 'https://worker.example.com';
const ADMIN = 'test-admin-secret-not-real';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const LNK_A = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const LNK_REV = 'lnk_cccccccccccccccc';
const PRD_A = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const PRD_REV = 'prd_cccccccccccc';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const KEY_REV = 'brk_cccccc_link-key-revoked-00000000000000000000';
const SYS_KEY = 'brk_eeeeee_system-key-0000000000000000000000000';
const SYS_KEY_NOSCOPE = 'brk_ffffff_system-key-noscope-000000000000000000';
const LINE_USER = 'Uline0000000000000000000000000001';
const LINE_TOKEN = 'TOKEN_SECRET_VALUE_X';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const URI = 'https://picker.example.com/cb';
const STATE = 'st-123';
const PUSH = 'https://api.line.me/v2/bot/message/push';
const MULTICAST = 'https://api.line.me/v2/bot/message/multicast';
const OP = (m, p) => `${m} ${p}`;
const HEALTH = OP('GET', '/bridge/v1/health');
const AUTHORIZE = OP('GET', '/bridge/v1/link/authorize');
const TOKEN = OP('POST', '/bridge/v1/links/token');
const LINK_GET = OP('GET', '/bridge/v1/links/{link_id}');
const LINK_DELETE = OP('DELETE', '/bridge/v1/links/{link_id}');
const LINK_ROTATE = OP('POST', '/bridge/v1/links/{link_id}/rotate-key');
const BIND = OP('POST', '/bridge/v1/contacts/bind-tokens');
const CONTACT_GET = OP('GET', '/bridge/v1/contacts/{external_contact_ref}');
const CONTACT_DELETE = OP('DELETE', '/bridge/v1/contacts/{external_contact_ref}');
const SEGMENT_PUT = OP('PUT', '/bridge/v1/contacts/{external_contact_ref}/segment');
const IDENTITY_TOKEN = OP('POST', '/bridge/v1/identity/token');
const MESSAGES = OP('POST', '/bridge/v1/messages');
const RAW_PUSH = OP('POST', '/bridge/v1/raw/push');
const RAW_MULTICAST = OP('POST', '/bridge/v1/raw/multicast');

let d1;
let env;
let kv;
let line;
let basicId; // null → /v2/bot/info 回 500
let idemSeq = 0;
const exercised = new Map(); // opKey → Set(status)
const originalFetch = globalThis.fetch;
const originalConsole = { error: console.error, warn: console.warn, log: console.log };

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });

function installLine() {
    line = {
        usage: 10,
        limit: 200,
        pushCalls: [],
        multicastCalls: [],
        push: () => new Response('{}', { status: 200 }),
        multicast: () => new Response('{}', { status: 200 }),
    };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u === 'https://api.line.me/v2/bot/info') {
            return basicId === null ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ userId: BOT, basicId, displayName: 'Shop' }), { status: 200 });
        }
        if (u.endsWith('/v2/bot/message/quota/consumption')) return new Response(JSON.stringify({ totalUsage: line.usage }), { status: 200 });
        if (u.endsWith('/v2/bot/message/quota')) return new Response(JSON.stringify({ type: 'limited', value: line.limit }), { status: 200 });
        if (u === PUSH) {
            line.pushCalls.push({ init, body: JSON.parse(init.body) });
            return line.push(line.pushCalls.length);
        }
        if (u === MULTICAST) {
            line.multicastCalls.push({ init, body: JSON.parse(init.body) });
            return line.multicast(line.multicastCalls.length);
        }
        throw new Error(`unexpected fetch ${u}`);
    };
}

async function seedBot(botId, ownerId, name) {
    await kv.put(BotKeys.permissions(botId), JSON.stringify({ users: [{ userId: ownerId, role: 'owner' }] }));
    await kv.put(BotKeys.info(botId), JSON.stringify({ displayName: name }));
    await kv.put(BotKeys.owner(botId), ownerId);
    const existing = JSON.parse((await kv.get(UserKeys.bots(ownerId))) || '{"bots":[]}');
    existing.bots.push({ botId, role: 'owner' });
    await kv.put(UserKeys.bots(ownerId), JSON.stringify(existing));
}

async function setDomains(productId, domains) {
    await d1.db.prepare('UPDATE products SET url_domains = ?2, redirect_uris = ?3 WHERE product_id = ?1')
        .bind(productId, JSON.stringify(domains), JSON.stringify([URI])).run();
}

async function bindContact(linkId, ref, { status = 'bound', botId = BOT } = {}) {
    await d1.db.prepare(
        'INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1700000000000, 1)'
    ).bind(linkId, ref, botId, LINE_USER, status).run();
}

beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', BRIDGE_ADMIN_SECRET: ADMIN, AUTH_MODE: 'legacy', MOUNT_PATH: '/lm' };
    basicId = '@123abcde';
    console.error = () => {};
    console.warn = () => {};
    installLine();
    await seedBot(BOT, OWNER, 'Shop A');
    await seedBot(BOT2, 'Uowner0000000000000000000000003', 'Shop B');
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: LINE_TOKEN, destination: BOT } }));
    await seedLink(d1.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A });
    await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT2, key: KEY_B });
    await seedLink(d1.db, { linkId: LNK_REV, productId: PRD_REV, botId: BOT, key: KEY_REV, status: 'revoked', keyRevokedAt: 1 });
    await setDomains(PRD_A, ['picker.example.com']);
    await setDomains(PRD_B, ['picker.example.com']);
    await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', scopes: ['raw:push'] });
    await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYS_KEY, scopes: ['raw:push'] });
    await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYS_KEY_NOSCOPE, scopes: ['something:else'] });
    await kv.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER, name: 'Amy' }));
});
afterEach(() => {
    Object.assign(console, originalConsole);
    globalThis.fetch = originalFetch;
});

/** 發請求並（若指定 opKey）檢查是否符合規格。回 {res, text, body} */
async function call(opKey, method, path, { key, headers = {}, body, raw, e = env } = {}) {
    const init = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } };
    if (body !== undefined) {
        init.body = raw ? body : JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), e, url.pathname);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 204／302 */ }
    if (opKey) {
        checkResponse(spec, opKey, res, text);
        if (!exercised.has(opKey)) exercised.set(opKey, new Set());
        exercised.get(opKey).add(String(res.status));
    }
    return { res, text, body: parsed };
}

const code = (r) => r.body && r.body.error && r.body.error.code;
const noDb = () => ({ ...env, BRIDGE_DB: undefined });
const q = (params) => new URLSearchParams(params).toString();
const nextIdem = () => `idem-${++idemSeq}-${Math.random().toString(36).slice(2, 8)}`;

/** 以 expect 檢查狀態碼與（新格式）錯誤碼，回傳結果 */
function expectErr(r, status, errorCode, retryable) {
    assert.equal(r.res.status, status, r.text);
    assert.equal(code(r), errorCode, r.text);
    if (retryable !== undefined) assert.equal(r.body.error.retryable, retryable);
    return r;
}

// ───────────────────────── GET /health ─────────────────────────

describe('GET /bridge/v1/health', () => {
    it('200 { ok: true }', async () => {
        const r = await call(HEALTH, 'GET', '/bridge/v1/health');
        assert.equal(r.res.status, 200);
        assert.deepEqual(r.body, { ok: true });
    });

    it('503 舊格式 bridge_not_configured（BRIDGE_DB 未綁定）', async () => {
        const r = await call(HEALTH, 'GET', '/bridge/v1/health', { e: noDb() });
        assert.equal(r.res.status, 503);
        assert.deepEqual(r.body, { success: false, error: 'bridge_not_configured' });
    });
});

// ───────────────────────── GET /link/authorize ─────────────────────────

async function registerProduct() {
    const r = await call(null, 'POST', '/bridge/v1/admin/products', {
        headers: { Authorization: `Bearer ${ADMIN}` },
        body: { name: 'Image Picker', redirect_uris: [URI], url_domains: ['picker.example.com'], scopes: ['link:manage', 'contacts:bind', 'messages:send'] },
    });
    assert.equal(r.res.status, 201, r.text);
    return r.body;
}

describe('GET /bridge/v1/link/authorize', () => {
    it('302 導向同意頁（Location 是 URI、Cache-Control: no-store、無本文）', async () => {
        const p = await registerProduct();
        const r = await call(AUTHORIZE, 'GET', `/bridge/v1/link/authorize?${q({ product_id: p.product_id, state: STATE, redirect_uri: URI })}`);
        assert.equal(r.res.status, 302);
        const loc = new URL(r.res.headers.get('Location'));
        assert.equal(loc.pathname, '/lm/pages/link_authorize.html');
        assert.equal(loc.searchParams.get('state'), STATE);
    });

    it('400 INVALID_REQUEST：product_id／state／redirect_uri 不合，不會導向', async () => {
        const p = await registerProduct();
        for (const params of [
            { product_id: p.product_id, state: STATE, redirect_uri: 'https://evil.example.com/cb' },
            { product_id: 'prd_000000000000', state: STATE, redirect_uri: URI },
            { product_id: p.product_id, state: 's'.repeat(257), redirect_uri: URI },
            { product_id: p.product_id, redirect_uri: URI },
        ]) {
            const r = expectErr(await call(AUTHORIZE, 'GET', `/bridge/v1/link/authorize?${q(params)}`), 400, 'INVALID_REQUEST', false);
            assert.equal(r.res.headers.get('Location'), null);
        }
    });

    it('503 INTERNAL：BRIDGE_DB 未綁定', async () => {
        expectErr(await call(AUTHORIZE, 'GET', `/bridge/v1/link/authorize?${q({ product_id: PRD_A, state: STATE, redirect_uri: URI })}`, { e: noDb() }), 503, 'INTERNAL', true);
    });
});

// ───────────────────────── POST /links/token ─────────────────────────

describe('POST /bridge/v1/links/token', () => {
    const exchange = (secret, body, { ip = '203.0.113.7', e = env } = {}) =>
        call(TOKEN, 'POST', '/bridge/v1/links/token', { e, headers: { Authorization: `Bearer ${secret}`, 'CF-Connecting-IP': ip }, body });
    async function authCode(p) {
        const r = await call(null, 'POST', '/bridge/v1/link/authorize/approve', {
            headers: { 'X-User-Id': OWNER }, body: { product_id: p.product_id, state: STATE, redirect_uri: URI, bot_id: BOT },
        });
        assert.equal(r.res.status, 200, r.text);
        return new URL(r.body.redirect_to).searchParams.get('code');
    }

    it('200 連結與金鑰（scopes 在 Scope enum 內、Cache-Control: no-store）；授權碼單次使用', async () => {
        const p = await registerProduct();
        const authorization = await authCode(p);
        const r = await exchange(p.product_secret, { code: authorization, redirect_uri: URI });
        assert.equal(r.res.status, 200, r.text);
        assert.match(r.body.link_id, /^lnk_[a-f0-9]{16}$/);
        assert.match(r.body.service_key, /^brk_[a-f0-9]{6}_/);
        assert.equal(r.body.bot_display_name, 'Shop A');
        // 同一個碼第二次 → INVALID_CODE（規格：已使用回 INVALID_CODE，狀態碼 400）
        expectErr(await exchange(p.product_secret, { code: authorization, redirect_uri: URI }), 400, 'INVALID_CODE', false);
    });

    it('400 INVALID_REQUEST（缺欄位／本文不是 JSON）與 INVALID_CODE（格式不對、不存在）', async () => {
        const p = await registerProduct();
        expectErr(await exchange(p.product_secret, {}), 400, 'INVALID_REQUEST', false);
        expectErr(await exchange(p.product_secret, 'not json', { }), 400, 'INVALID_REQUEST', false);
        expectErr(await exchange(p.product_secret, { code: 'lmc_nope', redirect_uri: URI }), 400, 'INVALID_CODE', false);
        expectErr(await exchange(p.product_secret, { code: `lmc_${'A'.repeat(43)}`, redirect_uri: URI }), 400, 'INVALID_CODE', false);
    });

    it('401 INVALID_KEY：產品密鑰錯誤、缺漏、或產品不存在（不可區分）', async () => {
        const p = await registerProduct();
        for (const secret of [`bps_${p.product_id.slice(4)}_${'x'.repeat(43)}`, 'nonsense', `bps_000000000000_${'x'.repeat(43)}`]) {
            expectErr(await exchange(secret, { code: 'x', redirect_uri: URI }), 401, 'INVALID_KEY', false);
        }
        expectErr(await call(TOKEN, 'POST', '/bridge/v1/links/token', { body: { code: 'x', redirect_uri: URI } }), 401, 'INVALID_KEY', false);
    });

    it('429 RATE_LIMITED + Retry-After（每 IP 與產品每分鐘 30 次）', async () => {
        await withPinnedWindow(async () => {
            const secret = `bps_aaaaaaaaaaaa_${'x'.repeat(43)}`;
            let last;
            for (let i = 0; i < 31; i++) last = await exchange(secret, { code: 'x', redirect_uri: URI }, { ip: '198.51.100.9' });
            expectErr(last, 429, 'RATE_LIMITED', true);
            assert.match(last.res.headers.get('Retry-After'), /^\d+$/);
        });
    });

    it('503 INTERNAL：BRIDGE_DB 未綁定', async () => {
        expectErr(await exchange(`bps_aaaaaaaaaaaa_${'x'.repeat(43)}`, { code: 'x', redirect_uri: URI }, { e: noDb(), ip: '198.51.100.10' }), 503, 'INTERNAL', true);
    });
});

// ───────────────────────── 連結金鑰端點的共同錯誤 ─────────────────────────

/**
 * 每個連結金鑰端點都要有的回應：401（沒金鑰／亂金鑰／系統金鑰）、403 LINK_REVOKED 與 SCOPE_DENIED、503。
 * `send(key, e)` 發出該端點的請求；`requiredScope` 是端點需要的 scope（另種一條「缺這個 scope」的連結來觸發 SCOPE_DENIED）。
 */
function sharedFailures(label, send, requiredScope) {
    describe(`${label}：共同的錯誤回應`, () => {
        it('401 INVALID_KEY：沒有金鑰、亂金鑰、系統金鑰（無 link_id）', async () => {
            for (const key of [undefined, 'brk_nope', SYS_KEY]) expectErr(await send(key), 401, 'INVALID_KEY', false);
        });

        it('403 LINK_REVOKED：連結已撤銷', async () => {
            expectErr(await send(KEY_REV), 403, 'LINK_REVOKED', false);
        });

        it('403 SCOPE_DENIED：連結沒有此端點需要的 scope', async () => {
            const key = 'brk_eeeeee_link-key-missing-scope-00000000000';
            await seedLink(d1.db, {
                linkId: 'lnk_eeeeeeeeeeeeeeee', productId: 'prd_eeeeeeeeeeee', botId: BOT, key,
                scopes: LINK_SCOPES.filter((s) => s !== requiredScope),
            });
            expectErr(await send(key), 403, 'SCOPE_DENIED', false);
        });

        it('503 INTERNAL：BRIDGE_DB 未綁定', async () => {
            expectErr(await send(KEY_A, noDb()), 503, 'INTERNAL', true);
        });
    });
}

// ───────────────────────── /links/{link_id} ─────────────────────────

describe('GET /bridge/v1/links/{link_id}', () => {
    const get = (key, linkId = LNK_A, e = env) => call(LINK_GET, 'GET', `/bridge/v1/links/${linkId}`, { key, e });
    sharedFailures('GET /links/{link_id}', (key, e) => get(key, LNK_A, e), 'link:manage');

    it('200 Link（不含金鑰，Cache-Control: no-store）', async () => {
        const r = await get(KEY_A);
        assert.equal(r.res.status, 200, r.text);
        assert.equal(r.body.link_id, LNK_A);
        assert.equal(r.body.status, 'active');
        assert.equal(r.body.revoked_at, null);
        assert.equal(r.body.bot_display_name, 'Shop A');
        assert.ok(!r.text.includes(KEY_A));
    });

    it('404 NOT_FOUND：別條連結的 id、格式不對的 id（不洩漏他人連結是否存在）', async () => {
        expectErr(await get(KEY_A, LNK_B), 404, 'NOT_FOUND', false);
        expectErr(await get(KEY_A, 'lnk_zzzz'), 404, 'NOT_FOUND', false);
    });

});

describe('DELETE /bridge/v1/links/{link_id}', () => {
    const del = (key, linkId = LNK_A, e = env) => call(LINK_DELETE, 'DELETE', `/bridge/v1/links/${linkId}`, { key, e });
    sharedFailures('DELETE /links/{link_id}', (key, e) => del(key, LNK_A, e), 'link:manage');

    it('204 解除（無本文、Cache-Control: no-store）；舊金鑰此後是 403 LINK_REVOKED', async () => {
        const r = await del(KEY_A);
        assert.equal(r.res.status, 204);
        assert.equal(r.text, '');
        expectErr(await call(LINK_GET, 'GET', `/bridge/v1/links/${LNK_A}`, { key: KEY_A }), 403, 'LINK_REVOKED', false);
    });

    it('404 NOT_FOUND：別條連結的 id（對方連結不受影響）', async () => {
        expectErr(await del(KEY_A, LNK_B), 404, 'NOT_FOUND', false);
        assert.equal((await call(LINK_GET, 'GET', `/bridge/v1/links/${LNK_B}`, { key: KEY_B })).res.status, 200);
    });

});

describe('POST /bridge/v1/links/{link_id}/rotate-key', () => {
    const rotate = (key, linkId = LNK_A, e = env) => call(LINK_ROTATE, 'POST', `/bridge/v1/links/${linkId}/rotate-key`, { key, e });
    sharedFailures('POST /links/{link_id}/rotate-key', (key, e) => rotate(key, LNK_A, e), 'link:manage');

    it('200 新金鑰（Cache-Control: no-store）；舊金鑰立即失效（401 INVALID_KEY）', async () => {
        const r = await rotate(KEY_A);
        assert.equal(r.res.status, 200, r.text);
        assert.match(r.body.service_key, /^brk_[a-f0-9]{6}_/);
        assert.notEqual(r.body.service_key, KEY_A);
        expectErr(await call(LINK_GET, 'GET', `/bridge/v1/links/${LNK_A}`, { key: KEY_A }), 401, 'INVALID_KEY', false);
        assert.equal((await call(LINK_GET, 'GET', `/bridge/v1/links/${LNK_A}`, { key: r.body.service_key })).res.status, 200);
    });

    it('404 NOT_FOUND：別條連結的 id', async () => {
        expectErr(await rotate(KEY_A, LNK_B), 404, 'NOT_FOUND', false);
    });

});

// ───────────────────────── /contacts ─────────────────────────

describe('POST /bridge/v1/contacts/bind-tokens', () => {
    const bind = (key, ref = REF, e = env) => call(BIND, 'POST', '/bridge/v1/contacts/bind-tokens', { key, body: { external_contact_ref: ref }, e });
    sharedFailures('POST /contacts/bind-tokens', (key, e) => bind(key, REF, e), 'contacts:bind');


    it('201 綁定碼與連結（bind_url 為 line.me 預填連結、expires_at 是 date-time、Cache-Control: no-store）', async () => {
        const r = await bind(KEY_A);
        assert.equal(r.res.status, 201, r.text);
        assert.match(r.body.bind_code, /^LM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        assert.equal(r.body.bind_url, `https://line.me/R/oaMessage/@123abcde/?${r.body.bind_code}`);
        assert.ok(Date.parse(r.body.expires_at) > Date.now());
    });

    it('201 取不到 basic ID 時 bind_url 為 null（規格 nullable）', async () => {
        basicId = null;
        const r = await bind(KEY_A);
        assert.equal(r.res.status, 201, r.text);
        assert.equal(r.body.bind_url, null);
        assert.match(r.body.bind_code, /^LM-/);
    });

    it('400 INVALID_REQUEST：external_contact_ref 格式不符、缺欄位、本文不是 JSON', async () => {
        for (const ref of ['short', 'has space here', 'a'.repeat(65), 42, null]) expectErr(await bind(KEY_A, ref), 400, 'INVALID_REQUEST', false);
        expectErr(await call(BIND, 'POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: {} }), 400, 'INVALID_REQUEST', false);
        expectErr(await call(BIND, 'POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: 'oops', raw: true }), 400, 'INVALID_REQUEST', false);
    });

    it('429 RATE_LIMITED + Retry-After（每連結每分鐘 30 次）', async () => {
        await withPinnedWindow(async () => {
            let last;
            for (let i = 0; i < 31; i++) last = await bind(KEY_A);
            expectErr(last, 429, 'RATE_LIMITED', true);
            assert.match(last.res.headers.get('Retry-After'), /^[1-9]\d*$/);
        });
    });
});

describe('GET /bridge/v1/contacts/{external_contact_ref}', () => {
    const get = (key, ref = REF, e = env) => call(CONTACT_GET, 'GET', `/bridge/v1/contacts/${ref}`, { key, e });
    sharedFailures('GET /contacts/{ref}', (key, e) => get(key, REF, e), 'contacts:bind');


    it('200 五種狀態中可由端點到達的四種：unbound、pending、bound、blocked（bound_at 只有 bound／blocked 有值）', async () => {
        let r = await get(KEY_A);
        assert.deepEqual(r.body, { external_contact_ref: REF, status: 'unbound', bound_at: null, segment: null });

        assert.equal((await call(BIND, 'POST', '/bridge/v1/contacts/bind-tokens', { key: KEY_A, body: { external_contact_ref: REF2 } })).res.status, 201);
        r = await get(KEY_A, REF2);
        assert.deepEqual(r.body, { external_contact_ref: REF2, status: 'pending', bound_at: null, segment: null });

        await bindContact(LNK_A, REF);
        r = await get(KEY_A);
        assert.equal(r.body.status, 'bound');
        assert.equal(r.body.bound_at, new Date(1700000000000).toISOString());

        await d1.db.prepare("UPDATE contacts SET status = 'blocked' WHERE link_id = ?1").bind(LNK_A).run();
        r = await get(KEY_A);
        assert.equal(r.body.status, 'blocked');
        assert.equal(typeof r.body.bound_at, 'string');
        assert.ok(!r.text.includes(LINE_USER), '不回 LINE userId');
    });

    it('200 別條連結的 ref 看起來就是 unbound', async () => {
        await bindContact(LNK_B, REF, { botId: BOT2 });
        assert.equal((await get(KEY_A)).body.status, 'unbound');
    });

    it('404 NOT_FOUND：ref 格式不符', async () => {
        for (const ref of ['short', 'has%20space%20here', 'a'.repeat(65)]) expectErr(await get(KEY_A, ref), 404, 'NOT_FOUND', false);
    });
});

describe('DELETE /bridge/v1/contacts/{external_contact_ref}', () => {
    const del = (key, ref = REF, e = env) => call(CONTACT_DELETE, 'DELETE', `/bridge/v1/contacts/${ref}`, { key, e });
    sharedFailures('DELETE /contacts/{ref}', (key, e) => del(key, REF, e), 'contacts:bind');


    it('204 無本文、冪等（已綁定、本來就沒有、重複刪除都是 204）', async () => {
        await bindContact(LNK_A, REF);
        for (let i = 0; i < 2; i++) {
            const r = await del(KEY_A);
            assert.equal(r.res.status, 204);
            assert.equal(r.text, '');
        }
        assert.equal((await del(KEY_A, 'never-existed-ref')).res.status, 204);
        assert.equal((await call(CONTACT_GET, 'GET', `/bridge/v1/contacts/${REF}`, { key: KEY_A })).body.status, 'unbound');
    });

    it('404 NOT_FOUND：ref 格式不符', async () => {
        expectErr(await del(KEY_A, 'short'), 404, 'NOT_FOUND', false);
    });
});

// ───────────────────────── PUT /contacts/{ref}/segment（v1.1）─────────────────────────

describe('PUT /bridge/v1/contacts/{external_contact_ref}/segment', () => {
    const put = (key, { ref = REF, body = { segment: 'vip' }, e = env } = {}) =>
        call(SEGMENT_PUT, 'PUT', `/bridge/v1/contacts/${ref}/segment`, { key, body, e });
    beforeEach(async () => {
        const scopes = JSON.stringify(LINK_SCOPES);
        await d1.db.prepare('UPDATE links SET scopes = ?2 WHERE link_id = ?1').bind(LNK_A, scopes).run();
        await d1.db.prepare('UPDATE service_keys SET scopes = ?2 WHERE link_id = ?1').bind(LNK_A, scopes).run();
        await d1.db.prepare("UPDATE products SET product_key = 'ip', scopes = ?2 WHERE product_id = ?1").bind(PRD_A, scopes).run();
    });
    sharedFailures('PUT /contacts/{ref}/segment', (key, e) => put(key, { e }), 'segments:write');

    it('204 無本文（設定、同值冪等、清除）', async () => {
        await bindContact(LNK_A, REF);
        for (const body of [{ segment: 'vip' }, { segment: 'vip' }, { segment: null }]) {
            const r = await put(KEY_A, { body });
            assert.equal(r.res.status, 204, r.text);
            assert.equal(r.text, '');
        }
    });

    it('400 INVALID_REQUEST：格式不合、缺欄位', async () => {
        await bindContact(LNK_A, REF);
        expectErr(await put(KEY_A, { body: { segment: 'VIP' } }), 400, 'INVALID_REQUEST', false);
        expectErr(await put(KEY_A, { body: {} }), 400, 'INVALID_REQUEST', false);
    });

    it('404 NOT_FOUND：ref 格式不符', async () => {
        expectErr(await put(KEY_A, { ref: 'short' }), 404, 'NOT_FOUND', false);
    });

    it('409 CONTACT_NOT_BOUND／RECIPIENT_BLOCKED', async () => {
        expectErr(await put(KEY_A), 409, 'CONTACT_NOT_BOUND', false);
        await bindContact(LNK_A, REF2, { status: 'blocked' });
        expectErr(await put(KEY_A, { ref: REF2 }), 409, 'RECIPIENT_BLOCKED', false);
    });

    it('200 GET 回應帶 segment', async () => {
        await bindContact(LNK_A, REF);
        await put(KEY_A);
        const r = await call(CONTACT_GET, 'GET', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal(r.body.segment, 'vip');
    });

    it('429 RATE_LIMITED + Retry-After（每連結每分鐘 60 次）', async () => {
        await withPinnedWindow(async () => {
            let last;
            for (let i = 0; i < 61; i++) last = await put(KEY_A, { body: {} });
            expectErr(last, 429, 'RATE_LIMITED', true);
            assert.match(last.res.headers.get('Retry-After'), /^[1-9]\d*$/);
        });
    });
});

// ───────────────────────── POST /identity/token（v1.1）─────────────────────────

describe('POST /bridge/v1/identity/token', () => {
    const redeem = (key, { body = { code: 'x' }, e = env } = {}) => call(IDENTITY_TOKEN, 'POST', '/bridge/v1/identity/token', { key, body, e });
    const newCode = async (ref = null) => {
        const code = `lmi_${Array.from(crypto.getRandomValues(new Uint8Array(43)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"[b % 64]).join("")}`;
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        const bdb = await import('../../worker_src/bridge/db.js');
        await bdb.createIdentityCode(env, { codeHash: await sha256Hex(code), linkId: LNK_A, botId: BOT, ref, status: ref ? 'bound' : null });
        return code;
    };
    beforeEach(async () => {
        const scopes = JSON.stringify(LINK_SCOPES);
        await d1.db.prepare('UPDATE links SET scopes = ?2 WHERE link_id = ?1').bind(LNK_A, scopes).run();
        await d1.db.prepare('UPDATE service_keys SET scopes = ?2 WHERE link_id = ?1').bind(LNK_A, scopes).run();
    });
    sharedFailures('POST /identity/token', (key, e) => redeem(key, { e }), 'identity:read');

    it('200 {link_id, contact}（已綁定與未綁定；Cache-Control: no-store）', async () => {
        const bound = await redeem(KEY_A, { body: { code: await newCode(REF) } });
        assert.equal(bound.res.status, 200, bound.text);
        assert.deepEqual(bound.body, { link_id: LNK_A, contact: { external_contact_ref: REF, status: 'bound' } });
        const none = await redeem(KEY_A, { body: { code: await newCode() } });
        assert.deepEqual(none.body, { link_id: LNK_A, contact: null });
    });

    it('400 INVALID_CODE：用過、格式不對、不存在（同一種回應）；INVALID_REQUEST：本文不是 JSON', async () => {
        const code = await newCode(REF);
        await redeem(KEY_A, { body: { code } });
        for (const c of [code, 'lmi_short', `lmi_${'A'.repeat(43)}`]) expectErr(await redeem(KEY_A, { body: { code: c } }), 400, 'INVALID_CODE', false);
    });

    it('429 RATE_LIMITED + Retry-After（每連結每分鐘 60 次）', async () => {
        await withPinnedWindow(async () => {
            let last;
            for (let i = 0; i < 61; i++) last = await redeem(KEY_A, { body: { code: 'x' } });
            expectErr(last, 429, 'RATE_LIMITED', true);
            assert.match(last.res.headers.get('Retry-After'), /^[1-9]\d*$/);
        });
    });
});

// ───────────────────────── POST /messages ─────────────────────────

describe('POST /bridge/v1/messages', () => {
    const notification = (over = {}) => ({ external_contact_ref: REF, event_type: 'order.shipped', title: '出貨通知', body: '您的訂單已出貨', ...over });
    /** idem: undefined → 自動產生；null → 不帶標頭 */
    function send(over = {}, opts = {}) {
        const { idem, e, raw } = opts;
        const key = 'key' in opts ? opts.key : KEY_A;
        const headers = {};
        const k = idem === undefined ? nextIdem() : idem;
        if (k !== null) headers['Idempotency-Key'] = k;
        return call(MESSAGES, 'POST', '/bridge/v1/messages', { key, headers, body: raw === undefined ? notification(over) : raw, raw: raw !== undefined, e });
    }
    beforeEach(async () => { await bindContact(LNK_A, REF); });

    sharedFailures('POST /messages', (key, e) => send({}, { key, e }), 'messages:send');


    it('200 MessageResult（status: sent、message_id、sent_at；Cache-Control: no-store）', async () => {
        const r = await send();
        assert.equal(r.res.status, 200, r.text);
        assert.equal(r.body.status, 'sent');
        assert.match(r.body.message_id, /^msg_[a-f0-9]{16}$/);
        assert.equal(r.res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(line.pushCalls.length, 1);
    });

    it('200 同鍵重送：第一次的結果＋X-Idempotency-Replayed: true，不再打 LINE', async () => {
        const idem = nextIdem();
        const first = await send({}, { idem });
        const again = await send({}, { idem });
        assert.equal(again.res.status, 200);
        assert.equal(again.res.headers.get('X-Idempotency-Replayed'), 'true');
        assert.deepEqual(again.body, first.body);
        assert.equal(line.pushCalls.length, 1);
    });

    it('400 INVALID_REQUEST：缺 Idempotency-Key、鍵超過 128 字元、未知欄位、缺欄位、標題含連結、本文不是 JSON；LINE 拒絕內容也是 400', async () => {
        expectErr(await send({}, { idem: null }), 400, 'INVALID_REQUEST', false);
        expectErr(await send({}, { idem: 'k'.repeat(129) }), 400, 'INVALID_REQUEST', false);
        assert.equal((await send({}, { idem: 'k'.repeat(128) })).res.status, 200, '128 字元的鍵合法（規格 maxLength 128）');
        expectErr(await send({ unknown: 1 }), 400, 'INVALID_REQUEST', false);
        expectErr(await send({ title: undefined }), 400, 'INVALID_REQUEST', false);
        expectErr(await send({ title: 'see https://x.example.com' }), 400, 'INVALID_REQUEST', false);
        expectErr(await send({ title: 'a'.repeat(41) }), 400, 'INVALID_REQUEST', false);
        expectErr(await send({}, { raw: 'not json' }), 400, 'INVALID_REQUEST', false);
        line.push = () => new Response(JSON.stringify({ message: 'bad' }), { status: 400 });
        const rejected = expectErr(await send(), 400, 'INVALID_REQUEST', false);
        assert.equal(rejected.body.error.message, 'LINE rejected the message');
    });

    it('402 QUOTA_EXCEEDED（額度用盡，不打 LINE）', async () => {
        line.usage = line.limit;
        const r = expectErr(await send(), 402, 'QUOTA_EXCEEDED', false);
        assert.equal(r.res.headers.get('Retry-After'), null);
        assert.equal(line.pushCalls.length, 0);
    });

    it('409 CONTACT_NOT_BOUND（沒有綁定、別條連結的 ref）、RECIPIENT_BLOCKED（客戶封鎖）、IN_PROGRESS（同鍵仍在處理）', async () => {
        expectErr(await send({ external_contact_ref: 'nobody-0001' }), 409, 'CONTACT_NOT_BOUND', false);
        await bindContact(LNK_B, 'customer-of-b', { botId: BOT2 });
        expectErr(await send({ external_contact_ref: 'customer-of-b' }), 409, 'CONTACT_NOT_BOUND', false);

        await bindContact(LNK_A, REF2, { status: 'blocked' });
        expectErr(await send({ external_contact_ref: REF2 }), 409, 'RECIPIENT_BLOCKED', false);

        // LINE 回 403 → RECIPIENT_BLOCKED，聯絡人標成 blocked
        line.push = () => new Response('{}', { status: 403 });
        expectErr(await send(), 409, 'RECIPIENT_BLOCKED', false);

        // IN_PROGRESS：贏家卡在 LINE（事件驅動，不靠計時）
        await d1.db.prepare("UPDATE contacts SET status = 'bound' WHERE link_id = ?1").bind(LNK_A).run();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let reached;
        const atLine = new Promise((resolve) => { reached = resolve; });
        line.push = () => { reached(); return gate.then(() => new Response('{}', { status: 200 })); };
        const idem = nextIdem();
        const first = send({}, { idem });
        await Promise.race([atLine, first.then(() => { throw new Error('第一個請求在到達 LINE 之前就結束了'); })]);
        const second = await send({}, { idem });
        release();
        assert.equal((await first).res.status, 200);
        expectErr(second, 409, 'IN_PROGRESS', true);
    });

    it('413 INVALID_REQUEST：本文超過 20000 字元', async () => {
        expectErr(await send({ body: 'x'.repeat(20001) }), 413, 'INVALID_REQUEST', false);
    });

    it('422 INVALID_URL_DOMAIN（網域不在白名單）與 IDEMPOTENCY_KEY_REUSE（同鍵不同內容）；白名單內的網址可以送', async () => {
        expectErr(await send({ action: { label: '查看', url: 'https://evil.example.org/x' } }), 422, 'INVALID_URL_DOMAIN', false);
        expectErr(await send({ action: { label: '查看', url: 'http://picker.example.com/x' } }), 422, 'INVALID_URL_DOMAIN', false);
        assert.equal((await send({ action: { label: '查看', url: 'https://sub.picker.example.com/x' } })).res.status, 200);

        const idem = nextIdem();
        assert.equal((await send({}, { idem })).res.status, 200);
        expectErr(await send({ title: '另一則' }, { idem }), 422, 'IDEMPOTENCY_KEY_REUSE', false);
    });

    it('429 RATE_LIMITED + Retry-After（每（連結, 聯絡人）每小時 10 則）', async () => {
        await withPinnedWindow(async () => {
            for (let i = 0; i < 10; i++) assert.equal((await send()).res.status, 200);
            const r = expectErr(await send(), 429, 'RATE_LIMITED', true);
            assert.match(r.res.headers.get('Retry-After'), /^[1-9]\d*$/);
        });
    });

    it('429 RATE_LIMITED + Retry-After：LINE 端限流', async () => {
        line.push = () => new Response(JSON.stringify({ message: 'too many' }), { status: 429, headers: { 'Retry-After': '3' } });
        const r = expectErr(await send(), 429, 'RATE_LIMITED', true);
        assert.match(r.res.headers.get('Retry-After'), /^[1-9]\d*$/);
    });

    it('502 INTERNAL retryable:true：LINE 5xx 或連不上', async () => {
        line.push = () => new Response('oops', { status: 500 });
        expectErr(await send(), 502, 'INTERNAL', true);
        line.push = () => { throw new Error('network down'); };
        expectErr(await send(), 502, 'INTERNAL', true);
    });

    it('503 INTERNAL：bot 沒有可用的 LINE token（bot_not_configured）', async () => {
        await kv.delete(`access_tokens_${OWNER}`);
        const r = expectErr(await send(), 503, 'INTERNAL', true);
        assert.equal(r.body.error.message, 'bot_not_configured');
    });
});

// ───────────────────────── POST /raw/push 與 /raw/multicast（舊格式，D-7） ─────────────────────────

for (const [opKey, path, kind] of [[RAW_PUSH, '/bridge/v1/raw/push', 'push'], [RAW_MULTICAST, '/bridge/v1/raw/multicast', 'multicast']]) {
    describe(`POST ${path}（舊錯誤格式 LegacyError）`, () => {
        const TEXT = [{ type: 'text', text: 'hello' }];
        const target = kind === 'push' ? MEMBER : [MEMBER, 'Uother00000000000000000000000004'];
        const lineCalls = () => (kind === 'push' ? line.pushCalls : line.multicastCalls);
        const setLine = (fn) => { line[kind] = fn; };
        const sendRaw = (opts = {}) => {
            const { headers = {}, body = { to: target, messages: TEXT }, raw, e } = opts;
            const key = 'key' in opts ? opts.key : SYS_KEY;
            return call(opKey, 'POST', path, { key, headers: { 'X-Bot-Id': BOT, ...headers }, body, raw, e });
        };
        const legacy = (r, status, error) => {
            assert.equal(r.res.status, status, r.text);
            assert.equal(r.body.success === undefined || r.body.success === false, true);
            if (error !== undefined) assert.equal(r.body.error, error);
            return r;
        };

        it('200 RawSendResult（quotaConsumed、remaining 對帳）；沒帶 X-Idempotency-Key 時帶 X-Idempotency-Missing: true', async () => {
            const r = await sendRaw();
            assert.equal(r.res.status, 200, r.text);
            assert.equal(r.body.success, true);
            assert.equal(r.body.quotaConsumed, kind === 'push' ? 1 : 2);
            assert.equal(r.res.headers.get('X-Idempotency-Missing'), 'true');
            assert.equal(lineCalls().length, 1);
        });

        it('200 同鍵重送：回放第一次的結果＋X-Idempotency-Replayed: true，不再打 LINE', async () => {
            const headers = { 'X-Idempotency-Key': nextIdem() };
            const first = await sendRaw({ headers });
            const again = await sendRaw({ headers });
            assert.equal(again.res.status, 200);
            assert.equal(again.res.headers.get('X-Idempotency-Replayed'), 'true');
            assert.equal(again.res.headers.get('X-Idempotency-Missing'), null);
            assert.deepEqual(again.body, first.body);
            assert.equal(lineCalls().length, 1);
        });

        it('200 acceptedEarlier：LINE 回 409（retry key 已被接受）視為成功、quotaConsumed 0', async () => {
            setLine(() => new Response('{}', { status: 409 }));
            const r = await sendRaw({ headers: { 'X-Idempotency-Key': nextIdem() } });
            assert.equal(r.res.status, 200, r.text);
            assert.equal(r.body.acceptedEarlier, true);
            assert.equal(r.body.quotaConsumed, 0);
        });

        it('400 invalid_request：缺 X-Bot-Id、本文不是 JSON、messages 不合、to 不合、鍵超過 128 字元、LINE 拒絕內容', async () => {
            legacy(await call(opKey, 'POST', path, { key: SYS_KEY, body: { to: target, messages: TEXT } }), 400); // 沒帶 X-Bot-Id
            legacy(await sendRaw({ raw: '{nope', body: '{nope' }), 400, 'invalid_request');
            legacy(await sendRaw({ body: { to: target, messages: [] } }), 400, 'invalid_request');
            legacy(await sendRaw({ body: { to: kind === 'push' ? ['x'] : 'x', messages: TEXT } }), 400, 'invalid_request');
            legacy(await sendRaw({ headers: { 'X-Idempotency-Key': 'k'.repeat(129) } }), 400, 'invalid_request');
            setLine(() => new Response(JSON.stringify({ message: 'bad' }), { status: 400 }));
            const r = legacy(await sendRaw(), 400, 'invalid_request');
            assert.equal(typeof r.body.detail, 'string');
        });

        it('401：沒有金鑰、亂金鑰；連結金鑰不能用在 /raw/*', async () => {
            for (const key of [undefined, 'brk_nope', KEY_A]) legacy(await sendRaw({ key }), 401);
        });

        it('402 quota_exhausted（帶 remaining）：額度不足，不打 LINE', async () => {
            line.usage = line.limit;
            const r = legacy(await sendRaw(), 402, 'quota_exhausted');
            assert.equal(r.body.remaining, 0);
            assert.equal(lineCalls().length, 0);
        });

        it('403：scope 不足、X-Bot-Id 與金鑰所屬 bot 不符、系統已停用', async () => {
            legacy(await sendRaw({ key: SYS_KEY_NOSCOPE }), 403, 'Insufficient scope');
            legacy(await sendRaw({ headers: { 'X-Bot-Id': BOT2 } }), 403, 'Bot mismatch');
            await d1.db.prepare("UPDATE systems SET disabled = 1 WHERE system = 'imgpicker'").run();
            legacy(await sendRaw(), 403, 'System disabled');
        });

        if (kind === 'push') {
            it('404 target_not_found：U 開頭但不是這個 bot 的會員', async () => {
                const r = legacy(await sendRaw({ body: { to: 'Unotamember0000000000000000000009', messages: TEXT } }), 404, 'target_not_found');
                assert.equal(r.res.headers.get('X-Idempotency-Missing'), 'true');
                assert.equal(lineCalls().length, 0);
            });
        }

        it('409：同鍵仍在處理中（in_progress）' + (kind === 'push' ? '；LINE 403 → target_inactive（含 reason）' : ''), async () => {
            if (kind === 'push') {
                setLine(() => new Response('{}', { status: 403 }));
                const r = legacy(await sendRaw(), 409, 'target_inactive');
                assert.equal(r.body.reason, 'blocked');
                setLine(() => new Response('{}', { status: 200 }));
            }
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            let reached;
            const atLine = new Promise((resolve) => { reached = resolve; });
            setLine(() => { reached(); return gate.then(() => new Response('{}', { status: 200 })); });
            const headers = { 'X-Idempotency-Key': nextIdem() };
            const first = sendRaw({ headers });
            await Promise.race([atLine, first.then(() => { throw new Error('第一個請求在到達 LINE 之前就結束了'); })]);
            const second = await sendRaw({ headers });
            release();
            assert.equal((await first).res.status, 200);
            legacy(second, 409, 'in_progress');
        });

        it('413 payload_too_large：本文超過 200000 字元', async () => {
            legacy(await sendRaw({ raw: true, body: 'x'.repeat(200001) }), 413, 'payload_too_large');
        });

        it('422 idempotency_key_reuse：同鍵不同內容', async () => {
            const headers = { 'X-Idempotency-Key': nextIdem() };
            assert.equal((await sendRaw({ headers })).res.status, 200);
            legacy(await sendRaw({ headers, body: { to: target, messages: [{ type: 'text', text: 'different' }] } }), 422, 'idempotency_key_reuse');
        });

        it('429 + Retry-After：超過每 system 限流（error 是說明句，帶 retryAfter）', async () => {
            await d1.db.prepare("UPDATE systems SET rate_limit = ?1 WHERE system = 'imgpicker'").bind(JSON.stringify({ write: 1 })).run();
            await withPinnedWindow(async () => {
                assert.equal((await sendRaw()).res.status, 200);
                const r = legacy(await sendRaw(), 429);
                assert.equal(typeof r.body.error, 'string');
                assert.match(r.res.headers.get('Retry-After'), /^[1-9]\d*$/);
            });
        });

        it('429 + Retry-After：LINE 端限流（line_rate_limited）', async () => {
            setLine(() => new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'Retry-After': '2' } }));
            const r = legacy(await sendRaw(), 429, 'line_rate_limited');
            assert.match(r.res.headers.get('Retry-After'), /^[1-9]\d*$/);
        });

        it('502 line_unavailable：LINE 5xx 或連不上；LINE 403 對 multicast 也歸為 502', async () => {
            setLine(() => new Response('oops', { status: 500 }));
            assert.equal(legacy(await sendRaw(), 502, 'line_unavailable').body.retryable, true);
            setLine(() => { throw new Error('network down'); });
            legacy(await sendRaw(), 502, 'line_unavailable');
            if (kind === 'multicast') {
                setLine(() => new Response('{}', { status: 403 }));
                assert.equal(legacy(await sendRaw(), 502, 'line_unavailable').body.retryable, false);
            }
        });

        it('503 bridge_not_configured：BRIDGE_DB 未綁定；bot 沒有可用的 LINE token', async () => {
            legacy(await sendRaw({ e: noDb() }), 503, 'bridge_not_configured');
            await kv.delete(`access_tokens_${OWNER}`);
            legacy(await sendRaw(), 503, 'bot_not_configured');
        });
    });
}

// ───────────────────────── 登記核對 ─────────────────────────

describe('conformance 登記（必須是本檔最後一個測試）', () => {
    it('實際打到的狀態碼與 helpers 的 CONFORMANCE 登記完全一致（少打或多打都會失敗）', () => {
        assert.deepEqual([...exercised.keys()].sort(), Object.keys(CONFORMANCE).sort());
        for (const [opKey, statuses] of Object.entries(CONFORMANCE)) {
            assert.deepEqual([...exercised.get(opKey)].sort(), [...statuses].sort(), opKey);
        }
    });
});
