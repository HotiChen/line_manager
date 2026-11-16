/**
 * Unit Tests — bridge/messages.js（橋接 API 的推播）
 *
 *   POST /bridge/v1/raw/push        { to, messages[] }
 *   POST /bridge/v1/raw/multicast   { to[], messages[] }   ≤ 500
 *
 * 不變量：
 *   - messages[] 原樣轉送。平台層不產生內容、不替換變數
 *   - 推不出去的情況都不是 500（409 target_inactive / 402 quota_exhausted / 404）
 *   - 重複推播比漏推更傷：X-Idempotency-Key 命中時不再打 LINE
 *   - 回應不含 token、不含 stack
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import { BotKeys, ServiceKeyKeys } from '../../worker_src/lib/kv_schema.js';
import { route } from '../../worker_src/bridge/messages.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OWNER = 'Uowner0000000000000000000000001';
const SYSTEM = 'imgpicker';
const KEY = 'sk_test_key_value_000000000000000000000000';
const LINE_TOKEN = 'LINE_SECRET_TOKEN_VALUE';
const MEMBER = 'Umember000000000000000000000002';
const GROUP = 'Cgroup00000000000000000000000003';

const originalFetch = globalThis.fetch;
let env;
let line;

/** LINE 那一側的假伺服器。每個測試可改 line.push / line.multicast / line.usage。 */
function installLine() {
    line = {
        usage: 50,
        limit: 200,
        pushCalls: [],
        multicastCalls: [],
        push: () => new Response('{}', { status: 200 }),
        multicast: () => new Response('{}', { status: 200 }),
    };
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/v2/bot/message/quota/consumption')) {
            return new Response(JSON.stringify({ totalUsage: line.usage }), { status: 200 });
        }
        if (u.endsWith('/v2/bot/message/quota')) {
            return new Response(JSON.stringify({ type: 'limited', value: line.limit }), { status: 200 });
        }
        if (u.endsWith('/v2/bot/message/push')) {
            line.pushCalls.push({ init, body: JSON.parse(init.body) });
            return line.push(line.pushCalls.length);
        }
        if (u.endsWith('/v2/bot/message/multicast')) {
            line.multicastCalls.push({ init, body: JSON.parse(init.body) });
            return line.multicast(line.multicastCalls.length);
        }
        return new Response('{}', { status: 404 });
    };
}

async function seed({ scopes = ['messages:push'], rateLimit, withToken = true, withMember = true } = {}) {
    const kv = env.KV_LINE_STORAGE;
    const hash = await sha256Hex(KEY);
    await kv.put(ServiceKeyKeys.byHash(hash), JSON.stringify({ botId: BOT, system: SYSTEM, scopes, createdAt: 1, revokedAt: null }));
    await kv.put(BotKeys.system(BOT, SYSTEM), JSON.stringify({ system: SYSTEM, name: 'IP', disabled: false, rateLimit }));
    await kv.put(BotKeys.owner(BOT), OWNER);
    if (withToken) {
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: LINE_TOKEN, destination: BOT } }));
    }
    if (withMember) {
        await kv.put(BotKeys.member(BOT, MEMBER), JSON.stringify({ userId: MEMBER, name: 'Amy' }));
    }
}

function post(path, body, { key = KEY, botId = BOT, idem, raw } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (botId) headers['X-Bot-Id'] = botId;
    if (idem !== undefined) headers['X-Idempotency-Key'] = idem;
    return new Request(`https://worker.example.com${path}`, {
        method: 'POST',
        headers,
        body: raw !== undefined ? raw : JSON.stringify(body),
    });
}

const push = (body, opts) => route(post('/bridge/v1/raw/push', body, opts), env, '/bridge/v1/raw/push');
const multicast = (body, opts) => route(post('/bridge/v1/raw/multicast', body, opts), env, '/bridge/v1/raw/multicast');
const TEXT = [{ type: 'text', text: 'hello' }];

