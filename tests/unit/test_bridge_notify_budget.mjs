/**
 * Unit Tests — M-01：POST /bridge/v1/messages 的發送預算（D1 原子計數，端到端經 handleBridge，真 D1）
 *
 * 每分鐘 60／每（連結, ref）每小時 10／每連結每日 500（env BRIDGE_LINK_DAILY_CAP）。重點：
 *   - 並行請求實際送出的數量不超過預算（含日預算）；預算用盡不打 LINE
 *   - 429 帶 Retry-After（≥ 1，等於距視窗結束的秒數）、日預算用盡是 402 QUOTA_EXCEEDED
 *   - 固定視窗邊界；重送（冪等回放、處理中）不吃預算；驗證失敗不扣
 *   - 80% 時寫 usage_high（每連結每日一次）；BRIDGE_LINK_DAILY_CAP 的安全解析
 *   - 計數鍵與稽核不含 ref／userId；缺 0004 遷移時 503（fail-closed）
 * 沒有任何 sleep：並行用 Promise.all，LINE 端用閘門（事件驅動）。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { withPinnedWindow } from '../helpers/pin_time.mjs';
import { seedLink, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import { dailyCapFor, DEFAULT_LINK_DAILY_CAP } from '../../worker_src/bridge/notify.js';

const ORIGIN = 'https://worker.example.com';
const OWNER = 'Uowner0000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const LNK_A = 'lnk_aaaaaaaaaaaaaaaa';
const LNK_B = 'lnk_bbbbbbbbbbbbbbbb';
const PRD_A = 'prd_aaaaaaaaaaaa';
const PRD_B = 'prd_bbbbbbbbbbbb';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const KEY_B = 'brk_bbbbbb_link-key-for-b-0000000000000000000000';
const LINE_TOKEN = 'TOKEN_SECRET_VALUE_X';
const REF = 'customer-0001';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

let d1;
let env;
let kv;
let line;
let logs;
let seq = 0;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const consoleMethods = ['error', 'warn', 'log', 'info'];
const originalConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });

function installLine() {
    line = { pushCalls: [], gate: null, push: () => new Response('{}', { status: 200 }) };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v2/bot/message/quota/consumption')) return new Response(JSON.stringify({ totalUsage: 1 }), { status: 200 });
        if (u.endsWith('/v2/bot/message/quota')) return new Response(JSON.stringify({ type: 'limited', value: 100000 }), { status: 200 });
        if (u === PUSH_URL) {
            line.pushCalls.push({ body: JSON.parse(init.body) });
            if (line.gate) await line.gate();
            return line.push();
        }
        throw new Error(`unexpected fetch ${u}`);
    };
}

async function bind(linkId, ref, userId, botId = BOT) {
    await d1.db.prepare(
        "INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'bound', 1, 1)"
    ).bind(linkId, ref, botId, userId).run();
}
const userOf = (i) => `Uline${String(i).padStart(28, '0')}`;
const refOf = (i) => `customer-${String(i + 100).padStart(4, '0')}`; // 與預設的 REF（customer-0001）不衝突

beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { KV_LINE_STORAGE: kv, BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1' };
    logs = [];
    for (const m of consoleMethods) console[m] = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    installLine();
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: LINE_TOKEN, destination: BOT } }));
    await seedLink(d1.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A });
    await seedLink(d1.db, { linkId: LNK_B, productId: PRD_B, botId: BOT, key: KEY_B });
    await bind(LNK_A, REF, userOf(0));
});
afterEach(() => {
    for (const m of consoleMethods) console[m] = originalConsole[m];
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
});

async function send(over = {}, { key = KEY_A, idem, e = env } = {}) {
    const url = new URL(`${ORIGIN}/bridge/v1/messages`);
    const body = { external_contact_ref: REF, event_type: 'order.shipped', title: 'T', body: 'B', ...over };
    const res = await handleBridge(new Request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': idem ?? `idem-${++seq}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }), e, url.pathname);
    const text = await res.text();
    return { res, text, status: res.status, body: text ? JSON.parse(text) : null };
}
const code = (r) => r.body && r.body.error && r.body.error.code;
const counter = async (prefix) => (await all(d1.db, 'SELECT scope_key, window, n FROM counters WHERE scope_key LIKE ?1', `${prefix}%`));
const nOf = async (prefix) => (await counter(prefix)).reduce((a, r) => a + r.n, 0);
const auditRows = (action) => all(d1.db, 'SELECT * FROM audit_log WHERE action = ?1', action);
const withNow = async (ms, fn) => { Date.now = () => ms; try { return await fn(); } finally { Date.now = originalNow; } };

/** 一個 gate：等到 expected 個請求都到達 LINE 才一起放行（事件驅動，沒有 sleep） */
function lineGate(expected) {
    let arrived = 0;
    let release;
    const opened = new Promise((r) => { release = r; });
    line.gate = async () => { arrived++; if (arrived >= expected) release(); await opened; };
}

