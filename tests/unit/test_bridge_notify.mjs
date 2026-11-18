/**
 * Unit Tests — bridge/notify.js（LM-3B 受限通知端點，端到端經 handleBridge，真 D1）
 *
 *   POST /bridge/v1/messages   連結金鑰（messages:send）
 *
 * 不變量：認證（系統金鑰、無 scope、撤銷連結都擋下）；ref 只在連結範圍內解析；冪等（D1，system = link:{id}）；
 * 只快取成功與確定性失敗；LINE 錯誤對映；額度用盡不打 LINE；限流（每連結、每聯絡人）；
 * 回應、audit、冪等紀錄、KV key 與 console 都不含 ref、LINE userId、標題、內文、網址。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { withPinnedWindow } from '../helpers/pin_time.mjs';
import { seedLink, seedSystem, seedKey, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import { isNotifyRoute, isBridgeServiceRoute, isContactsRoute, isLinkRoute, isSystemsRoute } from '../../worker_src/bridge/routes.js';
import { retryKeyFor } from '../../worker_src/bridge/retry_key.js';
import { buildFlexMessage } from '../../worker_src/bridge/notify.js';
import { writeAudit } from '../../worker_src/bridge/db.js';
import { currentPeriod } from '../../worker_src/bridge/quota.js';

const ORIGIN = 'https://worker.example.com';
const OWNER = 'Uowner0000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const LNK_A = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const LNK_C = 'lnk_cccccccccccccccc';
const PRD_A = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const PRD_C = 'prd_cccccccccccc';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const KEY_C = 'brk_cccccc_link-key-for-c-0000000000000000000000';
const SYS_KEY = 'brk_dddddd_system-key-0000000000000000000000000';
const LINE_USER = 'Uline0000000000000000000000000001';
const LINE_USER_C = 'Uline0000000000000000000000000003';
const LINE_TOKEN = 'TOKEN_SECRET_VALUE_X';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const TITLE = '出貨通知TITLEMARK';
const BODY = '您的訂單已出貨BODYMARK\n請留意收件';
const URL_OK = 'https://picker.example.com/orders/1?tokenmark=1';
const DOMAINS = ['picker.example.com'];
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';

let d1;
let env;
let kv;
let line;
let seen; // 所有回應本文
let logs; // console 輸出
let idemSeq = 0;
const originalFetch = globalThis.fetch;
const consoleMethods = ['error', 'warn', 'log', 'info'];
const originalConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });

/** LINE 那一側的假伺服器 */
function installLine() {
    line = {
        usage: 10,
        limit: 200,
        pushCalls: [],
        push: () => new Response('{}', { status: 200 }),
    };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v2/bot/message/quota/consumption')) return new Response(JSON.stringify({ totalUsage: line.usage }), { status: 200 });
        if (u.endsWith('/v2/bot/message/quota')) return new Response(JSON.stringify({ type: 'limited', value: line.limit }), { status: 200 });
        if (u === PUSH_URL) {
            line.pushCalls.push({ init, body: JSON.parse(init.body), headers: init.headers });
            return line.push(line.pushCalls.length);
        }
        throw new Error(`unexpected fetch ${u}`);
    };
}

async function bindContact(linkId, ref, userId, { status = 'bound', botId = BOT } = {}) {
    await d1.db.prepare(
        'INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)'
    ).bind(linkId, ref, botId, userId, status).run();
}

async function setDomains(productId, domains) {
    await d1.db.prepare('UPDATE products SET url_domains = ?2 WHERE product_id = ?1').bind(productId, JSON.stringify(domains)).run();
}

beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1' };
    seen = [];
    logs = [];
    for (const m of consoleMethods) console[m] = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    installLine();
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: LINE_TOKEN, destination: BOT } }));
    await seedLink(d1.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A });
    await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT2, key: KEY_B });
    await setDomains(PRD_A, DOMAINS);
    await setDomains(PRD_B, DOMAINS);
    await bindContact(LNK_A, REF, LINE_USER);
});
afterEach(() => {
    for (const m of consoleMethods) console[m] = originalConsole[m];
    globalThis.fetch = originalFetch;
});

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
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { res, text, body: parsed };
}

/** LINE 的下一次 push 回 `first`（Response 或會丟錯的函式），之後都成功 */
function failOnce(first) {
    let used = false;
    line.push = () => {
        if (used) return new Response('{}', { status: 200 });
        used = true;
        return typeof first === 'function' ? first() : first;
    };
}
const nextIdem = () => `idem-${++idemSeq}-${Math.random().toString(36).slice(2, 8)}`;
const notification = (over = {}) => ({ external_contact_ref: REF, event_type: 'order.shipped', title: TITLE, body: BODY, ...over });
/** idem: undefined → 自動產生；null → 不帶標頭 */
function send(over = {}, { key = KEY_A, idem, headers = {}, raw, e } = {}) {
    const h = { ...headers };
    const k = idem === undefined ? nextIdem() : idem;
    if (k !== null) h['Idempotency-Key'] = k;
    return call('POST', '/bridge/v1/messages', { key, headers: h, body: raw === undefined ? notification(over) : raw, raw: raw !== undefined, e });
}
const errCode = (r) => r.body && r.body.error && r.body.error.code;
const auditRows = () => all(d1.db, 'SELECT * FROM audit_log ORDER BY id');
const idemRows = () => all(d1.db, 'SELECT * FROM idempotency');
const bridgeErrorShape = (r) => assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message', 'retryable']);

// ───────────────────────── 路由分類與認證 ─────────────────────────

describe('路由分類', () => {
    it('/bridge/v1/messages 精確比對是通知路由，不是 service key／systems／contacts／links 路由', () => {
        assert.equal(isNotifyRoute('/bridge/v1/messages'), true);
        assert.equal(isBridgeServiceRoute('/bridge/v1/messages'), false);
        assert.equal(isSystemsRoute('/bridge/v1/messages'), false);
        assert.equal(isContactsRoute('/bridge/v1/messages'), false);
        assert.equal(isLinkRoute('/bridge/v1/messages'), false);
    });

    it('相似路徑不算通知路由（仍走 service key 認證 → 最後 404）', () => {
        for (const p of ['/bridge/v1/messages/', '/bridge/v1/messages/push', '/bridge/v1/messages/msg_0123456789abcdef', '/bridge/v1/messagesX', '/bridge/v1/message', '/bridge/v2/messages', '/bridge/v1/raw/messages']) {
            assert.equal(isNotifyRoute(p), false, p);
        }
        assert.equal(isBridgeServiceRoute('/bridge/v1/messages/'), true);
        assert.equal(isBridgeServiceRoute('/bridge/v1/messagesX'), true);
    });
});

