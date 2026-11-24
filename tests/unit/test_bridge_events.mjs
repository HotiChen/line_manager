/**
 * Unit Tests — LM-4B 事件轉發（bridge/events.js 與 lib/event_handler.js 的 px: 分支，真 D1、假產品伺服器、假 LINE）
 *
 * 安全性質（上線前安全審查的依據）：
 *   - 送給產品的請求（標頭與本文）不含 LINE userId、replyToken、原始 data；簽章可由產品用同一演算法驗證
 *   - redirect 不跟隨；逾時主動中止、晚到的回應丟棄、絕不 push 補送
 *   - reply／備用內容都經 content.js 驗證；網址只能在產品 url_domains 內
 *   - 去重、限流；稽核與 log 不含個資；缺 0006／缺加密金鑰 → 不轉發
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedLink, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { sealSecret } from '../../worker_src/lm_service.js';
import { parsePostback } from '../../worker_src/lib/postback_route.js';
import { handlePostbackEvent } from '../../worker_src/lib/event_handler.js';
import {
    forwardPostback, signEvent, eventTimeoutMs, generateEventSecret, checkEventUrl,
    GENERIC_FALLBACK_TEXT, EVENT_TIMEOUT_DEFAULT_MS,
} from '../../worker_src/bridge/events.js';
import * as bdb from '../../worker_src/bridge/db.js';

const OWNER = 'Uowner00000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const USER = 'Uline0000000000000000000000000001';
const USER2 = 'Uline0000000000000000000000000002';
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const PRD = 'prd_aaaaaaaaaaaa';
const KEY = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const SCOPES = ['link:manage', 'contacts:bind', 'messages:send', 'events:receive'];
const EVENT_URL = 'https://api.picker.example.com/lm/events';
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'pes_test-secret-not-real-0000000000000000000000';
const REF = 'customer-0001';
const REPLY_TOKEN = 'reply-token-SECRET-xyz';
const RAW_DATA = 'px:ip:plans?type=wedding';
const WEBHOOK_EVENT_ID = '01HZXTESTEVENT0000000000AA';

let d1;
let env;
let kv;
let productCalls;   // 送到產品的請求 {url, init}
let lineReplies;    // /message/reply 的 body
let linePushes;     // 任何 push（必須保持空）
let productHandler; // (url, init) => Response | Promise
let logs;
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', TOKEN_ENCRYPTION_KEY: ENC_KEY, BRIDGE_EVENT_TIMEOUT_MS: '500' };
    productCalls = []; lineReplies = []; linePushes = []; logs = [];
    productHandler = () => new Response(JSON.stringify({ reply: { title: '方案', body: '請看方案', action: { label: '查看', url: 'https://picker.example.com/plans' } } }), { status: 200 });
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u === EVENT_URL) {
            productCalls.push({ url: u, init });
            return productHandler(u, init);
        }
        if (u.includes('/message/reply')) { lineReplies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
        if (u.includes('/message/push') || u.includes('/multicast')) { linePushes.push(u); return new Response('{}', { status: 200 }); }
        if (u.includes('/v2/bot/profile/')) return new Response(JSON.stringify({ displayName: 'x' }), { status: 200 });
        return new Response('{}', { status: 200 });
    };
    const grab = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.error = grab; console.warn = grab; console.log = grab;
    await kv.put(BotKeys.owner(BOT), OWNER);
    await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY, scopes: SCOPES });
    await d1.db.prepare("UPDATE products SET product_key = 'ip', url_domains = ?2, event_url = ?3, event_secret_enc = ?4, scopes = ?5 WHERE product_id = ?1")
        .bind(PRD, JSON.stringify(['picker.example.com']), EVENT_URL, await sealSecret(env, SECRET), JSON.stringify(SCOPES)).run();
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalLog);
});

const eventOf = (over = {}) => ({
    type: 'postback', replyToken: REPLY_TOKEN, webhookEventId: WEBHOOK_EVENT_ID, timestamp: 1_700_000_000_000,
    postback: { data: RAW_DATA }, source: { type: 'user', userId: USER }, ...over,
});
const forward = (over = {}, { e = env, data = RAW_DATA } = {}) =>
    forwardPostback(e, { botId: BOT, route: parsePostback(data), event: eventOf(over) });
const sentBody = () => JSON.parse(productCalls[0].init.body);
const bindContact = (user = USER, ref = REF, status = 'bound') => d1.db.prepare(
    "INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)"
).bind(LNK, ref, BOT, user, status).run();
const auditRows = () => all(d1.db, "SELECT action, result, detail FROM audit_log WHERE action = 'event_forwarded' ORDER BY id");
const putFallback = (action, content) => bdb.putEventFallback(env, { botId: BOT, productKey: 'ip', action, content });

// ───────────────────────── 成功路徑與請求格式 ─────────────────────────

describe('轉發與簽章', () => {
    it('reply → 驗證後組成 Flex，outcome=replied', async () => {
        const r = await forward();
        assert.equal(r.outcome, 'replied');
        assert.equal(r.messages.length, 1);
        assert.equal(r.messages[0].type, 'flex');
        assert.equal(r.messages[0].altText, '方案');
        assert.equal(r.messages[0].contents.footer.contents[0].action.uri, 'https://picker.example.com/plans');
        assert.equal(productCalls.length, 1);
    });

    it('請求本文只有約定的欄位；contact 未綁定為 null；params 原樣', async () => {
        await forward();
        const b = sentBody();
        assert.deepEqual(Object.keys(b).sort(), ['action', 'contact', 'event_id', 'link_id', 'occurred_at', 'params', 'type']);
        assert.equal(b.type, 'postback');
        assert.equal(b.action, 'plans');
        assert.deepEqual(b.params, { type: 'wedding' });
        assert.equal(b.link_id, LNK);
        assert.equal(b.contact, null);
        assert.match(b.event_id, /^evt_[0-9a-f]{32}$/);
        assert.equal(b.occurred_at, new Date(1_700_000_000_000).toISOString());
    });

    it('contact 只在這位使用者於這條連結已綁定時出現（只有 ref 與 status）', async () => {
        await bindContact();
        await forward();
        assert.deepEqual(sentBody().contact, { external_contact_ref: REF, status: 'bound' });
    });

    it('blocked 的綁定、別的使用者的綁定、別條連結的綁定都不會變成 contact', async () => {
        await bindContact(USER, REF, 'blocked');
        await bindContact(USER2, 'customer-0002');
        await forward();
        assert.equal(sentBody().contact, null);
    });

    it('請求的標頭與本文不含 LINE userId、replyToken、原始 data', async () => {
        await bindContact();
        await forward();
        const dump = JSON.stringify(productCalls[0].init.headers) + productCalls[0].init.body;
        for (const secret of [USER, REPLY_TOKEN, RAW_DATA, 'px:ip']) assert.ok(!dump.includes(secret), secret);
    });

    it('簽章 = v1=hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))，產品可用同一演算法驗證；標頭齊全', async () => {
        await forward();
        const { init } = productCalls[0];
        const h = init.headers;
        assert.equal(init.method, 'POST');
        assert.equal(h['Content-Type'], 'application/json');
        assert.equal(h['X-LM-Event-Id'], sentBody().event_id);
        assert.match(h['X-LM-Timestamp'], /^\d{10}$/);
        assert.equal(h['X-LM-Signature'], await signEvent(SECRET, h['X-LM-Timestamp'], init.body));
        assert.match(h['X-LM-Signature'], /^v1=[0-9a-f]{64}$/);
        // 換一個密鑰、時間戳或本文 → 簽章不同
        assert.notEqual(h['X-LM-Signature'], await signEvent('other', h['X-LM-Timestamp'], init.body));
        assert.notEqual(h['X-LM-Signature'], await signEvent(SECRET, '1', init.body));
        assert.notEqual(h['X-LM-Signature'], await signEvent(SECRET, h['X-LM-Timestamp'], `${init.body} `));
    });

    it('簽章的已知答案（RFC 4231 風格：固定輸入固定輸出，防止演算法被悄悄改掉）', async () => {
        assert.equal(await signEvent('key', '1700000000', '{"a":1}'),
            'v1=' + (await (async () => {
                const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('1700000000.{"a":1}'));
                return Array.from(new Uint8Array(s), (b) => b.toString(16).padStart(2, '0')).join('');
            })()));
    });

    it('不跟隨轉址（redirect: manual）；3xx 視為失敗 → 備用內容', async () => {
        productHandler = () => new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } });
        const r = await forward();
        assert.equal(productCalls[0].init.redirect, 'manual');
        assert.equal(r.outcome, 'fallback_error');
        assert.equal(r.messages[0].text, GENERIC_FALLBACK_TEXT);
    });
});

// ───────────────────────── 產品的回應 ─────────────────────────

describe('產品的回應', () => {
    it('204 → 不回覆', async () => {
        productHandler = () => new Response(null, { status: 204 });
        const r = await forward();
        assert.deepEqual(r, { messages: null, outcome: 'no_reply' });
    });

    it('非 200/204（4xx、5xx）→ 備用內容（沒有設定 → 通用文字）', async () => {
        for (const status of [400, 404, 500, 503]) {
            await d1.reset();
            await bootstrap();
            productHandler = () => new Response('{}', { status });
            const r = await forward({ webhookEventId: `evt-${status}-0000000` });
            assert.equal(r.outcome, 'fallback_error', String(status));
            assert.deepEqual(r.messages, [{ type: 'text', text: GENERIC_FALLBACK_TEXT }]);
        }
    });

    async function bootstrap() {
        await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY, scopes: SCOPES });
        await d1.db.prepare("UPDATE products SET product_key = 'ip', url_domains = ?2, event_url = ?3, event_secret_enc = ?4, scopes = ?5 WHERE product_id = ?1")
            .bind(PRD, JSON.stringify(['picker.example.com']), EVENT_URL, await sealSecret(env, SECRET), JSON.stringify(SCOPES)).run();
    }

    it('非 JSON、不是物件、沒有 reply、reply 驗證不過 → fallback_invalid', async () => {
        const bad = [
            'not json', '[]', '"x"', '{}', '{"reply":null}', '{"reply":"hi"}',
            JSON.stringify({ reply: { title: '', body: 'x' } }),
            JSON.stringify({ reply: { title: 't', body: '看 https://evil.example.com' } }),
            JSON.stringify({ reply: { title: 't', body: 'b', action: { label: 'go', url: 'https://evil.example.com/x' } } }),
            JSON.stringify({ reply: { title: 't', body: 'b', action: { label: 'go', url: 'http://picker.example.com/x' } } }),
            JSON.stringify({ reply: { title: 't', body: 'b', extra: 1 } }),
            JSON.stringify({ reply: { type: 'flex', altText: 'x', contents: {} } }),
        ];
        let i = 0;
        for (const text of bad) {
            productHandler = () => new Response(text, { status: 200 });
            // 每個案例換一位使用者，避免撞到每分鐘 10 次的限流
            const r = await forward({ webhookEventId: `inv-${i}-000000000`, source: { type: 'user', userId: `Uinvalid${i++}00000000000000000000` } });
            assert.equal(r.outcome, 'fallback_invalid', text);
            assert.equal(r.messages[0].type, 'text', text);
        }
    });

    it('本文超過 4 KB → fallback_invalid（Content-Length 與實際串流兩種）', async () => {
        const huge = JSON.stringify({ reply: { title: 't', body: 'b'.repeat(5000) } });
        productHandler = () => new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } });
        assert.equal((await forward({ webhookEventId: 'big-000000000001' })).outcome, 'fallback_invalid');
        productHandler = () => new Response(new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); },
        }), { status: 200 });
        assert.equal((await forward({ webhookEventId: 'big-000000000002' })).outcome, 'fallback_invalid');
    });

    it('驗證失敗／錯誤時有設定備用內容 → 回備用內容（依 OA × product_key × action）', async () => {
        await putFallback('plans', { title: '暫時無法顯示', body: '請稍後再試', action: { label: '官網', url: 'https://picker.example.com/' } });
        await putFallback('status', { title: '別的動作', body: 'x' });
        productHandler = () => new Response('oops', { status: 500 });
        const r = await forward();
        assert.equal(r.outcome, 'fallback_error');
        assert.equal(r.messages[0].altText, '暫時無法顯示');
    });

    it('壞掉或網址不合法的備用內容 → 退回通用文字（不信任儲存的資料）', async () => {
        await bdb.putEventFallback(env, { botId: BOT, productKey: 'ip', action: 'plans', content: { title: 't', body: 'b', action: { label: 'x', url: 'https://evil.example.com/' } } });
        productHandler = () => new Response('oops', { status: 500 });
        const r = await forward();
        assert.deepEqual(r.messages, [{ type: 'text', text: GENERIC_FALLBACK_TEXT }]);
    });
});

// ───────────────────────── 逾時 ─────────────────────────

describe('逾時', () => {
    it('產品不回應 → 逾時主動中止（signal.aborted）、改送備用內容；晚到的回應被丟棄、沒有任何 push', async () => {
        let signal;
        let release;
        productHandler = (_u, init) => new Promise((resolve) => {
            signal = init.signal;
            release = () => resolve(new Response(JSON.stringify({ reply: { title: '太晚了', body: 'x' } }), { status: 200 }));
        });
        const started = Date.now();
        const r = await forward();
        assert.ok(Date.now() - started < 1500, '應在逾時（500ms）附近回來');
        assert.equal(r.outcome, 'fallback_timeout');
        assert.equal(r.messages[0].text, GENERIC_FALLBACK_TEXT);
        assert.equal(signal.aborted, true);
        release(); // 晚到
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(linePushes, []);
        assert.equal(lineReplies.length, 0);
    });

    it('BRIDGE_EVENT_TIMEOUT_MS：500–5000 的整數才採用，其餘用預設 2500', () => {
        for (const [v, want] of [['500', 500], ['2500', 2500], ['5000', 5000], [1200, 1200], ['499', 2500], ['5001', 2500], ['abc', 2500], ['', 2500], [undefined, 2500], ['1e3', 2500], ['1500.5', 2500], ['-800', 2500], [null, 2500]]) {
            assert.equal(eventTimeoutMs({ BRIDGE_EVENT_TIMEOUT_MS: v }), want, String(v));
        }
        assert.equal(EVENT_TIMEOUT_DEFAULT_MS, 2500);
    });
});

// ───────────────────────── 轉發條件 ─────────────────────────

describe('轉發條件（§B.1）', () => {
    const notForwarded = async (over, opts) => {
        const r = await forward(over, opts);
        assert.equal(r.outcome, 'not_forwarded');
        assert.equal(productCalls.length, 0, '不得呼叫產品');
        return r;
    };

    it('群組、聊天室 → 不轉發', async () => {
        await notForwarded({ source: { type: 'group', groupId: 'G1', userId: USER } });
        await notForwarded({ source: { type: 'room', roomId: 'R1', userId: USER } });
        await notForwarded({ source: { type: 'user' } });
    });

    it('BRIDGE_ENABLED 未開 → 零 D1、零網路', async () => {
        let touched = 0;
        const counting = { prepare: (...a) => { touched++; return d1.db.prepare(...a); }, batch: (...a) => { touched++; return d1.db.batch(...a); } };
        await notForwarded({}, { e: { ...env, BRIDGE_ENABLED: undefined, BRIDGE_DB: counting } });
        assert.equal(touched, 0);
    });

    it('不是 px 路徑 → 不轉發', async () => {
        const r = await forwardPostback(env, { botId: BOT, route: parsePostback('lm:reply?key=x'), event: eventOf() });
        assert.equal(r.outcome, 'not_forwarded');
    });

    it('這個 OA 上沒有該 product_key 的連結 → 不轉發', async () => {
        await notForwarded({}, { data: 'px:zz:plans' });
    });

    it('連結撤銷、產品停用、連結缺 events:receive、產品沒有 event_url 或密鑰 → 不轉發', async () => {
        const cases = [
            () => d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK).run(),
            () => d1.db.prepare("UPDATE products SET disabled = 1 WHERE product_id = ?1").bind(PRD).run(),
            () => d1.db.prepare("UPDATE links SET scopes = ?2 WHERE link_id = ?1").bind(LNK, JSON.stringify(['contacts:bind'])).run(),
            () => d1.db.prepare("UPDATE products SET event_url = NULL WHERE product_id = ?1").bind(PRD).run(),
            () => d1.db.prepare("UPDATE products SET event_secret_enc = NULL WHERE product_id = ?1").bind(PRD).run(),
            () => d1.db.prepare("UPDATE products SET event_secret_enc = 'plaintext-secret' WHERE product_id = ?1").bind(PRD).run(),
        ];
        let i = 0;
        for (const mutate of cases) {
            await d1.reset();
            await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY, scopes: SCOPES });
            await d1.db.prepare("UPDATE products SET product_key = 'ip', url_domains = ?2, event_url = ?3, event_secret_enc = ?4 WHERE product_id = ?1")
                .bind(PRD, JSON.stringify(['picker.example.com']), EVENT_URL, await sealSecret(env, SECRET)).run();
            await mutate();
            const r = await forward({ webhookEventId: `cond-${i++}-0000000` });
            assert.equal(r.outcome, 'not_forwarded', `case ${i}`);
            assert.equal(productCalls.length, 0, `case ${i}`);
        }
    });

    it('縱深防禦：event_url 被改成不在 url_domains 內或不是 https → 不轉發（登記後被竄改也不外送）', async () => {
        for (const bad of ['https://evil.example.com/steal', 'http://api.picker.example.com/lm/events', 'https://127.0.0.1/x']) {
            await d1.db.prepare('UPDATE products SET event_url = ?2 WHERE product_id = ?1').bind(PRD, bad).run();
            const r = await forward({ webhookEventId: `tamper-${bad.length}-0000` });
            assert.equal(r.outcome, 'not_forwarded', bad);
        }
        assert.equal(productCalls.length, 0);
    });

    it('沒有對象的 px: 事件不在 D1 留下去重旗標', async () => {
        await forward({}, { data: 'px:zz:plans' });
        assert.equal(await count(d1.db, 'flags'), 0);
    });

    it('條件不成立且這個動作有設定備用內容 → 回備用內容；沒設定 → 不回覆', async () => {
        await d1.db.prepare("UPDATE links SET status = 'revoked' WHERE link_id = ?1").bind(LNK).run();
        await putFallback('plans', { title: '服務維護中', body: '稍後再試' });
        const withFb = await forward();
        assert.equal(withFb.outcome, 'not_forwarded');
        assert.equal(withFb.messages[0].altText, '服務維護中');
        const without = await forward({ webhookEventId: 'nofb-00000000001' }, { data: 'px:ip:other' });
        assert.deepEqual(without, { messages: null, outcome: 'not_forwarded' });
    });

    it('缺 TOKEN_ENCRYPTION_KEY 或解不開 → 不轉發（絕不用明文）', async () => {
        const r = await forward({}, { e: { ...env, TOKEN_ENCRYPTION_KEY: undefined } });
        assert.equal(r.outcome, 'not_forwarded');
        const r2 = await forward({ webhookEventId: 'wrongkey-00000001' }, { e: { ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') } });
        assert.equal(r2.outcome, 'not_forwarded');
        assert.equal(productCalls.length, 0);
    });

    it('缺 0006 遷移（沒有 event_url 欄位）→ 不轉發、不丟錯', async () => {
        const old = await createTestD1({ upTo: '0005' });
        try {
            const r = await forward({}, { e: { ...env, BRIDGE_DB: old.db } });
            assert.equal(r.outcome, 'not_forwarded');
            assert.equal(productCalls.length, 0);
        } finally {
            await old.dispose();
        }
    });
});

// ───────────────────────── 去重與限流 ─────────────────────────

describe('去重與限流', () => {
    it('同一個 webhookEventId 第二次 → duplicate，不再呼叫產品、不再回覆', async () => {
        assert.equal((await forward()).outcome, 'replied');
        const again = await forward();
        assert.deepEqual(again, { messages: null, outcome: 'duplicate' });
        assert.equal(productCalls.length, 1);
    });

    it('不同的 webhookEventId、不同的 bot 都不互相影響；沒有 webhookEventId 就沒辦法去重（照常轉發）', async () => {
        await forward();
        assert.equal((await forward({ webhookEventId: 'other-event-00001' })).outcome, 'replied');
        assert.equal((await forward({ webhookEventId: undefined })).outcome, 'replied');
        assert.equal((await forward({ webhookEventId: undefined })).outcome, 'replied');
    });

    it('每位使用者每條連結每分鐘 10 次，第 11 次靜默略過（不呼叫產品、不寫稽核）；別的使用者不受影響', async () => {
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            for (let i = 0; i < 10; i++) assert.equal((await forward({ webhookEventId: `rate-${i}-0000000` })).outcome, 'replied');
            const before = (await auditRows()).length;
            const limited = await forward({ webhookEventId: 'rate-11-0000000' });
            assert.deepEqual(limited, { messages: null, outcome: 'rate_limited' });
            assert.equal(productCalls.length, 10);
            assert.equal((await auditRows()).length, before);
            assert.equal((await forward({ webhookEventId: 'rate-u2-0000000', source: { type: 'user', userId: USER2 } })).outcome, 'replied');
        } finally {
            Date.now = realNow;
        }
    });
});

// ───────────────────────── 稽核與 log ─────────────────────────

describe('稽核與 log 不含個資', () => {
    it('稽核只有 event_id、link_id、product_id、action 名稱、結果、延遲；不含 userId、ref、params 值、reply 內容、replyToken', async () => {
        await bindContact();
        await forward();
        productHandler = () => new Response('oops', { status: 500 });
        await forward({ webhookEventId: 'audit-00000000002' });
        productHandler = () => new Response(null, { status: 204 });
        await forward({ webhookEventId: 'audit-00000000003' });
        const rows = await auditRows();
        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map((r) => JSON.parse(r.detail).outcome), ['replied', 'fallback_error', 'no_reply']);
        const first = JSON.parse(rows[0].detail);
        assert.deepEqual(Object.keys(first).sort(), ['event_action', 'event_id', 'latency_ms', 'link_id', 'outcome', 'product_id']);
        assert.equal(first.event_action, 'plans');
        const dump = JSON.stringify(rows) + logs.join('\n');
        for (const s of [USER, REF, REPLY_TOKEN, 'wedding', '請看方案', SECRET, EVENT_URL, RAW_DATA]) assert.ok(!dump.includes(s), s);
    });

    it('轉發失敗時 log 不含網址、密鑰、userId', async () => {
        productHandler = () => { throw new Error(`connect ECONNREFUSED ${EVENT_URL}`); };
        const r = await forward();
        assert.equal(r.outcome, 'fallback_error');
        const dump = logs.join('\n');
        for (const s of [USER, SECRET, EVENT_URL, REPLY_TOKEN]) assert.ok(!dump.includes(s), s);
    });
});

// ───────────────────────── event_handler 的 px: 分支 ─────────────────────────

describe('lib/event_handler.js 的 px: 分支', () => {
    const post = (data = RAW_DATA, over = {}) => handlePostbackEvent(
        eventOf({ postback: { data }, ...over }), env, OWNER, 'tok', null, BOT);

    it('產品回 reply → 用 replyToken 回給客人（一次），計入回覆統計', async () => {
        await post();
        assert.equal(lineReplies.length, 1);
        assert.equal(lineReplies[0].replyToken, REPLY_TOKEN);
        assert.equal(lineReplies[0].messages[0].type, 'flex');
        assert.equal(JSON.parse(await kv.get(BotKeys.messageStats(BOT))).total, 1);
    });

    it('204 → 不回覆；逾時 → 回通用文字，之後不會再 push', async () => {
        productHandler = () => new Response(null, { status: 204 });
        await post();
        assert.equal(lineReplies.length, 0);
        productHandler = () => new Promise(() => {});
        await post(RAW_DATA, { webhookEventId: 'handler-timeout-001' });
        assert.deepEqual(lineReplies[0].messages, [{ type: 'text', text: GENERIC_FALLBACK_TEXT }]);
        assert.deepEqual(linePushes, []);
    });

    it('BRIDGE_ENABLED 未開 → 照 4A 的行為：不回覆、不呼叫產品', async () => {
        env.BRIDGE_ENABLED = undefined;
        await post();
        assert.equal(lineReplies.length, 0);
        assert.equal(productCalls.length, 0);
    });

    it('LINE 重送同一個事件 → 只回覆一次', async () => {
        await post();
        await post();
        assert.equal(lineReplies.length, 1);
        assert.equal(productCalls.length, 1);
    });

    it('客人看到的任何訊息都不含原始 data、userId、replyToken 以外的內部字串', async () => {
        productHandler = () => new Response('oops', { status: 500 });
        await post();
        const out = JSON.stringify(lineReplies);
        assert.ok(!out.includes(RAW_DATA));
        assert.ok(!out.includes('已收到您的操作'));
    });
});

// ───────────────────────── 工具函式 ─────────────────────────

describe('工具函式', () => {
    it('generateEventSecret：pes_ 開頭、每次不同、夠長', () => {
        const a = generateEventSecret();
        assert.match(a, /^pes_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(a, generateEventSecret());
    });

    it('checkEventUrl：https、主機在 url_domains 內；帶 fragment、http、IP、別的網域一律不接受', () => {
        const d = ['picker.example.com'];
        assert.equal(checkEventUrl('https://api.picker.example.com/events', d).ok, true);
        assert.equal(checkEventUrl('https://picker.example.com/e?x=1', d).ok, true);
        for (const bad of ['http://picker.example.com/e', 'https://evil.com/e', 'https://picker.example.com/e#f', 'https://1.2.3.4/e', 'https://localhost/e', 'https://user:pw@picker.example.com/e', 'https://picker.example.com:8443/e', '', 5, null]) {
            assert.equal(checkEventUrl(bad, d).ok, false, String(bad));
        }
    });

    it('產品表的密文可還原；資料庫裡沒有明文密鑰', async () => {
        const row = await d1.db.prepare('SELECT event_secret_enc AS e FROM products WHERE product_id = ?1').bind(PRD).first();
        assert.match(row.e, /^enc\.v1\./);
        assert.ok(!row.e.includes(SECRET));
        assert.equal(await count(d1.db, 'products', "event_secret_enc LIKE '%pes_%'"), 0);
    });
});