describe('BRIDGE_LINK_DAILY_CAP 解析', () => {
    it('正整數才採用；其餘（缺、空、0、負、小數、字母、科學記號、超長）一律預設 500', () => {
        assert.equal(DEFAULT_LINK_DAILY_CAP, 500);
        assert.equal(dailyCapFor({}), 500);
        assert.equal(dailyCapFor(undefined), 500);
        assert.equal(dailyCapFor({ BRIDGE_LINK_DAILY_CAP: '25' }), 25);
        assert.equal(dailyCapFor({ BRIDGE_LINK_DAILY_CAP: ' 25 ' }), 25);
        assert.equal(dailyCapFor({ BRIDGE_LINK_DAILY_CAP: 7 }), 7);
        for (const v of ['', '0', '-5', '1.5', 'abc', '1e3', '0x10', '12abc', '9999999999', '٣', null, {}, [], true, NaN, Infinity, 0, -1]) {
            assert.equal(dailyCapFor({ BRIDGE_LINK_DAILY_CAP: v }), 500, JSON.stringify(v));
        }
    });

    it('端到端：設成 2 → 第 3 則 402；亂填的值 → 退回預設（不會變成 0 或 NaN 而全擋／全放）', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '2' };
        await withPinnedWindow(async () => {
            assert.equal((await send({}, { e })).status, 200);
            assert.equal((await send({}, { e })).status, 200);
            const r = await send({}, { e });
            assert.equal(r.status, 402);
            assert.equal(code(r), 'QUOTA_EXCEEDED');
            assert.equal(r.body.error.retryable, false);
            assert.equal(line.pushCalls.length, 2);
            assert.equal((await send({}, { e: { ...env, BRIDGE_LINK_DAILY_CAP: 'oops' }, key: KEY_B, idem: 'x1' })).status, 409); // 預設 500，B 沒綁定 → 409 而不是 402
        });
    });
});

describe('日預算', () => {
    it('用盡 → 402 QUOTA_EXCEEDED，不打 LINE、不搶佔冪等鍵、不吃分鐘與小時名額；別條連結不受影響', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '3' };
        await withPinnedWindow(async () => {
            for (let i = 0; i < 3; i++) assert.equal((await send({}, { e })).status, 200);
            const idemBefore = await count(d1.db, 'idempotency');
            const r = await send({}, { e });
            assert.equal(r.status, 402);
            assert.equal(code(r), 'QUOTA_EXCEEDED');
            assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message', 'retryable']);
            assert.equal(line.pushCalls.length, 3);
            assert.equal(await count(d1.db, 'idempotency'), idemBefore);
            assert.equal(await nOf('send:min:'), 3, '被日預算擋下的請求把分鐘名額還回去');
            assert.equal(await nOf('send:hour:'), 3);
            assert.equal(await nOf('send:day:'), 3);
            await bind(LNK_B, REF, userOf(9));
            assert.equal((await send({}, { e, key: KEY_B })).status, 200);
        });
    });

    it('並行 12 個（各自不同的聯絡人）、日預算 5：實際打到 LINE 的恰好 5 個，其餘 402', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '5' };
        for (let i = 1; i <= 12; i++) await bind(LNK_A, refOf(i), userOf(i));
        lineGate(5); // 5 個都到 LINE 了才放行：證明這 5 個是真的同時在途
        await withPinnedWindow(async () => {
            const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => send({ external_contact_ref: refOf(i + 1) }, { e })));
            assert.equal(rs.filter((r) => r.status === 200).length, 5);
            assert.equal(rs.filter((r) => r.status === 402).length, 7);
            assert.equal(line.pushCalls.length, 5);
            assert.equal(await nOf('send:day:'), 5);
        });
    });

    it('日預算在 UTC 日界線重置：最後一毫秒仍擋、下一毫秒放行', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '1' };
        const dayStart = Math.floor(originalNow() / DAY) * DAY;
        await withNow(dayStart + 5 * HOUR, async () => {
            assert.equal((await send({}, { e })).status, 200);
        });
        await withNow(dayStart + DAY - 1, async () => {
            assert.equal((await send({}, { e })).status, 402);
        });
        await withNow(dayStart + DAY, async () => {
            assert.equal((await send({}, { e })).status, 200);
        });
        assert.equal(line.pushCalls.length, 2);
    });
});