describe('認證與授權', () => {
    it('沒有 key、格式不對的 Authorization → 401 INVALID_KEY，沒打 LINE，沒寫冪等紀錄', async () => {
        for (const headers of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer nonexistent-key' }]) {
            const r = await call('POST', '/bridge/v1/messages', { headers: { ...headers, 'Idempotency-Key': nextIdem() }, body: notification() });
            assert.equal(r.res.status, 401, JSON.stringify(headers));
            assert.equal(errCode(r), 'INVALID_KEY');
            bridgeErrorShape(r);
        }
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(d1.db, 'idempotency'), 0);
    });

    it('系統金鑰（即使 scope 含 messages:send）→ 401 INVALID_KEY，與其他連結端點相同', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', scopes: ['raw:push', 'messages:send'] });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYS_KEY, scopes: ['raw:push', 'messages:send'] });
        const r = await send({}, { key: SYS_KEY, headers: { 'X-Bot-Id': BOT } });
        assert.equal(r.res.status, 401);
        assert.equal(errCode(r), 'INVALID_KEY');
        assert.equal(line.pushCalls.length, 0);
        // 與其他連結端點同一個回應
        const other = await call('POST', '/bridge/v1/contacts/bind-tokens', { key: SYS_KEY, headers: { 'X-Bot-Id': BOT }, body: { external_contact_ref: REF } });
        assert.equal(other.res.status, r.res.status);
        assert.deepEqual(other.body, r.body);
    });

    it('連結沒有 messages:send scope → 403 SCOPE_DENIED', async () => {
        await seedLink(d1.db, { linkId: LNK_C, productId: PRD_C, botId: BOT, key: KEY_C, scopes: ['link:manage', 'contacts:bind'] });
        const r = await send({}, { key: KEY_C });
        assert.equal(r.res.status, 403);
        assert.equal(errCode(r), 'SCOPE_DENIED');
        assert.equal(line.pushCalls.length, 0);
    });

    it('連結已撤銷、產品停用 → 403 LINK_REVOKED，沒打 LINE', async () => {
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK_A).run();
        const r1 = await send();
        assert.equal(r1.res.status, 403);
        assert.equal(errCode(r1), 'LINK_REVOKED');
        await d1.db.prepare("UPDATE links SET status = 'active' WHERE link_id = ?1").bind(LNK_A).run();
        await d1.db.prepare('UPDATE products SET disabled = 1 WHERE product_id = ?1').bind(PRD_A).run();
        const r2 = await send();
        assert.equal(r2.res.status, 403);
        assert.equal(errCode(r2), 'LINK_REVOKED');
        assert.equal(line.pushCalls.length, 0);
    });

    it('連結金鑰仍然通不過 /raw/* 與 /systems*（401）', async () => {
        const raw = await call('POST', '/bridge/v1/raw/push', { key: KEY_A, headers: { 'X-Bot-Id': BOT }, body: { to: LINE_USER, messages: [{ type: 'text', text: 'x' }] } });
        assert.equal(raw.res.status, 401);
        assert.deepEqual(raw.body, { success: false, error: 'Invalid or revoked service key' });
        const multi = await call('POST', '/bridge/v1/raw/multicast', { key: KEY_A, headers: { 'X-Bot-Id': BOT }, body: { to: [LINE_USER], messages: [{ type: 'text', text: 'x' }] } });
        assert.equal(multi.res.status, 401);
        const sys = await call('GET', '/bridge/v1/systems', { key: KEY_A, headers: { 'X-Bot-Id': BOT } });
        assert.equal(sys.res.status, 401);
        assert.equal(line.pushCalls.length, 0);
    });

    it('路徑與方法：不允許的方法、/messages 之下的路徑 → 404（不認證、不碰 D1）', async () => {
        for (const [m, p] of [['GET', '/bridge/v1/messages'], ['PUT', '/bridge/v1/messages'], ['DELETE', '/bridge/v1/messages'], ['PATCH', '/bridge/v1/messages']]) {
            const r = await call(m, p, { key: KEY_A });
            assert.equal(r.res.status, 404, `${m} ${p}`);
            assert.equal(errCode(r), 'NOT_FOUND');
        }
        for (const p of ['/bridge/v1/messages/', '/bridge/v1/messages/push', '/bridge/v1/messages/msg_0123456789abcdef']) {
            const r = await call('POST', p, { key: KEY_A, headers: { 'Idempotency-Key': nextIdem() }, body: notification() });
            assert.equal(r.res.status, 404, p);
            assert.deepEqual(r.body, { success: false, error: 'Not Found' });
        }
        assert.equal(line.pushCalls.length, 0);
    });

    it('旗標關閉 → 與未知路由相同的 404（不認證、不碰 D1）', async () => {
        for (const flag of [undefined, '0', 'true', '']) {
            const r = await send({}, { e: { ...env, BRIDGE_ENABLED: flag } });
            assert.equal(r.res.status, 404);
            assert.deepEqual(r.body, { success: false, error: 'Not Found' });
        }
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(d1.db, 'idempotency'), 0);
        assert.equal(await count(d1.db, 'audit_log'), 0);
    });

    it('缺 BRIDGE_DB → 503 INTERNAL bridge_not_configured，沒打 LINE', async () => {
        const r = await send({}, { e: { ...env, BRIDGE_DB: undefined } });
        assert.equal(r.res.status, 503);
        assert.equal(errCode(r), 'INTERNAL');
        assert.equal(r.body.error.message, 'bridge_not_configured');
        assert.equal(line.pushCalls.length, 0);
    });

    it('資料庫查詢失敗（認證通過後）→ 503，不洩漏 SQL 或 stack', async () => {
        const failing = { prepare: (sql) => (/FROM contacts/.test(sql) ? { bind: () => ({ first: async () => { throw new Error('boom SECRET_SQL_DETAIL'); } }) } : d1.db.prepare(sql)), batch: (...a) => d1.db.batch(...a) };
        const r = await send({}, { e: { ...env, BRIDGE_DB: failing } });
        assert.equal(r.res.status, 503);
        assert.equal(r.body.error.message, 'bridge_not_configured');
        assert.ok(!r.text.includes('SECRET_SQL_DETAIL') && !/stack|at .*\(/.test(r.text));
        assert.equal(line.pushCalls.length, 0);
        // 搶佔的冪等紀錄被放掉，重試不會被卡住
        assert.equal(await count(d1.db, 'idempotency'), 0);
    });
});

// ───────────────────────── 請求驗證 ─────────────────────────

