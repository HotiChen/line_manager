/**
 * Unit Tests — LM-4D 客人分眾（端到端經 handleBridge，真 D1、記憶體 KV、假 LINE）
 *
 *   PUT /bridge/v1/contacts/{ref}/segment   連結金鑰＋segments:write
 *   PATCH /bridge/v1/admin/products/{id}    營運密鑰：補 product_key（只能一次）、scope 只增不減
 *
 * 分眾的真相在 D1（contacts.segment）；LM 讀 KV 會員資料的副本 productSegments，
 * 由 Bridge 在每次變更後經 lm_service 寫入並重新計算 Rich Menu（4R 的規則）。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedLink, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import * as bdb from '../../worker_src/bridge/db.js';
import { generateBindCode, tryConsumeBindCode, markBlocked } from '../../worker_src/bridge/binding.js';
import { setRetrySleepForTest, SEGMENT_RE } from '../../worker_src/bridge/segments.js';

const ORIGIN = 'https://worker.example.com';
const ADMIN = 'test-admin-secret-not-real';
const OWNER = 'Uowner0000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const LNK_A = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const LNK_NOSCOPE = 'lnk_cccccccccccccccc';
const PRD_A = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const PRD_NOKEY = 'prd_cccccccccccc';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const KEY_NOSCOPE = 'brk_cccccc_link-key-noscope-0000000000000000000';
const USER = 'Uline0000000000000000000000000001';
const USER2 = 'Uline0000000000000000000000000002';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const SCOPES = ['link:manage', 'contacts:bind', 'messages:send', 'segments:write'];
const RM_A = 'richmenu-aaaa-vip';
const RM_G = 'richmenu-gggg-gold';

let d1;
let env;
let kv;
let seen;      // 回應文字
let lineCalls; // 對 LINE 的 Rich Menu 呼叫
let lineFails; // >0 時 Rich Menu 呼叫回 500，並遞減
let audits;
const originalError = console.error;
const originalFetch = globalThis.fetch;

before(async () => { d1 = await createTestD1(); setRetrySleepForTest(async () => {}); });
after(async () => { setRetrySleepForTest(null); await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', BRIDGE_ADMIN_SECRET: ADMIN };
    seen = [];
    lineCalls = [];
    lineFails = 0;
    console.error = () => {};
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/richmenu')) {
            lineCalls.push({ method: init.method || 'GET', url: u });
            if (lineFails > 0) { lineFails--; return new Response('{}', { status: 500 }); }
            return new Response('{}', { status: 200 });
        }
        if (u.includes('/message/push')) return new Response('{}', { status: 200 });
        throw new Error(`unexpected fetch ${u}`);
    };
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: 'TOKEN_X', destination: BOT } }));
    await kv.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }], currentBotId: BOT }));
    await kv.put(BotKeys.segmentedRichMenuRules(BOT), JSON.stringify([
        { match: { segment: 'ip:vip' }, priority: 3, richMenuId: RM_A },
        { match: { segment: 'xx:gold' }, priority: 4, richMenuId: RM_G },
    ]));
    for (const u of [USER, USER2]) await kv.put(BotKeys.member(BOT, u), JSON.stringify({ memberId: u, tags: [] }));

    await seedLink(d1.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A, scopes: SCOPES });
    await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT, key: KEY_B, scopes: SCOPES });
    await seedLink(d1.db, { linkId: LNK_NOSCOPE, productId: PRD_NOKEY, botId: BOT, key: KEY_NOSCOPE, scopes: ['contacts:bind'] });
    await d1.db.prepare("UPDATE products SET product_key = 'ip' WHERE product_id = ?1").bind(PRD_A).run();
    await d1.db.prepare("UPDATE products SET product_key = 'xx' WHERE product_id = ?1").bind(PRD_B).run();
    await bindContact(LNK_A, REF, USER);
});
afterEach(() => { console.error = originalError; globalThis.fetch = originalFetch; });

async function bindContact(linkId, ref, user, status = 'bound') {
    await d1.db.prepare(
        `INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)`
    ).bind(linkId, ref, BOT, user, status).run();
}

async function call(method, path, { key, headers = {}, body, raw, ctx } = {}) {
    const init = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } };
    if (body !== undefined) {
        init.body = raw ? body : JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), env, url.pathname, ctx);
    const text = await res.text();
    seen.push(text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 204 */ }
    return { res, text, body: parsed };
}