describe('分鐘與小時限流（D1）', () => {
    it('並行 70 個（各自不同的 ref，未綁定 → 409，不打 LINE）、每連結每分鐘 60：恰好 60 個通過、10 個 429', async () => {
        await withPinnedWindow(async () => {
            const rs = await Promise.all(Array.from({ length: 70 }, (_, i) => send({ external_contact_ref: `customer-x${String(i).padStart(3, '0')}` })));
            assert.equal(rs.filter((r) => r.status === 409).length, 60);
            const limited = rs.filter((r) => r.status === 429);
            assert.equal(limited.length, 10);
            for (const r of limited) {
                assert.equal(code(r), 'RATE_LIMITED');
                assert.equal(r.body.error.retryable, true);
            }
            assert.equal(line.pushCalls.length, 0);
            assert.equal(await nOf('send:min:'), 60);
        });
    });

    it('並行 16 個送給同一位聯絡人、每小時 10：恰好 10 次送到 LINE，其餘 429（且把分鐘名額還回去）', async () => {
        lineGate(10);
        await withPinnedWindow(async () => {
            const rs = await Promise.all(Array.from({ length: 16 }, () => send()));
            assert.equal(rs.filter((r) => r.status === 200).length, 10);
            assert.equal(rs.filter((r) => r.status === 429).length, 6);
            assert.equal(line.pushCalls.length, 10);
            assert.equal(await nOf('send:min:'), 10);
            assert.equal(await nOf('send:day:'), 10);
        });
    });

    it('Retry-After：分鐘限流 = 距視窗結束的秒數（視窗中段 20 秒 → 40）；視窗最後一毫秒 → 1（永遠 ≥ 1）', async () => {
        const base = Math.floor(originalNow() / HOUR) * HOUR + 7 * MIN; // 小時內第 7 分鐘的起點
        await withNow(base + 20_000, async () => {
            for (let i = 0; i < 60; i++) assert.equal((await send({ external_contact_ref: `customer-y${String(i).padStart(3, '0')}` })).status, 409);
            const r = await send({ external_contact_ref: 'customer-y999' });
            assert.equal(r.status, 429);
            assert.equal(r.res.headers.get('Retry-After'), '40');
        });
        await withNow(base + MIN - 1, async () => {
            const r = await send({ external_contact_ref: 'customer-y998' });
            assert.equal(r.status, 429);
            assert.equal(r.res.headers.get('Retry-After'), '1');
        });
        await withNow(base + MIN, async () => {
            assert.equal((await send({ external_contact_ref: 'customer-y997' })).status, 409); // 新視窗
        });
    });

    it('Retry-After：每聯絡人小時限流 = 距小時視窗結束的秒數', async () => {
        const hourStart = Math.floor(originalNow() / HOUR) * HOUR;
        // 避開分鐘限流：每筆用不同的分鐘
        for (let i = 0; i < 10; i++) await withNow(hourStart + i * MIN + 1000, async () => { assert.equal((await send()).status, 200); });
        await withNow(hourStart + 30 * MIN, async () => {
            const r = await send();
            assert.equal(r.status, 429);
            assert.equal(r.res.headers.get('Retry-After'), String(30 * 60));
        });
        await withNow(hourStart + HOUR, async () => {
            assert.equal((await send()).status, 200);
        });
    });
});