describe('請求驗證（失敗都是 400，不打 LINE、不留冪等紀錄）', () => {
    async function expectInvalid(r, label) {
        assert.equal(r.res.status, 400, label);
        assert.equal(errCode(r), 'INVALID_REQUEST', label);
        assert.equal(r.body.error.retryable, false);
        bridgeErrorShape(r);
    }
    const afterwards = async () => {
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(d1.db, 'idempotency'), 0);
    };

    it('Idempotency-Key 缺少、空字串、超過 128 字元 → 400；128 字元可以', async () => {
        await expectInvalid(await send({}, { idem: null }), 'missing');
        await expectInvalid(await send({}, { idem: '' }), 'empty');
        await expectInvalid(await send({}, { idem: 'k'.repeat(129) }), '129');
        await afterwards();
        assert.equal((await send({}, { idem: 'k'.repeat(128) })).res.status, 200);
    });

    it('舊的 X-Idempotency-Key 標頭不算（必須用 Idempotency-Key）', async () => {
        await expectInvalid(await send({}, { idem: null, headers: { 'X-Idempotency-Key': 'abc' } }), 'x-header');
        await afterwards();
    });

    it('不是 JSON、不是物件、空本文 → 400', async () => {
        for (const raw of ['not json', '[]', 'null', '"s"', '5', '', '{"a":']) {
            await expectInvalid(await send({}, { raw }), JSON.stringify(raw));
        }
        await afterwards();
    });

    it('本文過大 → 413 INVALID_REQUEST', async () => {
        const r = await send({}, { raw: JSON.stringify(notification({ body: 'x'.repeat(25_000) })) });
        assert.equal(r.res.status, 413);
        assert.equal(errCode(r), 'INVALID_REQUEST');
        await afterwards();
    });

    it('欄位違規 → 400（additionalProperties、格式、長度、控制字元）', async () => {
        const cases = {
            extra: { extra: 1 },
            'message object': { messages: [{ type: 'text', text: 'x' }] },
            to: { to: LINE_USER },
            'ref 太短': { external_contact_ref: 'short' },
            'ref 非法字元': { external_contact_ref: 'bad ref bad ref' },
            'event_type 大寫': { event_type: 'Order' },
            'title 空': { title: '' },
            'title 41': { title: 'a'.repeat(41) },
            'body 301': { body: 'a'.repeat(301) },
            'title 控制字元': { title: 'a\nb' },
            'body 控制字元': { body: 'a\u0000b' },
            'label 21': { action: { label: 'a'.repeat(21), url: URL_OK } },
            'action 多餘欄位': { action: { label: 'a', url: URL_OK, extra: 1 } },
        };
        for (const [name, over] of Object.entries(cases)) await expectInvalid(await send(over), name);
        await afterwards();
    });

    it('title／body／label 含 http:// 或 https://（不分大小寫）→ 400 INVALID_REQUEST（不是 422）', async () => {
        for (const v of ['http://evil.example', 'HTTPS://EVIL.EXAMPLE', '看 https://picker.example.com/x', 'hTtP://x']) {
            await expectInvalid(await send({ title: v }), `title ${v}`);
            await expectInvalid(await send({ body: v }), `body ${v}`);
            await expectInvalid(await send({ action: { label: v.slice(0, 20), url: URL_OK } }), `label ${v}`);
        }
        await afterwards();
    });

    it('錯誤訊息不回顯使用者輸入（標題、內文、ref）', async () => {
        const r = await send({ title: 'SECRETTITLE https://x' });
        assert.ok(!r.text.includes('SECRETTITLE'));
        const r2 = await send({ external_contact_ref: 'SECRET REF!!' });
        assert.ok(!r2.text.includes('SECRET'));
    });
});

// ───────────────────────── action.url 白名單 ─────────────────────────

describe('action.url 白名單（端到端）', () => {
    const action = (url) => ({ label: '查看訂單', url });

    it('登記網域本身與子網域通過，LINE 收到的按鈕 uri 就是驗證過的網址', async () => {
        for (const url of ['https://picker.example.com/a?b=1', 'https://a.b.picker.example.com/', 'https://PICKER.example.com./x', 'https://picker.example.com:443/x']) {
            const r = await send({ action: action(url) });
            assert.equal(r.res.status, 200, url);
            const msg = line.pushCalls.at(-1).body.messages[0];
            assert.equal(msg.contents.footer.contents[0].action.uri, new URL(url).href);
            assert.ok(msg.contents.footer.contents[0].action.uri.startsWith('https://'));
        }
    });

    it('不在白名單 → 422 INVALID_URL_DOMAIN（retryable false），不打 LINE，不留冪等紀錄', async () => {
        for (const url of [
            'https://evil.example/', 'https://evil-picker.example.com/', 'https://picker.example.com.evil.example/', 'https://example.com/',
            'http://picker.example.com/', 'https://user:pw@picker.example.com/', 'https://picker.example.com:8443/', 'https://127.0.0.1/',
            'https://[::1]/', 'https://localhost/', 'https://picker.example.com/a b', 'javascript:alert(1)', '//picker.example.com/',
            `https://picker.example.com/${'a'.repeat(1000)}`,
        ]) {
            const r = await send({ action: action(url) });
            assert.equal(r.res.status, 422, url);
            assert.equal(errCode(r), 'INVALID_URL_DOMAIN', url);
            assert.equal(r.body.error.retryable, false);
        }
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(d1.db, 'idempotency'), 0);
    });

    it('產品沒有登記任何網域 → 任何 action 都是 422；沒有 action 的通知不受影響', async () => {
        await setDomains(PRD_A, []);
        const r = await send({ action: action(URL_OK) });
        assert.equal(r.res.status, 422);
        assert.equal(errCode(r), 'INVALID_URL_DOMAIN');
        assert.equal((await send()).res.status, 200);
    });

    it('網域以「這條連結的產品」登記值為準（別的產品登記的網域不通用）', async () => {
        await setDomains(PRD_A, ['picker.example.com']);
        await setDomains(PRD_B, ['other.example.org']);
        assert.equal((await send({ action: action('https://other.example.org/') })).res.status, 422);
        assert.equal((await send({ action: action('https://picker.example.com/') })).res.status, 200);
    });

    it('白名單失敗寫一筆 message_blocked 稽核（error_code INVALID_URL_DOMAIN，沒有網址）', async () => {
        await send({ action: action('https://evil.example/secret-path') });
        const rows = await auditRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].action, 'message_blocked');
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: PRD_A, link_id: LNK_A, error_code: 'INVALID_URL_DOMAIN', status: 422 });
        assert.ok(!JSON.stringify(rows).includes('evil.example'));
    });
});

// ───────────────────────── 成功路徑與 Flex 內容 ─────────────────────────