beforeEach(async () => {
    env = { KV_LINE_STORAGE: createMockKV() };
    installLine();
    await seed();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('push — 成功路徑', () => {
    it('200，回報 quotaConsumed 與 LINE 對帳後的 remaining', async () => {
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.quotaConsumed, 1);
        assert.equal(body.remaining, 149); // 200 - 50 - 1
    });

    it('用該 bot 的 token 打 LINE，to 與 messages 原樣轉送', async () => {
        await push({ to: MEMBER, messages: TEXT });
        assert.equal(line.pushCalls.length, 1);
        assert.equal(line.pushCalls[0].init.headers.Authorization, `Bearer ${LINE_TOKEN}`);
        assert.deepEqual(line.pushCalls[0].body, { to: MEMBER, messages: TEXT });
    });

    it('不做變數替換：(@name) 原樣送出', async () => {
        const msgs = [{ type: 'text', text: 'Hi (@name), today (@date)' }];
        await push({ to: MEMBER, messages: msgs });
        assert.equal(line.pushCalls[0].body.messages[0].text, 'Hi (@name), today (@date)');
    });

    it('多則訊息：成本 = 則數', async () => {
        const msgs = [TEXT[0], TEXT[0], TEXT[0]];
        const body = await (await push({ to: MEMBER, messages: msgs })).json();
        assert.equal(body.quotaConsumed, 3);
        assert.equal(body.remaining, 147);
    });

    it('群組 / 聊天室 id 不查會員表，直接推', async () => {
        const res = await push({ to: GROUP, messages: TEXT });
        assert.equal(res.status, 200);
        assert.equal(line.pushCalls.length, 1);
    });

    it('送出後快取的剩餘會扣掉', async () => {
        await push({ to: MEMBER, messages: TEXT });
        const second = await (await push({ to: MEMBER, messages: TEXT })).json();
        assert.equal(second.remaining, 148);
    });

    it('回應與 KV 不含 LINE token', async () => {
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.ok(!(await res.text()).includes(LINE_TOKEN));
    });
});

describe('push — 認證與輸入', () => {
    it('沒有 key → 401，沒打 LINE', async () => {
        const res = await push({ to: MEMBER, messages: TEXT }, { key: null });
        assert.equal(res.status, 401);
        assert.equal(line.pushCalls.length, 0);
    });

    it('scope 不足 → 403', async () => {
        env.KV_LINE_STORAGE._store.clear();
        await seed({ scopes: ['members:read'] });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 403);
        assert.equal(line.pushCalls.length, 0);
    });

    it('自報別人的 bot → 403', async () => {
        const res = await push({ to: MEMBER, messages: TEXT }, { botId: 'Uother0000000000000000000000009' });
        assert.equal(res.status, 403);
        assert.equal(line.pushCalls.length, 0);
    });

    for (const [name, body] of [
        ['缺 to', { messages: TEXT }],
        ['to 不是字串', { to: 123, messages: TEXT }],
        ['to 是空字串', { to: '', messages: TEXT }],
        ['缺 messages', { to: MEMBER }],
        ['messages 不是陣列', { to: MEMBER, messages: 'hi' }],
        ['messages 是空陣列', { to: MEMBER, messages: [] }],
        ['messages 超過 5 則', { to: MEMBER, messages: Array(6).fill(TEXT[0]) }],
        ['message 缺 type', { to: MEMBER, messages: [{ text: 'x' }] }],
        ['message 不是物件', { to: MEMBER, messages: ['x'] }],
    ]) {
        it(`400：${name}`, async () => {
            const res = await push(body);
            assert.equal(res.status, 400);
            assert.equal(line.pushCalls.length, 0);
        });
    }

    it('body 不是合法 JSON → 400，不是 500', async () => {
        const res = await push(undefined, { raw: '{nope' });
        assert.equal(res.status, 400);
    });

    it('從未見過的會員 → 404 target_not_found，沒打 LINE', async () => {
        const res = await push({ to: 'Ustranger000000000000000000000009', messages: TEXT });
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error, 'target_not_found');
        assert.equal(line.pushCalls.length, 0);
    });

    it('bot 沒有 LINE token → 503，不是 500', async () => {
        env.KV_LINE_STORAGE._store.clear();
        await seed({ withToken: false });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 503);
    });

    it('只收 POST', async () => {
        const req = new Request('https://worker.example.com/bridge/v1/raw/push', {
            method: 'GET', headers: { Authorization: `Bearer ${KEY}`, 'X-Bot-Id': BOT },
        });
        const res = await route(req, env, '/bridge/v1/raw/push');
        assert.equal(res.status, 405);
    });

    it('未知路徑 → 404', async () => {
        const res = await route(post('/bridge/v1/raw/nope', {}), env, '/bridge/v1/raw/nope');
        assert.equal(res.status, 404);
    });
});