describe('重送與驗證失敗不吃預算', () => {
    it('同一把 Idempotency-Key 重送（回放）：分鐘、小時、日的計數都不增加', async () => {
        await withPinnedWindow(async () => {
            assert.equal((await send({}, { idem: 'same' })).status, 200);
            const snapshot = JSON.stringify(await all(d1.db, 'SELECT scope_key, n FROM counters ORDER BY scope_key'));
            for (let i = 0; i < 5; i++) {
                const r = await send({}, { idem: 'same' });
                assert.equal(r.status, 200);
                assert.equal(r.res.headers.get('X-Idempotency-Replayed'), 'true');
            }
            assert.equal(JSON.stringify(await all(d1.db, 'SELECT scope_key, n FROM counters ORDER BY scope_key')), snapshot);
            assert.equal(line.pushCalls.length, 1);
        });
    });

    it('並行 8 個重送同一把鍵：LINE 只收到 1 則，計數最後只算 1（其餘是回放或 IN_PROGRESS，名額都還回去）', async () => {
        lineGate(1);
        await withPinnedWindow(async () => {
            const rs = await Promise.all(Array.from({ length: 8 }, () => send({}, { idem: 'race' })));
            assert.equal(line.pushCalls.length, 1);
            assert.ok(rs.every((r) => r.status === 200 || (r.status === 409 && code(r) === 'IN_PROGRESS')), rs.map((r) => r.status).join(','));
            assert.equal(await nOf('send:min:'), 1);
            assert.equal(await nOf('send:hour:'), 1);
            assert.equal(await nOf('send:day:'), 1);
        });
    });

    it('同一把鍵配不同內容（422 IDEMPOTENCY_KEY_REUSE）也不吃預算', async () => {
        await withPinnedWindow(async () => {
            await send({}, { idem: 'k1' });
            const r = await send({ title: 'other' }, { idem: 'k1' });
            assert.equal(r.status, 422);
            assert.equal(code(r), 'IDEMPOTENCY_KEY_REUSE');
            assert.equal(await nOf('send:day:'), 1);
        });
    });

    it('格式錯誤的請求（400）不扣任何預算；action.url 不在白名單（422）只佔每分鐘那一格', async () => {
        await withPinnedWindow(async () => {
            assert.equal((await send({ title: '' })).status, 400);
            assert.equal(await count(d1.db, 'counters'), 0);
            const r = await send({ action: { label: 'x', url: 'https://evil.example/' } });
            assert.equal(r.status, 422);
            assert.equal(await nOf('send:min:'), 1);
            assert.equal(await nOf('send:hour:'), 0);
            assert.equal(await nOf('send:day:'), 0);
        });
    });

    it('被擋下（429／402）或 LINE 失敗的請求本身：429／402 不吃名額；LINE 5xx 算一次嘗試', async () => {
        await withPinnedWindow(async () => {
            line.push = () => new Response('{"message":"boom"}', { status: 500 });
            const r = await send();
            assert.equal(r.status, 502);
            assert.equal(await nOf('send:day:'), 1);
        });
    });
});