describe('成功路徑', () => {
    it('200 {message_id, status:"sent", sent_at}；message_id 是 msg_ + 16 hex；sent_at 是 ISO', async () => {
        const before = Date.now();
        const r = await send();
        assert.equal(r.res.status, 200);
        assert.deepEqual(Object.keys(r.body).sort(), ['message_id', 'sent_at', 'status']);
        assert.match(r.body.message_id, /^msg_[0-9a-f]{16}$/);
        assert.equal(r.body.status, 'sent');
        const t = Date.parse(r.body.sent_at);
        assert.equal(new Date(t).toISOString(), r.body.sent_at);
        assert.ok(t >= before && t <= Date.now());
        assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
        assert.equal(r.res.headers.get('X-Idempotency-Replayed'), null);
    });

    it('每次送出的 message_id 不同', async () => {
        const a = await send();
        const b = await send();
        assert.notEqual(a.body.message_id, b.body.message_id);
    });

    it('LINE 收到：to = 綁定的 userId、恰好一則 Flex（與 buildFlexMessage 相同）、用該 bot 的 token、帶 retry key', async () => {
        const idem = nextIdem();
        const action = { label: '查看訂單', url: URL_OK };
        await send({ action }, { idem });
        assert.equal(line.pushCalls.length, 1);
        const call1 = line.pushCalls[0];
        assert.deepEqual(Object.keys(call1.body).sort(), ['messages', 'to']);
        assert.equal(call1.body.to, LINE_USER);
        assert.equal(call1.body.messages.length, 1);
        assert.deepEqual(call1.body.messages[0], buildFlexMessage({ title: TITLE, body: BODY, action: { label: '查看訂單', url: new URL(URL_OK).href } }));
        assert.equal(call1.headers.Authorization, `Bearer ${LINE_TOKEN}`);
        assert.equal(call1.headers['X-Line-Retry-Key'], await retryKeyFor(BOT, `link:${LNK_A}`, idem));
        assert.match(call1.headers['X-Line-Retry-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('沒有 action 時沒有 footer；altText 等於標題；event_type 不會出現在送給客戶的訊息裡', async () => {
        await send({ event_type: 'internal.marker_evt' });
        const msg = line.pushCalls[0].body.messages[0];
        assert.equal(msg.altText, TITLE);
        assert.equal(msg.contents.footer, undefined);
        assert.ok(!JSON.stringify(line.pushCalls[0].body).includes('marker_evt'));
    });

    it('不做變數替換：(@name) 與看似標記的文字原樣送出', async () => {
        await send({ body: 'Hi (@name) <b>x</b> {"type":"text"}' });
        assert.equal(line.pushCalls[0].body.messages[0].contents.body.contents[1].text, 'Hi (@name) <b>x</b> {"type":"text"}');
    });

    it('成功後記用量（快取的 pushed 與剩餘各 +1／-1）', async () => {
        await send();
        const cache = JSON.parse(await kv.get(BotKeys.quota(BOT, currentPeriod())));
        assert.equal(cache.pushed, 1);
        assert.equal(cache.lineRemaining, 200 - 10 - 1);
    });

    it('寫一筆 message_sent 稽核：白名單欄位、message_id 與回應一致', async () => {
        const r = await send();
        const rows = await auditRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].action, 'message_sent');
        assert.equal(rows[0].result, 'ok');
        assert.equal(rows[0].actor_type, 'service_key');
        assert.equal(rows[0].actor_id, LNK_A);
        assert.equal(rows[0].bot_id, BOT);
        assert.deepEqual(JSON.parse(rows[0].detail), { cost: 1, status: 200, product_id: PRD_A, link_id: LNK_A, message_id: r.body.message_id });
    });
});

// ───────────────────────── 聯絡人解析 ─────────────────────────

describe('聯絡人解析', () => {
    it('未綁定的 ref → 409 CONTACT_NOT_BOUND（retryable false），不打 LINE', async () => {
        const r = await send({ external_contact_ref: REF2 });
        assert.equal(r.res.status, 409);
        assert.equal(errCode(r), 'CONTACT_NOT_BOUND');
        assert.equal(r.body.error.retryable, false);
        assert.equal(line.pushCalls.length, 0);
    });

    it('status = blocked → 409 RECIPIENT_BLOCKED，不打 LINE', async () => {
        await bindContact(LNK_A, REF2, LINE_USER_C, { status: 'blocked' });
        const r = await send({ external_contact_ref: REF2 });
        assert.equal(r.res.status, 409);
        assert.equal(errCode(r), 'RECIPIENT_BLOCKED');
        assert.equal(r.body.error.retryable, false);
        assert.equal(line.pushCalls.length, 0);
    });

    it('別條連結的 ref 解析不到，回應與「從沒綁定過」完全相同（不洩漏他人是否存在）', async () => {
        await bindContact(LNK_B, REF2, LINE_USER_C, { botId: BOT2 });
        const other = await send({ external_contact_ref: REF2 });
        const nobody = await send({ external_contact_ref: 'customer-9999' });
        assert.equal(other.res.status, 409);
        assert.equal(errCode(other), 'CONTACT_NOT_BOUND');
        assert.deepEqual(other.body, nobody.body);
        assert.equal(line.pushCalls.length, 0);
    });

    it('同一個 bot 的另一條連結綁定的 ref 也看不到；兩條連結各自只能發給自己的聯絡人', async () => {
        await seedLink(d1.db, { linkId: LNK_C, productId: PRD_C, botId: BOT, key: KEY_C });
        await bindContact(LNK_C, REF, LINE_USER_C); // 同一個 ref 字串，不同連結、不同客戶
        await bindContact(LNK_C, REF2, LINE_USER_C);
        assert.equal(errCode(await send({ external_contact_ref: REF2 })), 'CONTACT_NOT_BOUND'); // A 連結沒有 REF2
        assert.equal((await send({ external_contact_ref: REF })).res.status, 200);
        assert.equal(line.pushCalls.at(-1).body.to, LINE_USER);
        assert.equal((await send({ external_contact_ref: REF }, { key: KEY_C })).res.status, 200);
        assert.equal(line.pushCalls.at(-1).body.to, LINE_USER_C);
    });

    it('綁定列的 bot_id 與連結的 bot 不同 → 視為未綁定', async () => {
        await bindContact(LNK_A, REF2, LINE_USER_C, { botId: BOT2 });
        const r = await send({ external_contact_ref: REF2 });
        assert.equal(errCode(r), 'CONTACT_NOT_BOUND');
        assert.equal(line.pushCalls.length, 0);
    });

    it('連結撤銷後，即使綁定還在也發不出去（LINK_REVOKED）', async () => {
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK_A).run();
        const r = await send();
        assert.equal(errCode(r), 'LINK_REVOKED');
        assert.equal(line.pushCalls.length, 0);
    });

    it('NOT_BOUND／BLOCKED 各寫一筆 message_blocked 稽核，沒有 ref 與 userId', async () => {
        await bindContact(LNK_A, REF2, LINE_USER_C, { status: 'blocked' });
        await send({ external_contact_ref: 'customer-9999' });
        await send({ external_contact_ref: REF2 });
        const rows = await auditRows();
        assert.deepEqual(rows.map((r) => [r.action, r.result, JSON.parse(r.detail).error_code]), [
            ['message_blocked', 'blocked', 'CONTACT_NOT_BOUND'],
            ['message_blocked', 'blocked', 'RECIPIENT_BLOCKED'],
        ]);
    });
});

// ───────────────────────── 冪等 ─────────────────────────