describe('push — 推不出去（都不是 500）', () => {
    it('LINE 403（封鎖）→ 409 target_inactive reason=blocked，並標記 member inactiveAt', async () => {
        line.push = () => new Response('{"message":"forbidden"}', { status: 403 });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.error, 'target_inactive');
        assert.equal(body.reason, 'blocked');
        const member = JSON.parse(await env.KV_LINE_STORAGE.get(BotKeys.member(BOT, MEMBER)));
        assert.equal(typeof member.inactiveAt, 'number');
        assert.equal(member.name, 'Amy'); // 其他欄位不被洗掉
    });

    it('LINE 403 對群組 → reason=bot_left', async () => {
        line.push = () => new Response('{}', { status: 403 });
        const res = await push({ to: GROUP, messages: TEXT });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).reason, 'bot_left');
    });

    it('額度用盡（對帳顯示剩 0）→ 402 quota_exhausted，附 remaining，不打 push', async () => {
        line.usage = 200;
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 402);
        const body = await res.json();
        assert.equal(body.error, 'quota_exhausted');
        assert.equal(body.remaining, 0);
        assert.equal(line.pushCalls.length, 0);
    });

    it('成本大於剩餘 → 402，附剩餘（讓呼叫端決定降級）', async () => {
        line.usage = 198; // 剩 2
        const res = await push({ to: MEMBER, messages: Array(3).fill(TEXT[0]) });
        assert.equal(res.status, 402);
        assert.equal((await res.json()).remaining, 2);
        assert.equal(line.pushCalls.length, 0);
    });

    it('LINE 說月額度用完（429）→ 402，快取寫 0，60 秒內不再打 LINE', async () => {
        line.push = () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 });
        const first = await push({ to: MEMBER, messages: TEXT });
        assert.equal(first.status, 402);
        assert.equal((await first.json()).remaining, 0);

        const second = await push({ to: MEMBER, messages: TEXT });
        assert.equal(second.status, 402);
        assert.equal(line.pushCalls.length, 1);
    });

    it('LINE 一般 429 → 429 並轉達 Retry-After', async () => {
        line.push = () => new Response('{"message":"slow down"}', { status: 429, headers: { 'Retry-After': '5' } });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('Retry-After'), '5');
    });

    it('LINE 5xx → 502 line_unavailable、retryable，body 沒有 stack', async () => {
        line.push = () => new Response('<html>bad gateway</html>', { status: 502 });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 502);
        const text = await res.text();
        const body = JSON.parse(text);
        assert.equal(body.error, 'line_unavailable');
        assert.equal(body.retryable, true);
        assert.ok(!/stack|at \w+ \(/.test(text));
    });

    it('LINE 400（請求內容有問題）→ 400，轉達 LINE 的說明', async () => {
        line.push = () => new Response('{"message":"The request body has 1 error(s)"}', { status: 400 });
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'invalid_request');
    });

    it('LINE 409（retry key 先前已被接受）→ 視為成功，不要讓客人收到兩則', async () => {
        line.push = () => new Response('{}', { status: 409, headers: { 'X-Line-Accepted-Request-Id': 'req-1' } });
        const res = await push({ to: MEMBER, messages: TEXT }, { idem: 'k-409' });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).success, true);
    });

    it('對帳失敗（LINE quota API 掛了）→ 仍然放行，推播照送', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/quota')) return new Response('{}', { status: 500 });
            return realFetch(url, init);
        };
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).remaining, null);
    });
});