const errCode = (r) => r.body && r.body.error && r.body.error.code;
const put = (segment, { ref = REF, key = KEY_A, ctx, raw } = {}) =>
    call('PUT', `/bridge/v1/contacts/${ref}/segment`, { key, body: raw ?? { segment }, raw: raw !== undefined, ctx });
const segmentOf = async (linkId = LNK_A, ref = REF) =>
    (await d1.db.prepare('SELECT segment FROM contacts WHERE link_id = ?1 AND external_contact_ref = ?2').bind(linkId, ref).first())?.segment;
const kvSegments = async (u = USER) => JSON.parse(await kv.get(BotKeys.member(BOT, u))).productSegments;
const linked = (u, rm) => lineCalls.some((c) => c.method === 'POST' && c.url.endsWith(`/user/${u}/richmenu/${rm}`));
const unlinked = (u) => lineCalls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/user/${u}/richmenu`));
const auditRows = () => all(d1.db, 'SELECT action, result, detail FROM audit_log ORDER BY id');

// ───────────────────────── PUT segment ─────────────────────────

describe('PUT /contacts/{ref}/segment', () => {
    it('設定 → 204；D1 記錄、KV 副本更新、依規則切換 Rich Menu', async () => {
        const r = await put('vip');
        assert.equal(r.res.status, 204, r.text);
        assert.equal(r.text, '');
        assert.equal(await segmentOf(), 'vip');
        assert.deepEqual(await kvSegments(), ['ip:vip']);
        assert.ok(linked(USER, RM_A));
    });

    it('冪等：同樣的值再送一次 → 204，不再呼叫 LINE、不再寫稽核', async () => {
        await put('vip');
        const calls = lineCalls.length;
        const audits = (await auditRows()).length;
        const r = await put('vip');
        assert.equal(r.res.status, 204);
        assert.equal(lineCalls.length, calls);
        assert.equal((await auditRows()).length, audits);
    });

    it('null 清除 → 204；KV 清空、解除個人選單', async () => {
        await put('vip');
        const r = await put(null);
        assert.equal(r.res.status, 204);
        assert.equal(await segmentOf(), null);
        assert.deepEqual(await kvSegments(), []);
        assert.ok(unlinked(USER));
    });

    it('一位客人在多個產品各有分眾 → KV 副本含全部（依規則取最優先）', async () => {
        await bindContact(LNK_B, REF2, USER);
        await put('gold', { ref: REF2, key: KEY_B });
        await put('vip');
        assert.deepEqual((await kvSegments()).sort(), ['ip:vip', 'xx:gold']);
        assert.ok(linked(USER, RM_A));
    });

    it('格式不合 → 400 INVALID_REQUEST，不寫入', async () => {
        for (const bad of ['VIP', '1vip', 'v'.repeat(33), 'vip!', '', 3, true, {}, []]) {
            const r = await put(bad);
            assert.equal(r.res.status, 400, JSON.stringify(bad));
            assert.equal(errCode(r), 'INVALID_REQUEST');
        }
        for (const raw of ['{}', 'not json', '[]']) {
            const r = await put(undefined, { raw });
            assert.equal(r.res.status, 400, raw);
        }
        assert.equal(await segmentOf(), null);
    });

    it('分眾允許 a-z0-9_- 、最長 32', () => {
        assert.ok(SEGMENT_RE.test('vip_gold-2'));
        assert.ok(SEGMENT_RE.test(`a${'b'.repeat(31)}`));
        assert.ok(!SEGMENT_RE.test(`a${'b'.repeat(32)}`));
    });

    it('未綁定、不存在的 ref → 409 CONTACT_NOT_BOUND（不洩漏是否存在）', async () => {
        for (const ref of [REF2, 'never-existed-1']) {
            const r = await put('vip', { ref });
            assert.equal(r.res.status, 409);
            assert.equal(errCode(r), 'CONTACT_NOT_BOUND');
        }
        // 別條連結的 ref 看起來也是沒綁定
        await bindContact(LNK_B, REF2, USER2);
        assert.equal(errCode(await put('vip', { ref: REF2 })), 'CONTACT_NOT_BOUND');
    });

    it('blocked → 409 RECIPIENT_BLOCKED', async () => {
        await bindContact(LNK_A, REF2, USER2, 'blocked');
        const r = await put('vip', { ref: REF2 });
        assert.equal(r.res.status, 409);
        assert.equal(errCode(r), 'RECIPIENT_BLOCKED');
    });

    it('路徑上的 ref 格式不對 → 404', async () => {
        const r = await put('vip', { ref: 'bad' });
        assert.equal(r.res.status, 404);
    });

    it('沒有 segments:write → 403 SCOPE_DENIED；撤銷的連結 → 403 LINK_REVOKED；沒金鑰 → 401', async () => {
        await bindContact(LNK_NOSCOPE, REF, USER);
        assert.equal(errCode(await put('vip', { key: KEY_NOSCOPE })), 'SCOPE_DENIED');
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK_A).run();
        assert.equal(errCode(await put('vip')), 'LINK_REVOKED');
        assert.equal(errCode(await put('vip', { key: 'brk_nope' })), 'INVALID_KEY');
    });

    it('產品沒有 product_key → 400 INVALID_REQUEST', async () => {
        await d1.db.prepare("UPDATE products SET product_key = NULL WHERE product_id = ?1").bind(PRD_A).run();
        const r = await put('vip');
        assert.equal(r.res.status, 400);
        assert.match(r.body.error.message, /product_key/);
    });

    it('限流：每條連結每分鐘 60 次，第 61 次 → 429 RATE_LIMITED', async () => {
        for (let i = 0; i < 60; i++) assert.equal((await put(undefined, { raw: '{}' })).res.status, 400);
        const r = await put('vip');
        assert.equal(r.res.status, 429);
        assert.equal(errCode(r), 'RATE_LIMITED');
        assert.ok(r.res.headers.get('Retry-After'));
    });

    it('LINE 失敗 → 重試（共 3 次），PUT 仍是 204、分眾已記錄', async () => {
        lineFails = 2;
        const r = await put('vip');
        assert.equal(r.res.status, 204);
        assert.equal(lineCalls.filter((c) => c.method === 'POST').length, 3);
        assert.equal(await segmentOf(), 'vip');
    });

    it('LINE 一直失敗 → 3 次後放棄，PUT 仍是 204', async () => {
        lineFails = 99;
        const r = await put('vip');
        assert.equal(r.res.status, 204);
        assert.equal(lineCalls.length, 3);
    });

    it('有 ctx 時重新計算放進 waitUntil（回應不等 LINE）', async () => {
        const pending = [];
        const r = await put('vip', { ctx: { waitUntil: (p) => pending.push(p) } });
        assert.equal(r.res.status, 204);
        assert.equal(pending.length, 1);
        await Promise.all(pending);
        assert.ok(linked(USER, RM_A));
    });

    it('回應與稽核不含 LINE userId、ref、Rich Menu id、分眾值', async () => {
        await put('vip');
        await put(null);
        const rows = await auditRows();
        const set = rows.filter((x) => x.action === 'contact_segment_set');
        assert.equal(set.length, 2);
        assert.deepEqual(JSON.parse(set[0].detail), { product_id: PRD_A, link_id: LNK_A, cleared: false });
        assert.deepEqual(JSON.parse(set[1].detail), { product_id: PRD_A, link_id: LNK_A, cleared: true });
        const dump = JSON.stringify(rows) + seen.join('\n');
        for (const s of [USER, REF, RM_A, 'vip']) assert.ok(!dump.includes(s), s);
    });
});

describe('GET /contacts/{ref} 加 segment', () => {
    it('bound：回目前的分眾或 null；未綁定：null', async () => {
        let r = await call('GET', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal(r.body.segment, null);
        await put('vip');
        r = await call('GET', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal(r.body.status, 'bound');
        assert.equal(r.body.segment, 'vip');
        r = await call('GET', `/bridge/v1/contacts/${REF2}`, { key: KEY_A });
        assert.equal(r.body.status, 'unbound');
        assert.equal(r.body.segment, null);
    });
});

// ───────────────────────── 清除時機 ─────────────────────────

describe('清除時機', () => {
    beforeEach(async () => { await put('vip'); lineCalls = []; });

    it('DELETE /contacts/{ref}（解除綁定）→ KV 清空、解除個人選單', async () => {
        const r = await call('DELETE', `/bridge/v1/contacts/${REF}`, { key: KEY_A });
        assert.equal(r.res.status, 204);
        assert.deepEqual(await kvSegments(), []);
        assert.ok(unlinked(USER));
    });

    it('封鎖（unfollow）→ D1 分眾清掉、KV 清空；不呼叫 LINE', async () => {
        assert.equal(await markBlocked(env, { botId: BOT, lineUserId: USER }), 1);
        assert.equal(await segmentOf(), null);
        assert.deepEqual(await kvSegments(), []);
        assert.equal(lineCalls.length, 0);
    });

    it('產品自己撤銷連結 → 分眾清掉、重新計算', async () => {
        const r = await call('DELETE', `/bridge/v1/links/${LNK_A}`, { key: KEY_A });
        assert.equal(r.res.status, 204, r.text);
        assert.equal(await segmentOf(), null);
        assert.deepEqual(await kvSegments(), []);
        assert.ok(unlinked(USER));
    });

    it('後台撤銷連結 → 同上', async () => {
        env.AUTH_MODE = 'legacy';
        await kv.put(BotKeys.permissions(BOT), JSON.stringify({ users: [{ userId: OWNER, role: 'owner' }] }));
        const r = await call('DELETE', `/bridge/v1/admin/links/${LNK_A}`, { headers: { 'X-User-Id': OWNER, 'X-Bot-Id': BOT } });
        assert.equal(r.res.status, 204, r.text);
        assert.equal(await segmentOf(), null);
        assert.deepEqual(await kvSegments(), []);
        assert.ok(unlinked(USER));
    });

    it('連結被取代（重新授權搬家）→ 搬過去的列分眾清掉', async () => {
        const { captureReplacedRecipients, refreshRecipients } = await import('../../worker_src/bridge/segments.js');
        const handle = await captureReplacedRecipients(env, { productId: PRD_A, botId: BOT });
        await bdb.createLinkWithKey(env, {
            linkId: 'lnk_dddddddddddddddd', productId: PRD_A, botId: BOT, scopes: SCOPES, createdBy: OWNER, keyHash: 'h-new',
        });
        await refreshRecipients(env, handle);
        assert.equal(await segmentOf('lnk_dddddddddddddddd'), null);
        assert.equal(await count(d1.db, 'contacts', 'link_id = ?1', 'lnk_dddddddddddddddd'), 1);
        assert.deepEqual(await kvSegments(), []);
        assert.ok(unlinked(USER));
    });

    it('別的產品的分眾不受影響', async () => {
        await bindContact(LNK_B, REF2, USER);
        await put('gold', { ref: REF2, key: KEY_B });
        await call('DELETE', `/bridge/v1/links/${LNK_A}`, { key: KEY_A });
        assert.deepEqual(await kvSegments(), ['xx:gold']);
    });
});

describe('綁定／重新綁定', () => {
    async function issue(ref, { allowRebind = false } = {}) {
        const code = generateBindCode();
        await bdb.createBindCode(env, {
            codeHash: await sha256Hex(code), linkId: LNK_A, botId: BOT, ref, expiresAt: Date.now() + 1e6, allowRebind, now: Date.now(),
        });
        return code;
    }

    it('有分眾的 ref 被別人重新綁定 → 新綁定者套用分眾、原綁定者清空', async () => {
        await put('vip');
        lineCalls = [];
        const code = await issue(REF, { allowRebind: true });
        const pending = [];
        const r = await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: code, ctx: { waitUntil: (p) => pending.push(p) } });
        assert.equal(r.handled, true);
        await Promise.all(pending);
        assert.deepEqual(await kvSegments(USER2), ['ip:vip']);
        assert.deepEqual(await kvSegments(USER), []);
        assert.ok(linked(USER2, RM_A));
    });

    it('沒有分眾的 ref 綁定 → 不呼叫 Rich Menu API', async () => {
        const code = await issue(REF2);
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: code });
        assert.equal(lineCalls.length, 0);
    });
});

// ───────────────────────── 營運：產品 product_key 與 scope ─────────────────────────

describe('營運端點：product_key', () => {
    const admin = (method, path, body, secret = ADMIN) =>
        call(method, path, { headers: { Authorization: `Bearer ${secret}` }, body });
    const patch = (id, body, secret) => admin('PATCH', `/bridge/v1/admin/products/${id}`, body, secret);

    it('POST 登記可帶 product_key；重複 → 400', async () => {
        const base = { name: 'P', redirect_uris: ['https://p.example.com/cb'], scopes: ['contacts:bind'] };
        const r = await admin('POST', '/bridge/v1/admin/products', { ...base, product_key: 'pp' });
        assert.equal(r.res.status, 201, r.text);
        assert.equal(r.body.product_key, 'pp');
        const dup = await admin('POST', '/bridge/v1/admin/products', { ...base, product_key: 'ip' });
        assert.equal(dup.res.status, 400);
        const bad = await admin('POST', '/bridge/v1/admin/products', { ...base, product_key: 'IP' });
        assert.equal(bad.res.status, 400);
    });

    it('PATCH 補 product_key（只能從 NULL 設一次）', async () => {
        let r = await patch(PRD_NOKEY, { product_key: 'zz' });
        assert.equal(r.res.status, 200, r.text);
        assert.equal(r.body.product_key, 'zz');
        r = await patch(PRD_NOKEY, { product_key: 'zz' });
        assert.equal(r.res.status, 200, '同值再送是冪等');
        r = await patch(PRD_NOKEY, { product_key: 'yy' });
        assert.equal(r.res.status, 400);
        r = await patch(PRD_B, { product_key: 'ip' });
        assert.equal(r.res.status, 400);
        const row = await d1.db.prepare('SELECT product_key AS k FROM products WHERE product_id = ?1').bind(PRD_NOKEY).first();
        assert.equal(row.k, 'zz');
    });

    it('PATCH 撞到別的產品的 product_key → 400', async () => {
        const r = await patch(PRD_NOKEY, { product_key: 'ip' });
        assert.equal(r.res.status, 400);
    });

    it('PATCH scopes 只能增加，且限 LINK_SCOPES', async () => {
        let r = await patch(PRD_NOKEY, { scopes: ['contacts:bind', 'segments:write'] });
        assert.equal(r.res.status, 200, r.text);
        assert.deepEqual(r.body.scopes, ['contacts:bind', 'segments:write']);
        r = await patch(PRD_NOKEY, { scopes: ['segments:write'] });
        assert.equal(r.res.status, 400, '少了 contacts:bind');
        r = await patch(PRD_NOKEY, { scopes: ['contacts:bind', 'segments:write', 'raw:push'] });
        assert.equal(r.res.status, 400);
        // 既有連結不會自動取得新 scope
        const link = await d1.db.prepare('SELECT scopes FROM links WHERE link_id = ?1').bind(LNK_NOSCOPE).first();
        assert.deepEqual(JSON.parse(link.scopes), ['contacts:bind']);
    });

    it('密鑰錯 → 401；未設定營運密鑰 → 404；產品不存在 → 404；寫稽核', async () => {
        assert.equal((await patch(PRD_NOKEY, { product_key: 'zz' }, 'wrong')).res.status, 401);
        assert.equal((await patch('prd_ffffffffffff', { product_key: 'zz' })).res.status, 404);
        env.BRIDGE_ADMIN_SECRET = '';
        assert.equal((await patch(PRD_NOKEY, { product_key: 'zz' })).res.status, 404);
        env.BRIDGE_ADMIN_SECRET = ADMIN;
        await patch(PRD_NOKEY, { product_key: 'zz' });
        assert.ok((await auditRows()).some((x) => x.action === 'product_updated'));
    });
});

describe('缺 0005 遷移 → fail-closed', () => {
    it('PUT segment → 503 bridge_not_configured', async () => {
        const old = await createTestD1({ upTo: '0004' });
        try {
            await seedLink(old.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A, scopes: SCOPES });
            env.BRIDGE_DB = old.db;
            const r = await put('vip');
            assert.equal(r.res.status, 503);
            assert.equal(r.body.error.message, 'bridge_not_configured');
        } finally {
            env.BRIDGE_DB = d1.db;
            await old.dispose();
        }
    });
});