describe('冪等', () => {
    it('同鍵同內容重送 → 第一次的結果（同一個 message_id 與 sent_at）＋ X-Idempotency-Replayed: true，LINE 只被呼叫一次', async () => {
        const idem = nextIdem();
        const first = await send({}, { idem });
        const second = await send({}, { idem });
        const third = await send({}, { idem });
        assert.equal(second.res.status, 200);
        assert.deepEqual(second.body, first.body);
        assert.deepEqual(third.body, first.body);
        assert.equal(first.res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(second.res.headers.get('X-Idempotency-Replayed'), 'true');
        assert.equal(line.pushCalls.length, 1);
        assert.equal((await auditRows()).length, 1); // 重送不重複記稽核
    });

    it('冪等紀錄的 system 欄是 link:{link_id}，內容只有第一次的結果（沒有 ref、userId、標題、內文）', async () => {
        const r = await send();
        const rows = await idemRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].system, `link:${LNK_A}`);
        assert.equal(rows[0].status, 'done');
        assert.equal(rows[0].response_status, 200);
        assert.deepEqual(JSON.parse(rows[0].response_body), r.body);
        for (const v of [REF, LINE_USER, 'TITLEMARK', 'BODYMARK']) assert.ok(!JSON.stringify(rows).includes(v), v);
    });

    it('同鍵不同內容 → 422 IDEMPOTENCY_KEY_REUSE（任一欄位不同都算），沒再打 LINE', async () => {
        const idem = nextIdem();
        await bindContact(LNK_A, REF2, LINE_USER_C);
        await send({}, { idem });
        const variants = [
            { title: '別的標題' }, { body: '別的內文' }, { event_type: 'order.other' }, { external_contact_ref: REF2 },
            { action: { label: 'go', url: URL_OK } },
        ];
        for (const over of variants) {
            const r = await send(over, { idem });
            assert.equal(r.res.status, 422, JSON.stringify(over));
            assert.equal(errCode(r), 'IDEMPOTENCY_KEY_REUSE');
            assert.equal(r.body.error.retryable, false);
        }
        assert.equal(line.pushCalls.length, 1);
    });

    it('同鍵、action 內容相同（含按鈕）重送也會回放', async () => {
        const idem = nextIdem();
        const action = { label: '查看', url: URL_OK };
        const a = await send({ action }, { idem });
        const b = await send({ action }, { idem });
        assert.deepEqual(b.body, a.body);
        assert.equal(b.res.headers.get('X-Idempotency-Replayed'), 'true');
        assert.equal(line.pushCalls.length, 1);
    });

    it('不同連結（即使同 bot）的同一把鍵互不影響', async () => {
        await seedLink(d1.db, { linkId: LNK_C, productId: PRD_C, botId: BOT, key: KEY_C });
        await bindContact(LNK_C, REF, LINE_USER_C);
        const idem = nextIdem();
        const a = await send({}, { idem });
        const c = await send({}, { idem, key: KEY_C });
        assert.equal(a.res.status, 200);
        assert.equal(c.res.status, 200);
        assert.equal(c.res.headers.get('X-Idempotency-Replayed'), null);
        assert.notEqual(a.body.message_id, c.body.message_id);
        assert.equal(line.pushCalls.length, 2);
        assert.deepEqual((await idemRows()).map((r) => r.system).sort(), [`link:${LNK_A}`, `link:${LNK_C}`]);
    });

    it('與 /raw 的冪等紀錄互不影響（system 欄不同）', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker', scopes: ['raw:push'] });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: SYS_KEY, scopes: ['raw:push'] });
        await kv.put(BotKeys.member(BOT, LINE_USER), JSON.stringify({ userId: LINE_USER }));
        const idem = 'shared-key-1';
        const rawRes = await call('POST', '/bridge/v1/raw/push', {
            key: SYS_KEY, headers: { 'X-Bot-Id': BOT, 'X-Idempotency-Key': idem }, body: { to: LINE_USER, messages: [{ type: 'text', text: 'raw' }] },
        });
        assert.equal(rawRes.res.status, 200);
        const r = await send({}, { idem });
        assert.equal(r.res.status, 200);
        assert.equal(r.res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(line.pushCalls.length, 2);
        assert.notEqual(line.pushCalls[0].headers['X-Line-Retry-Key'], line.pushCalls[1].headers['X-Line-Retry-Key']);
    });

    it('並行 8 個同鍵請求 → 只有一個送出（LINE 只被呼叫一次），其餘是 409 IN_PROGRESS', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let reachedLine;
        const winnerAtLine = new Promise((resolve) => { reachedLine = resolve; });
        line.push = () => { reachedLine(); return gate.then(() => new Response('{}', { status: 200 })); };
        const idem = nextIdem();
        let settled = 0;
        let sevenSettled;
        const sevenDone = new Promise((resolve) => { sevenSettled = resolve; });
        const all8 = Array.from({ length: 8 }, () => send({}, { idem }).then((r) => { if (++settled === 7) sevenSettled(); return r; }));
        // 贏家卡在 LINE 這一步時，其餘 7 個都會因為 IN_PROGRESS 回來（事件驅動，不靠輪詢或計時）
        await Promise.all([winnerAtLine, sevenDone]);
        assert.equal(line.pushCalls.length, 1);
        release();
        const results = await Promise.all(all8);
        assert.equal(results.filter((r) => r.res.status === 200).length, 1);
        const losers = results.filter((r) => r.res.status !== 200);
        assert.equal(losers.length, 7);
        for (const l of losers) {
            assert.equal(l.res.status, 409);
            assert.equal(errCode(l), 'IN_PROGRESS');
            assert.equal(l.body.error.retryable, true);
        }
        assert.equal(line.pushCalls.length, 1);
        // 之後再重送 → 回放第一次的結果
        const winner = results.find((r) => r.res.status === 200);
        const again = await send({}, { idem });
        assert.deepEqual(again.body, winner.body);
        assert.equal(again.res.headers.get('X-Idempotency-Replayed'), 'true');
    });

    it('並行 8 個同鍵請求（不卡住 LINE）→ LINE 仍只被呼叫一次，結果不是 200 就是 IN_PROGRESS／回放', async () => {
        const idem = nextIdem();
        const results = await Promise.all(Array.from({ length: 8 }, () => send({}, { idem })));
        assert.equal(line.pushCalls.length, 1);
        for (const r of results) assert.ok(r.res.status === 200 || errCode(r) === 'IN_PROGRESS', String(r.res.status));
        assert.ok(results.some((r) => r.res.status === 200 && r.res.headers.get('X-Idempotency-Replayed') === null));
    });

    it('失敗不快取：LINE 5xx → 502 INTERNAL（retryable），同一把鍵重試成功，兩次用的 retry key 相同', async () => {
        const idem = nextIdem();
        line.push = (n) => (n === 1 ? new Response('{"message":"x"}', { status: 500 }) : new Response('{}', { status: 200 }));
        const first = await send({}, { idem });
        assert.equal(first.res.status, 502);
        assert.equal(errCode(first), 'INTERNAL');
        assert.equal(first.body.error.retryable, true);
        assert.equal(await count(d1.db, 'idempotency'), 0);
        const second = await send({}, { idem });
        assert.equal(second.res.status, 200);
        assert.equal(second.res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(line.pushCalls.length, 2);
        assert.equal(line.pushCalls[0].headers['X-Line-Retry-Key'], line.pushCalls[1].headers['X-Line-Retry-Key']);
    });

    it('CONTACT_NOT_BOUND 不快取：之後完成綁定，同一把鍵重試就能送出', async () => {
        const idem = nextIdem();
        const first = await send({ external_contact_ref: REF2 }, { idem });
        assert.equal(errCode(first), 'CONTACT_NOT_BOUND');
        assert.equal(await count(d1.db, 'idempotency'), 0);
        await bindContact(LNK_A, REF2, LINE_USER_C);
        const second = await send({ external_contact_ref: REF2 }, { idem });
        assert.equal(second.res.status, 200);
        assert.equal(second.res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(line.pushCalls.length, 1);
    });

    it('RECIPIENT_BLOCKED 不快取：解除封鎖後，同一把鍵重試就能送出', async () => {
        await bindContact(LNK_A, REF2, LINE_USER_C, { status: 'blocked' });
        const idem = nextIdem();
        const first = await send({ external_contact_ref: REF2 }, { idem });
        assert.equal(errCode(first), 'RECIPIENT_BLOCKED');
        assert.equal(await count(d1.db, 'idempotency'), 0);
        await d1.db.prepare("UPDATE contacts SET status = 'bound' WHERE link_id = ?1 AND external_contact_ref = ?2").bind(LNK_A, REF2).run();
        const second = await send({ external_contact_ref: REF2 }, { idem });
        assert.equal(second.res.status, 200);
        assert.equal(line.pushCalls.length, 1);
    });

    it('額度用盡不快取：額度恢復後同一把鍵可重試', async () => {
        line.usage = 200;
        const idem = nextIdem();
        assert.equal(errCode(await send({}, { idem })), 'QUOTA_EXCEEDED');
        assert.equal(await count(d1.db, 'idempotency'), 0);
        line.usage = 10;
        await kv.delete(BotKeys.quota(BOT, currentPeriod()));
        assert.equal((await send({}, { idem })).res.status, 200);
    });

    it('LINE 限流（429）不快取：同一把鍵可重試', async () => {
        const idem = nextIdem();
        failOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }));
        assert.equal(errCode(await send({}, { idem })), 'RATE_LIMITED');
        assert.equal(await count(d1.db, 'idempotency'), 0);
        assert.equal((await send({}, { idem })).res.status, 200);
    });

    it('網路錯誤不快取：同一把鍵可重試', async () => {
        const idem = nextIdem();
        failOnce(() => { throw new Error('network down'); });
        assert.equal((await send({}, { idem })).res.status, 502);
        assert.equal(await count(d1.db, 'idempotency'), 0);
        assert.equal((await send({}, { idem })).res.status, 200);
    });

    it('token 缺失不快取：補上後同一把鍵可重試', async () => {
        await kv.delete(BotKeys.owner(BOT));
        const idem = nextIdem();
        assert.equal((await send({}, { idem })).res.status, 503);
        assert.equal(await count(d1.db, 'idempotency'), 0);
        await kv.put(BotKeys.owner(BOT), OWNER);
        assert.equal((await send({}, { idem })).res.status, 200);
    });

    it('確定性失敗（LINE 400）會快取：重送回放同樣的錯誤，不再打 LINE', async () => {
        const idem = nextIdem();
        line.push = () => new Response(JSON.stringify({ message: 'The request body has 1 error(s)' }), { status: 400 });
        const first = await send({}, { idem });
        assert.equal(first.res.status, 400);
        assert.equal(errCode(first), 'INVALID_REQUEST');
        const second = await send({}, { idem });
        assert.equal(second.res.status, 400);
        assert.deepEqual(second.body, first.body);
        assert.equal(second.res.headers.get('X-Idempotency-Replayed'), 'true');
        assert.equal(line.pushCalls.length, 1);
    });

    it('過期的「處理中」紀錄可被接手（Worker 被回收時不會把鍵永遠鎖死）', async () => {
        const idem = nextIdem();
        const first = await send({}, { idem });
        await d1.db.prepare("UPDATE idempotency SET status = 'in_progress', response_status = NULL, response_body = NULL, expires_at = 1").run();
        const second = await send({}, { idem });
        assert.equal(second.res.status, 200);
        assert.notEqual(second.body.message_id, first.body.message_id);
    });
});

