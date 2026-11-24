/**
 * Unit Tests — LM-4B 營運與後台端點（經 handleBridge，真 D1）
 *
 *   POST  /bridge/v1/admin/products                  帶 event_url → 一次性 event_signing_secret
 *   PATCH /bridge/v1/admin/products/{id}             設 event_url、輪替簽章密鑰、events:receive 只增不減
 *   GET|PUT|DELETE /bridge/v1/admin/event-fallbacks  備用內容（LIFF 人主體 + owner）
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { all } from '../helpers/bridge_seed.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import { openSecret } from '../../worker_src/lm_service.js';
import { handleBridge } from '../../worker_src/bridge/index.js';

const ORIGIN = 'https://worker.example.com';
const ADMIN = 'test-admin-secret-not-real';
const OWNER = 'Uowner0000000000000000000000001';
const OTHER = 'Uowner0000000000000000000000003';
const MEMBER = 'Umember000000000000000000000002';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const URI = 'https://picker.example.com/cb';
const EVENT_URL = 'https://api.picker.example.com/lm/events';
const SCOPES = ['link:manage', 'contacts:bind', 'messages:send', 'segments:write', 'events:receive'];

let d1;
let env;
let kv;
let seen;
const originalError = console.error;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', BRIDGE_ADMIN_SECRET: ADMIN, AUTH_MODE: 'legacy', TOKEN_ENCRYPTION_KEY: ENC_KEY };
    seen = [];
    console.error = () => {};
    await kv.put(BotKeys.permissions(BOT), JSON.stringify({ users: [{ userId: OWNER, role: 'owner' }, { userId: MEMBER, role: 'member' }] }));
    await kv.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }], currentBotId: BOT }));
});
afterEach(() => { console.error = originalError; });

async function call(method, path, { headers = {}, body, e = env } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const url = new URL(`${ORIGIN}${path}`);
    const res = await handleBridge(new Request(url, init), e, url.pathname);
    const text = await res.text();
    seen.push(text);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* 204 */ }
    return { res, text, body: parsed };
}
const admin = (m, p, body, e) => call(m, p, { headers: { Authorization: `Bearer ${ADMIN}` }, body, e });
const asUser = (m, p, body, user = OWNER) => call(m, p, { headers: { 'X-User-Id': user, 'X-Bot-Id': BOT }, body });
const base = { name: 'Image Picker', redirect_uris: [URI], url_domains: ['picker.example.com'] };
const register = (over = {}) => admin('POST', '/bridge/v1/admin/products', { ...base, scopes: SCOPES, product_key: 'ip', event_url: EVENT_URL, ...over });
const stored = (id) => d1.db.prepare('SELECT product_key, event_url, event_secret_enc, scopes FROM products WHERE product_id = ?1').bind(id).first();