describe('push — 冪等（X-Idempotency-Key）', () => {
    it('同一把 key 第二次：不打 LINE，回上次的回應，帶 X-Idempotency-Replayed', async () => {
        const first = await push({ to: MEMBER, messages: TEXT }, { idem: 'deliver:project_8821:v2' });
        const firstBody = await first.json();
        const second = await push({ to: MEMBER, messages: TEXT }, { idem: 'deliver:project_8821:v2' });
        assert.equal(second.status, 200);
        assert.equal(second.headers.get('X-Idempotency-Replayed'), 'true');
        assert.deepEqual(await second.json(), firstBody);
        assert.equal(line.pushCalls.length, 1);
    });

    it('第一次的回應不帶 Replayed，也不帶 Missing', async () => {
        const res = await push({ to: MEMBER, messages: TEXT }, { idem: 'k1' });
        assert.equal(res.headers.get('X-Idempotency-Replayed'), null);
        assert.equal(res.headers.get('X-Idempotency-Missing'), null);
    });

    it('沒帶 key → 回應帶 X-Idempotency-Missing: true，兩次都會打 LINE', async () => {
        const a = await push({ to: MEMBER, messages: TEXT });
        const b = await push({ to: MEMBER, messages: TEXT });
        assert.equal(a.headers.get('X-Idempotency-Missing'), 'true');
        assert.equal(b.headers.get('X-Idempotency-Missing'), 'true');
        assert.equal(line.pushCalls.length, 2);
    });

    it('不同的 key 互不影響', async () => {
        await push({ to: MEMBER, messages: TEXT }, { idem: 'a' });
        await push({ to: MEMBER, messages: TEXT }, { idem: 'b' });
        assert.equal(line.pushCalls.length, 2);
    });

    it('同一把 key 但內容不同 → 422，不打 LINE（key 被拿去做別件事）', async () => {
        await push({ to: MEMBER, messages: TEXT }, { idem: 'same' });
        const res = await push({ to: MEMBER, messages: [{ type: 'text', text: 'different' }] }, { idem: 'same' });
        assert.equal(res.status, 422);
        assert.equal((await res.json()).error, 'idempotency_key_reuse');
        assert.equal(line.pushCalls.length, 1);
    });

    it('上一次還在處理中 → 409 in_progress，不打 LINE', async () => {
        // 讓第一個請求卡在 LINE，第二個請求進來
        let release;
        const gate = new Promise((r) => { release = r; });
        line.push = async () => { await gate; return new Response('{}', { status: 200 }); };
        const firstP = push({ to: MEMBER, messages: TEXT }, { idem: 'slow' });
        await new Promise((r) => setTimeout(r, 20));
        const second = await push({ to: MEMBER, messages: TEXT }, { idem: 'slow' });
        assert.equal(second.status, 409);
        assert.equal((await second.json()).error, 'in_progress');
        release();
        assert.equal((await firstP).status, 200);
        assert.equal(line.pushCalls.length, 1);
    });

    it('暫時性失敗（LINE 5xx）不會被快取：同一把 key 重試會真的再送', async () => {
        line.push = (n) => (n === 1 ? new Response('{}', { status: 500 }) : new Response('{}', { status: 200 }));
        const first = await push({ to: MEMBER, messages: TEXT }, { idem: 'retry-me' });
        assert.equal(first.status, 502);
        const second = await push({ to: MEMBER, messages: TEXT }, { idem: 'retry-me' });
        assert.equal(second.status, 200);
        assert.equal(line.pushCalls.length, 2);
    });

    it('額度不足（402）不被快取：補額度後同一把 key 可以重試', async () => {
        line.usage = 200;
        const first = await push({ to: MEMBER, messages: TEXT }, { idem: 'q' });
        assert.equal(first.status, 402);
        line.usage = 0;
        // 讓快取過期（低於 20% 的對帳間隔是 60 秒）
        env.KV_LINE_STORAGE._advanceTime(61 * 1000);
        const realNow = Date.now;
        Date.now = () => realNow() + 61 * 1000;
        try {
            const second = await push({ to: MEMBER, messages: TEXT }, { idem: 'q' });
            assert.equal(second.status, 200);
        } finally {
            Date.now = realNow;
        }
    });

    it('決定性的結果（封鎖 409）會被快取：重試不會再打 LINE', async () => {
        line.push = () => new Response('{}', { status: 403 });
        const first = await push({ to: MEMBER, messages: TEXT }, { idem: 'blocked' });
        assert.equal(first.status, 409);
        const second = await push({ to: MEMBER, messages: TEXT }, { idem: 'blocked' });
        assert.equal(second.status, 409);
        assert.equal(second.headers.get('X-Idempotency-Replayed'), 'true');
        assert.equal(line.pushCalls.length, 1);
    });

    it('key 超過 128 字元 → 400', async () => {
        const res = await push({ to: MEMBER, messages: TEXT }, { idem: 'x'.repeat(129) });
        assert.equal(res.status, 400);
        assert.equal(line.pushCalls.length, 0);
    });

    it('128 字元剛好可以', async () => {
        const res = await push({ to: MEMBER, messages: TEXT }, { idem: 'x'.repeat(128) });
        assert.equal(res.status, 200);
    });

    it('同時傳 X-Line-Retry-Key（UUID），同一把 key 每次都一樣', async () => {
        await push({ to: MEMBER, messages: TEXT }, { idem: 'stable' });
        // 清掉快取的 done 紀錄，強迫第二次真的送出，檢查 retry key 的穩定性
        for (const k of [...env.KV_LINE_STORAGE._store.keys()]) {
            if (k.includes(':idem:')) env.KV_LINE_STORAGE._store.delete(k);
        }
        await push({ to: MEMBER, messages: TEXT }, { idem: 'stable' });
        const [a, b] = line.pushCalls.map((c) => c.init.headers['X-Line-Retry-Key']);
        assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(a, b);
    });

    it('沒帶 idempotency key 時不送 X-Line-Retry-Key', async () => {
        await push({ to: MEMBER, messages: TEXT });
        assert.equal(line.pushCalls[0].init.headers['X-Line-Retry-Key'], undefined);
    });

    it('不同 bot 的同名 system 用同一把 key，retry key 不相同', async () => {
        await push({ to: MEMBER, messages: TEXT }, { idem: 'shared' });
        const a = line.pushCalls[0].init.headers['X-Line-Retry-Key'];

        const OTHER = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        const kv = env.KV_LINE_STORAGE;
        const k2 = 'sk_second_key_value_0000000000000000000000';
        await kv.put(ServiceKeyKeys.byHash(await sha256Hex(k2)), JSON.stringify({ botId: OTHER, system: SYSTEM, scopes: ['messages:push'], createdAt: 1, revokedAt: null }));
        await kv.put(BotKeys.system(OTHER, SYSTEM), JSON.stringify({ system: SYSTEM, name: 'IP', disabled: false }));
        await kv.put(BotKeys.owner(OTHER), OWNER);
        await kv.put(`access_tokens_${OWNER}`, JSON.stringify({
            main: { token: LINE_TOKEN, destination: BOT },
            second: { token: 'TOKEN_2', destination: OTHER },
        }));
        await kv.put(BotKeys.member(OTHER, MEMBER), JSON.stringify({ userId: MEMBER }));
        await push({ to: MEMBER, messages: TEXT }, { idem: 'shared', key: k2, botId: OTHER });
        const b = line.pushCalls[1].init.headers['X-Line-Retry-Key'];
        assert.notEqual(a, b);
        assert.equal(line.pushCalls.length, 2);
    });
});