// ───────────────────────── LINE 錯誤對映 ─────────────────────────

describe('LINE 錯誤對映', () => {
    const lineReply = (status, body = {}, headers = {}) => () => new Response(JSON.stringify(body), { status, headers });

    it('409（retry key 已受理）→ 視為成功 200，不記用量', async () => {
        line.push = lineReply(409, {}, { 'X-Line-Accepted-Request-Id': 'req-1' });
        const r = await send();
        assert.equal(r.res.status, 200);
        assert.equal(r.body.status, 'sent');
        assert.match(r.body.message_id, /^msg_[0-9a-f]{16}$/);
        const cache = JSON.parse(await kv.get(BotKeys.quota(BOT, currentPeriod())));
        assert.ok(!cache.pushed, 'pushed 不增加');
        assert.equal((await idemRows())[0].status, 'done');
    });

    it('403（被封鎖）→ 409 RECIPIENT_BLOCKED；把該 LINE 使用者的所有聯絡人標成 blocked、會員標成 inactive；不快取', async () => {
        await bindContact(LNK_A, REF2, LINE_USER); // 同一個客戶綁了兩個 ref
        await seedLink(d1.db, { linkId: LNK_C, productId: PRD_C, botId: BOT, key: KEY_C });
        await bindContact(LNK_C, REF, LINE_USER); // 另一條連結也綁了同一個客戶
        await bindContact(LNK_A, 'customer-0099', LINE_USER_C); // 別的客戶不受影響
        await kv.put(BotKeys.member(BOT, LINE_USER), JSON.stringify({ userId: LINE_USER, name: 'Amy' }));
        line.push = lineReply(403, { message: 'Failed to send messages' });
        const idem = nextIdem();
        const r = await send({}, { idem });
        assert.equal(r.res.status, 409);
        assert.equal(errCode(r), 'RECIPIENT_BLOCKED');
        const rows = await all(d1.db, 'SELECT link_id, external_contact_ref AS ref, status FROM contacts ORDER BY link_id, ref');
        assert.deepEqual(rows.map((x) => [x.link_id, x.ref, x.status]), [
            [LNK_A, 'customer-0001', 'blocked'], [LNK_A, 'customer-0002', 'blocked'], [LNK_A, 'customer-0099', 'bound'], [LNK_C, 'customer-0001', 'blocked'],
        ]);
        const member = JSON.parse(await kv.get(BotKeys.member(BOT, LINE_USER)));
        assert.equal(typeof member.inactiveAt, 'number');
        assert.equal(await count(d1.db, 'idempotency'), 0);
        // 之後同一把鍵再送：直接 RECIPIENT_BLOCKED，不再打 LINE
        const again = await send({}, { idem });
        assert.equal(errCode(again), 'RECIPIENT_BLOCKED');
        assert.equal(line.pushCalls.length, 1);
        assert.equal((await auditRows()).at(-1).action, 'message_blocked');
    });

    it('429 月額度 → 402 QUOTA_EXCEEDED，並把快取標成用盡（下一則不打 LINE）', async () => {
        line.push = lineReply(429, { message: 'You have reached your monthly limit.' });
        const r = await send();
        assert.equal(r.res.status, 402);
        assert.equal(errCode(r), 'QUOTA_EXCEEDED');
        assert.equal(r.body.error.retryable, false);
        const cache = JSON.parse(await kv.get(BotKeys.quota(BOT, currentPeriod())));
        assert.equal(cache.lineRemaining, 0);
        const next = await send();
        assert.equal(errCode(next), 'QUOTA_EXCEEDED');
        assert.equal(line.pushCalls.length, 1);
    });

    it('429 其他 → 429 RATE_LIMITED（retryable），帶 LINE 的 Retry-After；沒有時預設 1', async () => {
        line.push = lineReply(429, { message: 'rate' }, { 'Retry-After': '7' });
        const r = await send();
        assert.equal(r.res.status, 429);
        assert.equal(errCode(r), 'RATE_LIMITED');
        assert.equal(r.body.error.retryable, true);
        assert.equal(r.res.headers.get('Retry-After'), '7');
        line.push = lineReply(429, { message: 'rate' });
        const r2 = await send();
        assert.equal(r2.res.status, 429);
        assert.equal(r2.res.headers.get('Retry-After'), '1');
    });

    it('400 → 400 INVALID_REQUEST，不轉述 LINE 的訊息', async () => {
        line.push = lineReply(400, { message: 'LINE_DETAIL_SHOULD_NOT_LEAK', details: [{ message: 'x', property: '/messages/0' }] });
        const r = await send();
        assert.equal(r.res.status, 400);
        assert.equal(errCode(r), 'INVALID_REQUEST');
        assert.ok(!r.text.includes('LINE_DETAIL_SHOULD_NOT_LEAK'));
    });

    it('401 → 503 INTERNAL bot_not_configured', async () => {
        line.push = lineReply(401, { message: 'Authentication failed' });
        const r = await send();
        assert.equal(r.res.status, 503);
        assert.equal(errCode(r), 'INTERNAL');
        assert.equal(r.body.error.message, 'bot_not_configured');
        assert.ok(!r.text.includes(LINE_TOKEN));
    });

    it('5xx → 502 INTERNAL retryable true；其他未預期的 4xx → 502 INTERNAL retryable false', async () => {
        for (const s of [500, 502, 503]) {
            line.push = lineReply(s, { message: 'x' });
            const r = await send();
            assert.equal(r.res.status, 502, String(s));
            assert.equal(errCode(r), 'INTERNAL');
            assert.equal(r.body.error.retryable, true);
        }
        line.push = lineReply(404, { message: 'x' });
        const r = await send();
        assert.equal(r.res.status, 502);
        assert.equal(r.body.error.retryable, false);
    });

    it('網路層失敗（fetch 丟錯）→ 502 INTERNAL retryable true，不洩漏錯誤內容', async () => {
        line.push = () => { throw new Error('socket hang up SECRET_NET_DETAIL'); };
        const r = await send();
        assert.equal(r.res.status, 502);
        assert.equal(errCode(r), 'INTERNAL');
        assert.equal(r.body.error.retryable, true);
        assert.ok(!r.text.includes('SECRET_NET_DETAIL'));
    });

    it('bot 沒有 token → 503 INTERNAL bot_not_configured，沒打 LINE', async () => {
        await kv.delete(BotKeys.owner(BOT));
        const r = await send();
        assert.equal(r.res.status, 503);
        assert.equal(r.body.error.message, 'bot_not_configured');
        assert.equal(line.pushCalls.length, 0);
    });

    it('失敗結果寫 message_failed 稽核（error_code、status），沒有 LINE 的訊息內容', async () => {
        line.push = lineReply(500, { message: 'UPSTREAM_DETAIL' });
        await send();
        line.push = lineReply(400, { message: 'UPSTREAM_DETAIL' });
        await send();
        const rows = await auditRows();
        assert.deepEqual(rows.map((r) => [r.action, r.result, JSON.parse(r.detail).error_code, JSON.parse(r.detail).status]), [
            ['message_failed', 'failed', 'INTERNAL', 502], ['message_failed', 'failed', 'INVALID_REQUEST', 400],
        ]);
        assert.ok(!JSON.stringify(rows).includes('UPSTREAM_DETAIL'));
    });
});