describe('POST /admin/products 的 event_url', () => {
    it('events:receive + product_key + event_url → 201，回一次性 event_signing_secret；資料庫只有密文', async () => {
        const r = await register();
        assert.equal(r.res.status, 201, r.text);
        assert.match(r.body.event_signing_secret, /^pes_[A-Za-z0-9_-]{43}$/);
        assert.equal(r.body.event_url, EVENT_URL);
        const row = await stored(r.body.product_id);
        assert.match(row.event_secret_enc, /^enc\.v1\./);
        assert.ok(!JSON.stringify(row).includes(r.body.event_signing_secret));
        assert.equal(await openSecret(env, row.event_secret_enc), r.body.event_signing_secret);
        assert.notEqual(r.body.event_signing_secret, r.body.product_secret);
    });

    it('沒有 events:receive → 不回密鑰；帶了 event_url 卻沒這個 scope → 400', async () => {
        const ok = await register({ scopes: ['contacts:bind'], event_url: undefined });
        assert.equal(ok.res.status, 201);
        assert.equal(ok.body.event_signing_secret, undefined);
        const bad = await register({ scopes: ['contacts:bind'] });
        assert.equal(bad.res.status, 400);
    });

    it('events:receive 缺 product_key 或 event_url、event_url 不合規則 → 400，不建立', async () => {
        const cases = [
            { product_key: undefined },
            { event_url: undefined },
            { event_url: 'http://api.picker.example.com/e' },
            { event_url: 'https://evil.example.com/e' },
            { event_url: 'https://api.picker.example.com/e#frag' },
            { event_url: 'https://127.0.0.1/e' },
            { event_url: 'https://user:pw@api.picker.example.com/e' },
        ];
        for (const over of cases) {
            const r = await register(over);
            assert.equal(r.res.status, 400, JSON.stringify(over));
        }
        assert.equal((await all(d1.db, 'SELECT product_id FROM products')).length, 0);
    });

    it('缺 TOKEN_ENCRYPTION_KEY → 503，不建立產品、不存明文', async () => {
        const r = await admin('POST', '/bridge/v1/admin/products', { ...base, scopes: SCOPES, product_key: 'ip', event_url: EVENT_URL }, { ...env, TOKEN_ENCRYPTION_KEY: undefined });
        assert.equal(r.res.status, 503);
        assert.equal((await all(d1.db, 'SELECT product_id FROM products')).length, 0);
    });
});