describe('push — 限流與成本', () => {
    it('超過系統的寫入上限 → 429 + Retry-After，不打 LINE', async () => {
        env.KV_LINE_STORAGE._store.clear();
        await seed({ rateLimit: { write: 1 } });
        assert.equal((await push({ to: MEMBER, messages: TEXT })).status, 200);
        const res = await push({ to: MEMBER, messages: TEXT });
        assert.equal(res.status, 429);
        assert.ok(Number(res.headers.get('Retry-After')) >= 1);
        assert.equal(line.pushCalls.length, 1);
    });

    it('一次 push 的 KV 操作遠低於 Workers 每請求 1000 次的上限', async () => {
        env.KV_LINE_STORAGE._resetOps();
        await push({ to: MEMBER, messages: TEXT }, { idem: 'ops' });
        assert.ok(env.KV_LINE_STORAGE._ops.total < 40, `ops=${env.KV_LINE_STORAGE._ops.total}`);
    });
});

describe('multicast', () => {
    const TO = ['U1', 'U2', 'U3'];

    it('200，成本 = 收件人數 × 則數', async () => {
        const res = await multicast({ to: TO, messages: [TEXT[0], TEXT[0]] });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.quotaConsumed, 6);
        assert.equal(body.remaining, 144);
        assert.deepEqual(line.multicastCalls[0].body.to, TO);
    });

    it('名單去重，成本按實際人數', async () => {
        const body = await (await multicast({ to: ['U1', 'U1', 'U2'], messages: TEXT })).json();
        assert.equal(body.quotaConsumed, 2);
        assert.deepEqual(line.multicastCalls[0].body.to, ['U1', 'U2']);
    });

    it('500 人可以，501 人 → 400', async () => {
        const mk = (n) => Array.from({ length: n }, (_, i) => `U${i}`);
        line.limit = 100000;
        assert.equal((await multicast({ to: mk(500), messages: TEXT })).status, 200);
        assert.equal((await multicast({ to: mk(501), messages: TEXT })).status, 400);
    });

    for (const [name, body] of [
        ['to 是空陣列', { to: [], messages: TEXT }],
        ['to 不是陣列', { to: 'U1', messages: TEXT }],
        ['to 含非字串', { to: ['U1', 2], messages: TEXT }],
        ['缺 messages', { to: TO }],
    ]) {
        it(`400：${name}`, async () => {
            assert.equal((await multicast(body)).status, 400);
            assert.equal(line.multicastCalls.length, 0);
        });
    }

    it('額度不夠整批 → 402，整批都不送', async () => {
        line.usage = 198; // 剩 2，這批要 3
        const res = await multicast({ to: TO, messages: TEXT });
        assert.equal(res.status, 402);
        assert.equal((await res.json()).remaining, 2);
        assert.equal(line.multicastCalls.length, 0);
    });

    it('冪等：同一把 key 第二次不再送', async () => {
        await multicast({ to: TO, messages: TEXT }, { idem: 'mc-1' });
        const second = await multicast({ to: TO, messages: TEXT }, { idem: 'mc-1' });
        assert.equal(second.headers.get('X-Idempotency-Replayed'), 'true');
        assert.equal(line.multicastCalls.length, 1);
    });

    it('同一把 key 拿去做 push 又做 multicast → 視為誤用', async () => {
        await push({ to: MEMBER, messages: TEXT }, { idem: 'same-key' });
        const res = await multicast({ to: TO, messages: TEXT }, { idem: 'same-key' });
        assert.equal(res.status, 422); // 同一把 key 對應到不同請求，視為誤用
        assert.equal(line.multicastCalls.length, 0);
    });

    it('LINE 5xx → 502', async () => {
        line.multicast = () => new Response('{}', { status: 503 });
        assert.equal((await multicast({ to: TO, messages: TEXT })).status, 502);
    });

    it('沒有 key → 401', async () => {
        assert.equal((await multicast({ to: TO, messages: TEXT }, { key: null })).status, 401);
    });
});