// ───────────────────────── 額度 ─────────────────────────

describe('額度', () => {
    it('額度用盡 → 402 QUOTA_EXCEEDED，不打 LINE 的 push、不留冪等紀錄', async () => {
        line.usage = 200;
        const r = await send();
        assert.equal(r.res.status, 402);
        assert.equal(errCode(r), 'QUOTA_EXCEEDED');
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(d1.db, 'idempotency'), 0);
        const rows = await auditRows();
        assert.deepEqual(rows.map((x) => [x.action, JSON.parse(x.detail).error_code, JSON.parse(x.detail).status]), [['message_failed', 'QUOTA_EXCEEDED', 402]]);
    });

    it('剩最後一則還能送；送完下一則被擋', async () => {
        line.usage = 199;
        assert.equal((await send()).res.status, 200);
        const r = await send();
        assert.equal(errCode(r), 'QUOTA_EXCEEDED');
        assert.equal(line.pushCalls.length, 1);
    });

    it('無上限的 OA（type: none）照常送', async () => {
        globalThis.fetch = (inner => async (url, init) => (String(url).endsWith('/v2/bot/message/quota') ? new Response(JSON.stringify({ type: 'none' }), { status: 200 }) : inner(url, init)))(globalThis.fetch);
        assert.equal((await send()).res.status, 200);
    });
});

// ───────────────────────── 限流 ─────────────────────────