describe('PATCH /admin/products/{id}', () => {
    const patch = (id, body) => admin('PATCH', `/bridge/v1/admin/products/${id}`, body);

    it('補登 IP：product_key + events:receive + event_url → 回一次性簽章密鑰', async () => {
        const reg = await register({ scopes: ['contacts:bind', 'messages:send'], product_key: undefined, event_url: undefined });
        const r = await patch(reg.body.product_id, { product_key: 'ip', scopes: ['contacts:bind', 'messages:send', 'events:receive'], event_url: EVENT_URL });
        assert.equal(r.res.status, 200, r.text);
        assert.match(r.body.event_signing_secret, /^pes_/);
        assert.equal(r.body.event_url, EVENT_URL);
        assert.deepEqual(r.body.scopes, ['contacts:bind', 'messages:send', 'events:receive']);
    });

    it('rotate_event_secret → 新密鑰（只回一次）、舊密鑰立刻失效；不輪替就不回密鑰', async () => {
        const reg = await register();
        const id = reg.body.product_id;
        const rotated = await patch(id, { rotate_event_secret: true });
        assert.equal(rotated.res.status, 200, rotated.text);
        assert.notEqual(rotated.body.event_signing_secret, reg.body.event_signing_secret);
        assert.equal(await openSecret(env, (await stored(id)).event_secret_enc), rotated.body.event_signing_secret);
        const plain = await patch(id, { event_url: 'https://api.picker.example.com/v2/events' });
        assert.equal(plain.res.status, 200);
        assert.equal(plain.body.event_signing_secret, undefined);
        assert.equal((await stored(id)).event_url, 'https://api.picker.example.com/v2/events');
    });

    it('events:receive 只增不減；沒有 events:receive 不能輪替或設 event_url；缺 event_url／product_key 不能加 events:receive', async () => {
        const reg = await register();
        const id = reg.body.product_id;
        assert.equal((await patch(id, { scopes: ['contacts:bind'] })).res.status, 400);
        const plain = await register({ scopes: ['contacts:bind'], product_key: 'pp', event_url: undefined });
        const pid = plain.body.product_id;
        assert.equal((await patch(pid, { rotate_event_secret: true })).res.status, 400);
        assert.equal((await patch(pid, { event_url: EVENT_URL })).res.status, 400);
        assert.equal((await patch(pid, { scopes: ['contacts:bind', 'events:receive'] })).res.status, 400, '缺 event_url');
        assert.equal((await patch(pid, { scopes: ['contacts:bind', 'events:receive'], event_url: 'https://evil.com/e' })).res.status, 400);
        const ok = await patch(pid, { scopes: ['contacts:bind', 'events:receive'], event_url: EVENT_URL });
        assert.equal(ok.res.status, 200, ok.text);
        assert.ok(ok.body.event_signing_secret);
    });

    it('url_domains 只能增加：加網域成功、同一個請求的 event_url 可用新網域；縮小或換掉 → 400', async () => {
        const reg = await register({ scopes: ['contacts:bind'], product_key: 'ip', event_url: undefined });
        const id = reg.body.product_id;
        const other = 'https://worker.other-domain.dev/lm/events';
        assert.equal((await patch(id, { scopes: ['contacts:bind', 'events:receive'], event_url: other })).res.status, 400, '新網域還沒加入前，event_url 被擋');
        const ok = await patch(id, { url_domains: ['picker.example.com', 'other-domain.dev'], scopes: ['contacts:bind', 'events:receive'], event_url: other });
        assert.equal(ok.res.status, 200, ok.text);
        assert.deepEqual(ok.body.url_domains, ['picker.example.com', 'other-domain.dev']);
        assert.equal(ok.body.event_url, other);
        assert.ok(ok.body.event_signing_secret);
        assert.equal((await patch(id, { url_domains: ['other-domain.dev'] })).res.status, 400, '縮小（拿掉舊網域）');
        assert.equal((await patch(id, { url_domains: [] })).res.status, 400);
        assert.equal((await patch(id, { url_domains: ['picker.example.com', 'other-domain.dev'] })).res.status, 200, '同樣的集合是冪等');
        const row = await d1.db.prepare('SELECT url_domains FROM products WHERE product_id = ?1').bind(id).first();
        assert.deepEqual(JSON.parse(row.url_domains), ['picker.example.com', 'other-domain.dev']);
    });

    it('url_domains 格式：小寫網域名稱，不含 scheme、埠、萬用字元、路徑；最多 20 個；不是陣列 → 400', async () => {
        const reg = await register({ scopes: ['contacts:bind'], product_key: 'ip', event_url: undefined });
        const id = reg.body.product_id;
        // 營運端點每 IP 每分鐘 10 次：這個測試的呼叫很多，每次換一個來源 IP
        let n = 0;
        const patch = (pid, body) => call('PATCH', `/bridge/v1/admin/products/${pid}`, { headers: { Authorization: `Bearer ${ADMIN}`, 'CF-Connecting-IP': `198.51.100.${++n}` }, body });
        for (const d of ['https://x.example.com', 'x.example.com:8443', '*.example.com', 'x.example.com/path', 'X.Example.com', 'localhost', 'a b.com', 5]) {
            assert.equal((await patch(id, { url_domains: ['picker.example.com', d] })).res.status, 400, String(d));
        }
        const many = ['picker.example.com', ...Array.from({ length: 20 }, (_, i) => `d${i}.example.com`)];
        assert.equal((await patch(id, { url_domains: many })).res.status, 400);
        assert.equal((await patch(id, { url_domains: 'picker.example.com' })).res.status, 400);
    });

    it('新增的網域也成為通知按鈕網址的白名單（備用訊息的 action.url 可用新網域）', async () => {
        const reg = await register();
        await patch(reg.body.product_id, { url_domains: ['picker.example.com', 'other-domain.dev'] });
        const put = await asUser('PUT', '/bridge/v1/admin/event-fallbacks', {
            product_key: 'ip', action: 'plans', content: { title: 't', body: 'b', action: { label: 'go', url: 'https://other-domain.dev/plans' } },
        });
        assert.equal(put.res.status, 200, put.text);
    });

    it('回應與稽核不含簽章密鑰；密鑰只出現在登記或輪替的那一次回應', async () => {
        const reg = await register();
        await patch(reg.body.product_id, { event_url: 'https://api.picker.example.com/x' });
        const audit = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        assert.ok(!audit.includes(reg.body.event_signing_secret));
        assert.equal(seen.filter((t) => t.includes(reg.body.event_signing_secret)).length, 1);
    });
});

