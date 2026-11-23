/**
 * Unit Tests — flow 的條件 / 延遲 / API / 圖片 / Quick Reply / 變數，以及到期工作的 cron 執行
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, FlowJobKeys } from '../../worker_src/lib/kv_schema.js';
import { compileFlow } from '../../worker_src/lib/flow_compiler.js';
import { runTrigger, evaluateConditions } from '../../worker_src/lib/flow_runtime.js';
import { replaceMessageVariables } from '../../worker_src/lib/message_variables.js';
import { formatReplyMessage } from '../../worker_src/lib/line_client.js';
import { tryHandleFlowMessage, runDueFlowJobs } from '../../worker_src/lib/flow_dispatch.js';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source, target, sourceHandle = 'default') => ({ id: `${source}${target}${sourceHandle}`, source, target, sourceHandle });
const compile = (nodes, edges) => compileFlow({ id: 'f1', name: 'T', nodes, edges }, { botId: 'B' });
const errs = (r) => (r.ok ? [] : r.errors.map((e) => e.message));
const kw = node('k', 'keyword', { keyword: 'go' });
const txt = (id, text) => node(id, 'message_text', { text });
const ctx = (o = {}) => ({ text: '', userId: 'U1', tags: [], ...o });

describe('條件判斷', () => {
    const build = () => compile(
        [kw, node('c', 'action_condition', { conditions: [{ field: 'tag', operator: 'equals', value: 'VIP' }] }), txt('y', '貴賓您好'), txt('n', '歡迎')],
        [edge('k', 'c'), edge('c', 'y', 'true'), edge('c', 'n', 'false')],
    );

    it('依標籤走 是 / 否 分支', () => {
        const p = build().published;
        assert.deepEqual(runTrigger(p, p.triggers[0], ctx({ tags: ['VIP'] })).messages.map((m) => m.text), ['貴賓您好']);
        assert.deepEqual(runTrigger(p, p.triggers[0], ctx({ tags: ['新客'] })).messages.map((m) => m.text), ['歡迎']);
    });

    it('evaluateConditions：text / userId / tag、equals / contains、不分大小寫、全部成立才算（AND）', () => {
        const c = (field, operator, value) => ({ field, operator, value });
        assert.equal(evaluateConditions([c('text', 'contains', 'HELLO')], ctx({ text: 'say hello' })), true);
        assert.equal(evaluateConditions([c('text', 'equals', 'hello')], ctx({ text: 'say hello' })), false);
        assert.equal(evaluateConditions([c('tag', 'contains', 'vi')], ctx({ tags: ['VIP'] })), true);
        assert.equal(evaluateConditions([c('userId', 'equals', 'u1')], ctx()), true);
        assert.equal(evaluateConditions([c('text', 'contains', 'a'), c('tag', 'equals', 'x')], ctx({ text: 'a', tags: [] })), false);
    });

    it('壞資料一律當 false：空條件、空值、regex、未知欄位', () => {
        assert.equal(evaluateConditions([], ctx()), false);
        assert.equal(evaluateConditions([{ field: 'text', operator: 'equals', value: '' }], ctx()), false);
        assert.equal(evaluateConditions([{ field: 'text', operator: 'regex', value: '.*' }], ctx({ text: 'x' })), false);
        assert.equal(evaluateConditions([{ field: 'secret', operator: 'equals', value: 'x' }], ctx()), false);
    });

    it('發布檢查：regex、空值、連線沒從 是/否 拉出 → 擋', () => {
        const bad = (conditions, edges) => errs(compile([kw, node('c', 'action_condition', { conditions }), txt('y', 'a')], edges)).join('|');
        assert.match(bad([{ field: 'text', operator: 'regex', value: 'a' }], [edge('k', 'c'), edge('c', 'y', 'true')]), /正則/);
        assert.match(bad([{ field: 'text', operator: 'equals', value: '' }], [edge('k', 'c'), edge('c', 'y', 'true')]), /空的/);
        assert.match(bad([{ field: 'tag', operator: 'equals', value: 'a' }], [edge('k', 'c'), edge('c', 'y')]), /是.*否/);
    });

    it('兩條分支匯流到同一個節點（菱形）不是循環', () => {
        const r = compile(
            [kw, node('c', 'action_condition', { conditions: [{ field: 'tag', operator: 'equals', value: 'a' }] }), txt('y', '1'), txt('n', '2'), txt('end', '結尾')],
            [edge('k', 'c'), edge('c', 'y', 'true'), edge('c', 'n', 'false'), edge('y', 'end'), edge('n', 'end')],
        );
        assert.equal(r.ok, true);
    });
});

describe('延遲', () => {
    it('延遲不往下走，記成 deferred；之後的訊息不在這次回覆裡', () => {
        const p = compile([kw, txt('a', '先回'), node('d', 'action_delay', { seconds: 90 }), txt('b', '稍後')], [edge('k', 'a'), edge('a', 'd'), edge('d', 'b')]).published;
        const r = runTrigger(p, p.triggers[0], ctx());
        assert.deepEqual(r.messages.map((m) => m.text), ['先回']);
        assert.deepEqual(r.deferred, [{ seconds: 90, startIds: ['b'] }]);
    });

    it('發布檢查：秒數要是 1~86400 的整數；發布成功會提醒推播額度', () => {
        const mk = (seconds) => compile([kw, node('d', 'action_delay', { seconds }), txt('b', 'x')], [edge('k', 'd'), edge('d', 'b')]);
        for (const s of [0, -1, 1.5, 'abc', 86401, undefined]) assert.equal(mk(s).ok, false, String(s));
        const ok = mk(60);
        assert.equal(ok.ok, true);
        assert.match(ok.warnings.join(), /推播/);
    });

    it('延遲之後的內容也會檢查（超過 5 則 → 擋）', () => {
        const nodes = [kw, node('d', 'action_delay', { seconds: 5 })];
        const edges = [edge('k', 'd')];
        for (let i = 0; i < 6; i++) { nodes.push(txt(`m${i}`, `${i}`)); edges.push(edge(i ? `m${i - 1}` : 'd', `m${i}`)); }
        assert.match(errs(compile(nodes, edges)).join(), /延遲之後.*超過 5 則/);
    });

    it('只有延遲、沒有立即回覆的流程不算「沒有回覆」', () => {
        const r = compile([kw, node('d', 'action_delay', { seconds: 5 }), txt('b', 'x')], [edge('k', 'd'), edge('d', 'b')]);
        assert.equal(r.warnings.some((w) => /沒有接任何回覆/.test(w)), false);
    });
});

describe('圖片、序列、Quick Reply', () => {
    it('圖片節點 → image 訊息（預覽預設用原圖）；非 https → 擋', () => {
        const p = compile([kw, node('i', 'message_image', { url: 'https://cdn.example.com/a.jpg' })], [edge('k', 'i')]).published;
        assert.deepEqual(runTrigger(p, p.triggers[0], ctx()).messages, [{ type: 'image', originalContentUrl: 'https://cdn.example.com/a.jpg', previewImageUrl: 'https://cdn.example.com/a.jpg' }]);
        assert.match(errs(compile([kw, node('i', 'message_image', { url: 'http://x.com/a.jpg' })], [edge('k', 'i')])).join(), /https/);
        assert.match(errs(compile([kw, node('i', 'message_image', { url: 'https://x.com/a.jpg', previewUrl: 'javascript:1' })], [edge('k', 'i')])).join(), /預覽圖/);
    });

    it('序列可混合文字與圖片', () => {
        const p = compile([kw, node('s', 'message_sequence', { messages: [{ type: 'text', text: 'a' }, { type: 'image', url: 'https://x.com/1.png' }] })], [edge('k', 's')]).published;
        assert.deepEqual(runTrigger(p, p.triggers[0], ctx()).messages.map((m) => m.type), ['text', 'image']);
    });

    it('formatReplyMessage 支援 image，非 https 回 null', async () => {
        assert.equal((await formatReplyMessage({ type: 'image', originalContentUrl: 'https://x.com/a.jpg' })).previewImageUrl, 'https://x.com/a.jpg');
        assert.equal(await formatReplyMessage({ type: 'image', originalContentUrl: 'http://x.com/a.jpg' }), null);
        assert.equal(await formatReplyMessage({ type: 'image', originalContentUrl: 'https://x.com/a.jpg', previewImageUrl: 'ftp://x' }), null);
    });

    it('Quick Reply：最後一個有設定的節點的模板會套在整串回覆的最後一則', () => {
        const p = compile([kw, node('a', 'message_text', { text: 'a', quickReplyId: 'qr1' }), txt('b', 'b')], [edge('k', 'a'), edge('a', 'b')]).published;
        assert.equal(runTrigger(p, p.triggers[0], ctx()).quickReplyId, 'qr1');
    });
});

describe('API 節點（發布檢查與執行結果）', () => {
    const api = (data) => compile([kw, node('a', 'action_api', data), txt('t', '結果 (@api.name)')], [edge('k', 'a'), edge('a', 't')]);

    it('設定不合法 → 擋（含內網網址）', () => {
        assert.match(errs(api({ url: 'https://10.0.0.1/' })).join(), /公開的網域/);
        assert.equal(api({ url: 'https://api.example.com/x', method: 'GET', headers: '{}', body: '{}' }).ok, true);
    });

    it('一次最多呼叫 3 次', () => {
        const nodes = [kw];
        const edges = [];
        for (let i = 0; i < 4; i++) { nodes.push(node(`a${i}`, 'action_api', { url: 'https://api.example.com/x', method: 'GET', headers: '{}', body: '{}' })); edges.push(edge(i ? `a${i - 1}` : 'k', `a${i}`)); }
        assert.match(errs(compile(nodes, edges)).join(), /最多只能呼叫 3 次/);
    });

    it('執行時只收集待呼叫的 API，不在這裡發請求；發布會提醒標頭可見', () => {
        const r = api({ url: 'https://api.example.com/x', method: 'GET', headers: '{}', body: '{}' });
        const out = runTrigger(r.published, r.published.triggers[0], ctx());
        assert.equal(out.apiCalls.length, 1);
        assert.match(r.warnings.join(), /團隊成員看得到/);
    });
});

describe('變數替換', () => {
    it('(@name) 等內建變數與 (@api.xxx)；值含 $& 不會被當成特殊替換字串', () => {
        const msgs = [{ type: 'text', text: '嗨 (@name)，(@api.city) 天氣 (@api.temp)' }, { type: 'flex', altText: '(@NAME)', contents: {} }];
        replaceMessageVariables(msgs, { userName: '$&小明', tierInfo: {}, extra: { 'api.city': '台北', 'api.temp': '25' } });
        assert.equal(msgs[0].text, '嗨 $&小明，台北 天氣 25');
        assert.equal(msgs[1].altText, '$&小明');
    });

    it('API 失敗（沒有值）的 (@api.xxx) 變成空字串，不把變數原樣送給使用者', () => {
        const msgs = [{ type: 'text', text: '溫度：(@api.temp)°C' }];
        replaceMessageVariables(msgs, { userName: 'x', extra: {} });
        assert.equal(msgs[0].text, '溫度：°C');
    });

    it('API 回傳過長的值會被截斷', () => {
        const msgs = [{ type: 'text', text: '(@api.x)' }];
        replaceMessageVariables(msgs, { extra: { 'api.x': 'a'.repeat(2000) } });
        assert.equal(msgs[0].text.length, 500);
    });
});

// ── 端到端：延遲排程 → cron 執行；API → 變數 ──────────────────────────────

const BOT = 'Ubot00000000000000000000000000a';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';

function jsonKV() {
    const base = createMockKV();
    return { ...base, async get(k, o) { const raw = await base.get(k); return raw !== null && o && o.type === 'json' ? JSON.parse(raw) : raw; } };
}

describe('延遲 + API 端到端', () => {
    let env, calls, realFetch, store;
    beforeEach(() => {
        env = { KV_LINE_STORAGE: jsonKV() };
        calls = [];
        realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null, headers: init && init.headers });
            if (u.includes('api.example.com')) return new Response(JSON.stringify({ city: '台北', temp: 25 }), { status: 200, headers: { 'content-type': 'application/json' } });
            return new Response('{}', { status: 200 });
        };
        const members = new Map([[MEMBER, { tags: [] }]]);
        const other = new Map();
        store = {
            getOr: async (k, d, id) => (k === 'member' ? members.get(id) : other.get(k)) ?? d,
            put: async (k, v, id) => { if (k === 'member') members.set(id, v); else other.set(k, v); },
        };
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    const publish = async (nodes, edges) => {
        const r = compile(nodes, edges);
        assert.ok(r.ok, JSON.stringify(r.errors));
        await env.KV_LINE_STORAGE.put(BotKeys.flowPublished(BOT), JSON.stringify(r.published));
    };
    const msgEvent = (text) => ({ replyToken: 'rt', source: { userId: MEMBER }, message: { type: 'text', text } });
    const c = (event) => ({ event, env, userId: OWNER, accessToken: 'tok', store, botId: BOT });
    const lineCalls = (suffix) => calls.filter((x) => x.url.endsWith(suffix));

    it('API 結果代入回覆文字', async () => {
        await publish(
            [kw, node('a', 'action_api', { url: 'https://api.example.com/w', method: 'GET', headers: '{}', body: '{}' }), txt('t', '(@api.city) 現在 (@api.temp) 度')],
            [edge('k', 'a'), edge('a', 't')],
        );
        assert.equal(await tryHandleFlowMessage(c(msgEvent('go'))), true);
        assert.equal(lineCalls('/message/reply')[0].body.messages[0].text, '台北 現在 25 度');
    });

    it('API 失敗時回覆照送，變數變空字串', async () => {
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
            return String(url).includes('api.example.com') ? new Response('x', { status: 500 }) : new Response('{}', { status: 200 });
        };
        await publish(
            [kw, node('a', 'action_api', { url: 'https://api.example.com/w', method: 'GET', headers: '{}', body: '{}' }), txt('t', '溫度 (@api.temp)')],
            [edge('k', 'a'), edge('a', 't')],
        );
        assert.equal(await tryHandleFlowMessage(c(msgEvent('go'))), true);
        assert.equal(lineCalls('/message/reply')[0].body.messages[0].text, '溫度 ');
    });

    const delayed = () => publish(
        [kw, txt('a', '先回'), node('d', 'action_delay', { seconds: 120 }), txt('b', '兩分鐘後')],
        [edge('k', 'a'), edge('a', 'd'), edge('d', 'b')],
    );

    it('延遲：立刻用 reply 回第一段，之後的排進 KV（時間到才執行）', async () => {
        await delayed();
        await tryHandleFlowMessage(c(msgEvent('go')));
        assert.equal(lineCalls('/message/reply')[0].body.messages[0].text, '先回');
        const jobs = await env.KV_LINE_STORAGE.list({ prefix: FlowJobKeys.prefix });
        assert.equal(jobs.keys.length, 1);
        assert.ok(FlowJobKeys.parseRunAt(jobs.keys[0].name) > Date.now() + 100 * 1000);

        // 還沒到時間：cron 不執行
        assert.deepEqual(await runDueFlowJobs(env, Date.now()), { processed: 0, skipped: 0 });
        assert.equal(lineCalls('/message/push').length, 0);
    });

    it('延遲：到期後 cron 用 push 送出，工作被刪除', async () => {
        await delayed();
        await env.KV_LINE_STORAGE.put(`destination_user_${BOT}`, OWNER);
        await tryHandleFlowMessage(c(msgEvent('go')));
        // token_store 反查 access token 需要的資料
        await env.KV_LINE_STORAGE.put(`access_tokens_${OWNER}`, JSON.stringify({ P: { token: 'tok', destination: BOT } }));

        const stats = await runDueFlowJobs(env, Date.now() + 3 * 60 * 1000);
        assert.deepEqual(stats, { processed: 1, skipped: 0 });
        const push = lineCalls('/message/push')[0];
        assert.equal(push.body.to, MEMBER);
        assert.equal(push.body.messages[0].text, '兩分鐘後');
        assert.equal((await env.KV_LINE_STORAGE.list({ prefix: FlowJobKeys.prefix })).keys.length, 0);
    });

    it('等待期間同一個使用者重複觸發 → 不重複排程（保護推播額度）', async () => {
        await delayed();
        await tryHandleFlowMessage(c(msgEvent('go')));
        await tryHandleFlowMessage(c(msgEvent('go')));
        await tryHandleFlowMessage(c(msgEvent('go')));
        assert.equal((await env.KV_LINE_STORAGE.list({ prefix: FlowJobKeys.prefix })).keys.length, 1);
    });

    it('流程取消發布 / 換成別份後，舊的延遲工作不再執行', async () => {
        await delayed();
        await tryHandleFlowMessage(c(msgEvent('go')));
        await env.KV_LINE_STORAGE.delete(BotKeys.flowPublished(BOT));
        const stats = await runDueFlowJobs(env, Date.now() + 3 * 60 * 1000);
        assert.deepEqual(stats, { processed: 0, skipped: 1 });
        assert.equal(lineCalls('/message/push').length, 0);
    });

    it('壞掉的工作資料被跳過並清除，不會卡住後面的工作', async () => {
        await env.KV_LINE_STORAGE.put(FlowJobKeys.key(1000, 'bad'), '{壞掉');
        const stats = await runDueFlowJobs(env, Date.now());
        assert.deepEqual(stats, { processed: 0, skipped: 1 });
        assert.equal((await env.KV_LINE_STORAGE.list({ prefix: FlowJobKeys.prefix })).keys.length, 0);
    });
});

describe('FlowJobKeys', () => {
    it('key 依時間排序，parseRunAt 還原時間；不合法名稱回 null', () => {
        const a = FlowJobKeys.key(5000, 'x');
        const b = FlowJobKeys.key(60000, 'x');
        assert.ok(a < b);
        assert.equal(FlowJobKeys.parseRunAt(b), 60000);
        assert.equal(FlowJobKeys.parseRunAt('other:1'), null);
    });
});