describe('限流', () => {
    it('每連結每分鐘 60 則：第 61 個請求 → 429 RATE_LIMITED + Retry-After；別條連結不受影響', async () => {
        await withPinnedWindow(async () => {
            // M-01 改寫（KV 限流器 → D1 原子計數）：限流現在在「驗證之後」才扣，所以改用便宜的有效請求
            // （每次一個沒綁定的 ref → 409 CONTACT_NOT_BOUND，不打 LINE）把每連結的分鐘額度吃完
            for (let i = 1; i <= 60; i++) {
                const r = await send({ external_contact_ref: `customer-u${String(i).padStart(4, '0')}` });
                assert.equal(r.res.status, 409, `第 ${i} 個`);
            }
            const r = await send();
            assert.equal(r.res.status, 429);
            assert.equal(errCode(r), 'RATE_LIMITED');
            assert.equal(r.body.error.retryable, true);
            const retry = Number(r.res.headers.get('Retry-After'));
            assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${retry}`);
            assert.equal(line.pushCalls.length, 0);
            assert.equal(await count(d1.db, 'idempotency'), 0);
            // 別條連結有自己的桶
            await bindContact(LNK_B, REF, LINE_USER_C, { botId: BOT2 });
            const other = await send({}, { key: KEY_B });
            assert.notEqual(other.res.status, 429);
        });
    });

    it('每聯絡人每小時 10 則（以連結 + ref 計）：第 11 則 → 429；別的 ref、別條連結不受影響', async () => {
        await withPinnedWindow(async () => {
            await bindContact(LNK_A, REF2, LINE_USER_C);
            await bindContact(LNK_B, REF, LINE_USER_C, { botId: BOT2 });
            await kv.put(BotKeys.owner(BOT2), 'Uowner0000000000000000000000002');
            await kv.put('access_tokens_Uowner0000000000000000000000002', JSON.stringify({ main: { token: 'TOKEN_BOT2', destination: BOT2 } }));
            for (let i = 1; i <= 10; i++) {
                const r = await send();
                assert.equal(r.res.status, 200, `第 ${i} 則`);
            }
            const r = await send();
            assert.equal(r.res.status, 429);
            assert.equal(errCode(r), 'RATE_LIMITED');
            const retry = Number(r.res.headers.get('Retry-After'));
            assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 3600, `Retry-After=${retry}`);
            assert.equal(line.pushCalls.length, 10);
            assert.equal(await count(d1.db, 'idempotency'), 10); // 被限流的請求沒有搶佔冪等鍵
            assert.equal((await send({ external_contact_ref: REF2 })).res.status, 200);
            assert.equal((await send({}, { key: KEY_B })).res.status, 200); // 別條連結同一個 ref 字串
        });
    });

    it('限流計數鍵不含 ref 明文（改寫：原本檢查 KV key，現在檢查 D1 counters 的 scope_key）；Bridge 不再為發送寫 KV 限流鍵', async () => {
        await send();
        const keys = (await all(d1.db, 'SELECT scope_key FROM counters')).map((r) => r.scope_key);
        assert.ok(keys.some((k) => k.startsWith('send:hour:')));
        assert.ok(keys.every((k) => !k.includes(REF)), keys.join(','));
        assert.ok([...kv._store.keys()].every((k) => !k.startsWith('rl_notify')));
    });

    it('缺 KV 不再影響限流（限流已搬到 D1）：沒有 token 所以回 503，不是 429', async () => {
        const r = await send({}, { e: { ...env, KV_LINE_STORAGE: undefined } });
        assert.equal(r.res.status, 503);
        assert.equal(await count(d1.db, 'counters', "scope_key LIKE 'send:min:%'"), 1);
    });
});

// ───────────────────────── sanitizeDetail ─────────────────────────

describe('audit 白名單：message_id 嚴格格式', () => {
    it('只收 msg_ + 16 個小寫 hex；其他格式的字串被丟掉', async () => {
        const good = 'msg_0123456789abcdef';
        const badIds = ['msg_0123456789ABCDEF', 'msg_0123456789abcde', 'msg_0123456789abcdef0', 'msg_0123456789abcdeg', 'xmsg_0123456789abcdef', 'msg_0123456789abcdef\n', REF, LINE_USER, 'https://x.example', 5, null, {}];
        await writeAudit(env, { actorType: 'service_key', action: 'message_sent', result: 'ok', detail: { message_id: good, link_id: LNK_A } });
        for (const id of badIds) {
            await writeAudit(env, { actorType: 'service_key', action: 'message_sent', result: 'ok', detail: { message_id: id, link_id: LNK_A } });
        }
        const rows = await auditRows();
        assert.deepEqual(JSON.parse(rows[0].detail), { link_id: LNK_A, message_id: good });
        for (const r of rows.slice(1)) assert.deepEqual(JSON.parse(r.detail), { link_id: LNK_A });
    });

    it('title、body、url、ref、userId 之類的欄位仍然進不了 audit', async () => {
        await writeAudit(env, {
            actorType: 'service_key', action: 'message_sent', result: 'ok',
            detail: { title: 'T', body: 'B', url: 'https://x.example', ref: REF, external_contact_ref: REF, line_user_id: LINE_USER, userId: LINE_USER, message_id: 'msg_0123456789abcdef' },
        });
        const rows = await auditRows();
        assert.deepEqual(JSON.parse(rows[0].detail), { message_id: 'msg_0123456789abcdef' });
    });
});

// ───────────────────────── 洩漏掃描 ─────────────────────────

describe('洩漏掃描：回應、audit、冪等紀錄、KV key、console 都不含 ref、userId、標題、內文、網址', () => {
    it('走完成功、重送、各種失敗之後掃描', async () => {
        const action = { label: '查看訂單LABELMARK', url: URL_OK };
        await bindContact(LNK_A, REF2, LINE_USER_C, { status: 'blocked' });
        const idem = nextIdem();
        await send({ action }, { idem }); // 成功
        await send({ action }, { idem }); // 回放
        await send({ action }, { idem }); // 回放
        await send({ title: `${TITLE}2`, action }, { idem }); // 422 reuse
        await send({ external_contact_ref: 'customer-9999', action }); // NOT_BOUND
        await send({ external_contact_ref: REF2, action }); // BLOCKED
        await send({ action: { label: 'x', url: 'https://evil.example/URLMARK' } }); // 網域
        await send({ title: 'bad\nTITLEMARK' }); // 400
        line.push = () => new Response('{"message":"boom"}', { status: 500 });
        await send({ action }); // 5xx
        line.push = () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 });
        await send({ action }); // 額度
        line.push = () => new Response('{"message":"x"}', { status: 403 });
        await send({ action }); // LINE 封鎖
        line.push = () => { throw new Error('network'); };
        await send({ action: undefined });

        const secrets = [REF, REF2, 'customer-9999', LINE_USER, LINE_USER_C, 'TITLEMARK', 'BODYMARK', 'LABELMARK', 'tokenmark', 'URLMARK', 'picker.example.com', 'evil.example', LINE_TOKEN];
        const surfaces = {
            responses: seen.join('\n'),
            audit: JSON.stringify(await auditRows()),
            idempotency: JSON.stringify(await idemRows()),
            kvKeys: [...kv._store.keys()].join('\n'),
            logs: logs.join('\n'),
        };
        for (const [name, text] of Object.entries(surfaces)) {
            for (const s of secrets) {
                // 回應裡 sent 的 Flex 不會出現（回應只有 message_id），所以一律不得出現
                assert.ok(!text.includes(s), `${name} 含 ${s}`);
            }
        }
        assert.ok((await auditRows()).length >= 6);
    });

    it('所有錯誤回應都是 bridgeError 格式，沒有 stack', async () => {
        const rs = [
            await send({ title: '' }), await send({ external_contact_ref: 'customer-9999' }), await send({ action: { label: 'x', url: 'https://evil.example/' } }),
            await send({}, { idem: null }), await send({}, { key: 'nope' }),
        ];
        for (const r of rs) {
            assert.ok(r.res.status >= 400);
            bridgeErrorShape(r);
            assert.ok(!/stack|\n\s+at /.test(r.text));
        }
    });
});