describe('備用內容 /admin/event-fallbacks', () => {
    let productId;
    beforeEach(async () => { productId = (await register()).body.product_id; });
    const content = { title: '暫時無法顯示', body: '請稍後再試', action: { label: '官網', url: 'https://picker.example.com/plans' } };
    const put = (over = {}, user) => asUser('PUT', '/bridge/v1/admin/event-fallbacks', { product_key: 'ip', action: 'plans', content, ...over }, user);

    it('PUT → 200；GET 列出；DELETE → 204（冪等）', async () => {
        const r = await put();
        assert.equal(r.res.status, 200, r.text);
        const list = await asUser('GET', '/bridge/v1/admin/event-fallbacks?product_key=ip');
        assert.equal(list.res.status, 200);
        assert.deepEqual(list.body.fallbacks, [{ action: 'plans', content }]);
        assert.equal((await asUser('DELETE', '/bridge/v1/admin/event-fallbacks?product_key=ip&action=plans')).res.status, 204);
        assert.equal((await asUser('DELETE', '/bridge/v1/admin/event-fallbacks?product_key=ip&action=plans')).res.status, 204);
        assert.deepEqual((await asUser('GET', '/bridge/v1/admin/event-fallbacks?product_key=ip')).body.fallbacks, []);
    });

    it('內容驗證同 Notification：長度、連結文字、網址白名單、多餘欄位 → 400', async () => {
        const bad = [
            { title: '', body: 'x' },
            { title: 't'.repeat(41), body: 'x' },
            { title: 't', body: '看 https://picker.example.com' },
            { title: 't', body: 'b', action: { label: 'go', url: 'https://evil.example.com/' } },
            { title: 't', body: 'b', action: { label: 'go', url: 'http://picker.example.com/' } },
            { title: 't', body: 'b', extra: 1 },
            'string',
        ];
        for (const c of bad) assert.equal((await put({ content: c })).res.status, 400, JSON.stringify(c));
        assert.equal((await put({ action: 'Bad Action' })).res.status, 400);
        assert.equal((await put({ product_key: 'nope' })).res.status, 404);
        assert.equal((await all(d1.db, 'SELECT * FROM event_fallbacks')).length, 0);
    });

    it('只有這個 OA 的 owner 能設定：member、別人的 OA、沒有 LIFF 身分 → 擋下', async () => {
        assert.equal((await put({}, MEMBER)).res.status, 404);
        assert.equal((await put({}, OTHER)).res.status, 404);
        const anon = await call('PUT', '/bridge/v1/admin/event-fallbacks', { headers: { 'X-Bot-Id': BOT }, body: { product_key: 'ip', action: 'plans', content } });
        assert.ok([401, 403].includes(anon.res.status), String(anon.res.status));
        assert.equal((await all(d1.db, 'SELECT * FROM event_fallbacks')).length, 0);
    });

    it('備用內容依 bot 分開：另一個 OA 看不到', async () => {
        await put();
        const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        await kv.put(BotKeys.permissions(BOT2), JSON.stringify({ users: [{ userId: OTHER, role: 'owner' }] }));
        const r = await call('GET', '/bridge/v1/admin/event-fallbacks?product_key=ip', { headers: { 'X-User-Id': OTHER, 'X-Bot-Id': BOT2 } });
        assert.deepEqual(r.body.fallbacks, []);
        assert.ok(productId);
    });

    it('稽核 event_fallback_set／deleted 只記 product_id 與 action 名稱，不記內容', async () => {
        await put();
        await asUser('DELETE', '/bridge/v1/admin/event-fallbacks?product_key=ip&action=plans');
        const rows = await all(d1.db, "SELECT action, detail FROM audit_log WHERE action LIKE 'event_fallback_%' ORDER BY id");
        assert.deepEqual(rows.map((r) => r.action), ['event_fallback_set', 'event_fallback_deleted']);
        assert.ok(!JSON.stringify(rows).includes('暫時無法顯示'));
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: productId, event_action: 'plans' });
    });
});