describe('usage_high 稽核', () => {
    it('日預算用到 80% 時寫一筆（每連結每日一次），detail 只有 product_id 與 link_id', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '10' };
        for (let i = 1; i <= 11; i++) await bind(LNK_A, refOf(i), userOf(i)); // 各自的聯絡人：不會先撞到每聯絡人的小時上限
        const to = (i) => send({ external_contact_ref: refOf(i) }, { e });
        await withPinnedWindow(async () => {
            for (let i = 1; i <= 7; i++) await to(i);
            assert.equal((await auditRows('usage_high')).length, 0);
            await to(8); // 第 8 則 = 80%
            const rows = await auditRows('usage_high');
            assert.equal(rows.length, 1);
            assert.equal(rows[0].actor_id, LNK_A);
            assert.equal(rows[0].bot_id, BOT);
            assert.deepEqual(JSON.parse(rows[0].detail), { product_id: PRD_A, link_id: LNK_A });
            for (let i = 9; i <= 10; i++) assert.equal((await to(i)).status, 200);
            assert.equal((await to(11)).status, 402);
            assert.equal((await auditRows('usage_high')).length, 1, '之後的請求不再重複寫');
        });
    });

    it('並行跨過 80% 門檻：仍然只寫一筆', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '10' };
        for (let i = 1; i <= 10; i++) await bind(LNK_A, refOf(i), userOf(i));
        await withPinnedWindow(async () => {
            await Promise.all(Array.from({ length: 10 }, (_, i) => send({ external_contact_ref: refOf(i + 1) }, { e })));
            assert.equal((await auditRows('usage_high')).length, 1);
        });
    });

    it('不同連結各自一筆；隔天（新的日視窗）再寫一筆', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '1' };
        await bind(LNK_B, REF, userOf(5));
        const dayStart = Math.floor(originalNow() / DAY) * DAY;
        await withNow(dayStart + HOUR, async () => {
            await send({}, { e });
            await send({}, { e, key: KEY_B });
        });
        assert.equal((await auditRows('usage_high')).length, 2);
        await withNow(dayStart + DAY + HOUR, async () => { await send({}, { e }); });
        assert.equal((await auditRows('usage_high')).length, 3);
    });
});

describe('隱私：計數鍵、旗標、稽核、回應、log 都不含 ref 與 LINE userId', () => {
    it('走完成功、重送、各種限流之後掃描', async () => {
        const e = { ...env, BRIDGE_LINK_DAILY_CAP: '4' };
        const seen = [];
        await withPinnedWindow(async () => {
            for (const r of [
                await send({}, { e, idem: 'a' }), await send({}, { e, idem: 'a' }), await send({}, { e }), await send({}, { e }),
                await send({}, { e }), await send({}, { e }), await send({ external_contact_ref: 'customer-secret-9' }, { e }),
            ]) seen.push(r.text);
        });
        const secrets = [REF, userOf(0), 'customer-secret-9', LINE_TOKEN];
        const surfaces = {
            counters: JSON.stringify(await all(d1.db, 'SELECT * FROM counters')),
            flags: JSON.stringify(await all(d1.db, 'SELECT * FROM flags')),
            audit: JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log')),
            responses: seen.join('\n'),
            logs: logs.join('\n'),
            kv: [...kv._store.keys()].filter((k) => k.startsWith('rl_')).join('\n'),
        };
        for (const [name, text] of Object.entries(surfaces)) for (const s of secrets) assert.ok(!text.includes(s), `${name} 含 ${s}`);
        const keys = (await all(d1.db, 'SELECT scope_key FROM counters')).map((r) => r.scope_key);
        assert.ok(keys.some((k) => /^send:hour:lnk_[a-z0-9]+:[0-9a-f]{32}$/.test(k)), keys.join(','));
        assert.ok(keys.some((k) => k === `send:min:${LNK_A}`) && keys.some((k) => k === `send:day:${LNK_A}`));
    });
});

describe('缺 0004 遷移（只套用 0001～0003）→ 503 bridge_not_configured，不放行', () => {
    let old;
    before(async () => { old = await createTestD1({ upTo: '0003' }); });
    after(async () => { await old.dispose(); });

    it('發送回 503，LINE 沒有收到任何東西，沒有搶佔冪等鍵', async () => {
        await old.reset();
        await seedLink(old.db, { linkId: LNK_A, productId: PRD_A, botId: BOT, key: KEY_A });
        await old.db.prepare(
            "INSERT INTO contacts (link_id, external_contact_ref, bot_id, line_user_id, status, bound_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'bound', 1, 1)"
        ).bind(LNK_A, REF, BOT, userOf(0)).run();
        const r = await send({}, { e: { ...env, BRIDGE_DB: old.db } });
        assert.equal(r.status, 503);
        assert.equal(code(r), 'INTERNAL');
        assert.equal(r.body.error.message, 'bridge_not_configured');
        assert.equal(line.pushCalls.length, 0);
        assert.equal(await count(old.db, 'idempotency'), 0);
    });
});
