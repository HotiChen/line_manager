/**
 * Unit Tests — flow_dispatch.js（已發布 flow 接進 webhook）
 * LINE reply API 以 globalThis.fetch 攔截。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { compileFlow } from '../../worker_src/lib/flow_compiler.js';
import { buttonPostbackData } from '../../worker_src/lib/flow_runtime.js';
import { loadPublishedFlow, tryHandleFlowMessage, tryHandleFlowPostback } from '../../worker_src/lib/flow_dispatch.js';

const BOT = 'Ubot00000000000000000000000000a';
const USER = 'Uowner0000000000000000000000001';
const MEMBER = 'Umember000000000000000000000002';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source, target, sourceHandle = 'default') => ({ id: `${source}${target}${sourceHandle}`, source, target, sourceHandle });
const flexContents = { type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'message', label: 'A', text: 'a' } }] } };

function jsonKV() {
    const base = createMockKV();
    return { ...base, async get(k, o) { const raw = await base.get(k); return raw !== null && o && o.type === 'json' ? JSON.parse(raw) : raw; } };
}

let env, replies, realFetch, store;
beforeEach(async () => {
    env = { KV_LINE_STORAGE: jsonKV() };
    replies = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { replies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
    const members = new Map();
    const other = new Map();
    // 只有 'member' 資源是會員資料；其他（例如訊息計數）另外存
    store = {
        getOr: async (k, d, id) => (k === 'member' ? members.get(id) : other.get(k)) ?? d,
        put: async (k, v, id) => { if (k === 'member') members.set(id, v); else other.set(k, v); },
        members,
    };

    const r = compileFlow({
        id: 'f1', name: '客服',
        nodes: [node('k', 'keyword', { keyword: '選單' }), node('f', 'message_flex', { contents: flexContents }), node('a', 'message_text', { text: '回覆A' }), node('g', 'action_tag', { operation: 'add', tags: ['VIP'] })],
        edges: [edge('k', 'f'), edge('f', 'a', 'button_0'), edge('a', 'g')],
    }, { botId: BOT });
    assert.ok(r.ok);
    await env.KV_LINE_STORAGE.put(BotKeys.flowPublished(BOT), JSON.stringify(r.published));
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (event) => ({ event, env, userId: USER, accessToken: 'tok', store, botId: BOT });
const textEvent = (text) => ({ replyToken: 'rt', source: { userId: MEMBER }, message: { type: 'text', text } });
const postbackEvent = (data) => ({ replyToken: 'rt', source: { userId: MEMBER }, postback: { data } });

describe('tryHandleFlowMessage', () => {
    it('命中關鍵字 → 回覆 flow 的訊息並回傳 true', async () => {
        assert.equal(await tryHandleFlowMessage(ctx(textEvent('選單'))), true);
        assert.equal(replies.length, 1);
        assert.equal(replies[0].messages[0].type, 'flex');
        assert.equal(replies[0].messages[0].contents.footer.contents[0].action.type, 'postback');
    });

    it('沒命中 / 沒有發布 / 資料壞掉 → false，不回覆（交回原本的關鍵字回覆）', async () => {
        assert.equal(await tryHandleFlowMessage(ctx(textEvent('不相干'))), false);
        await env.KV_LINE_STORAGE.put(BotKeys.flowPublished(BOT), '{壞掉');
        assert.equal(await tryHandleFlowMessage(ctx(textEvent('選單'))), false);
        await env.KV_LINE_STORAGE.delete(BotKeys.flowPublished(BOT));
        assert.equal(await tryHandleFlowMessage(ctx(textEvent('選單'))), false);
        assert.equal(replies.length, 0);
    });

    it('別的 bot 看不到這份已發布的 flow', async () => {
        assert.equal(await loadPublishedFlow(env, 'Uother000000000000000000000000b'), null);
    });
});

describe('tryHandleFlowPostback', () => {
    it('flow 按鈕 → 回覆下一個節點，並套用標籤', async () => {
        store.members.set(MEMBER, { tags: ['新客'] });
        assert.equal(await tryHandleFlowPostback(ctx(postbackEvent(buttonPostbackData('f1', 'f', 'button_0')))), true);
        assert.deepEqual(replies[0].messages, [{ type: 'text', text: '回覆A' }]);
        assert.deepEqual(store.members.get(MEMBER).tags.sort(), ['VIP', '新客']);
    });

    it('會員資料不存在時標籤略過，回覆照送', async () => {
        await tryHandleFlowPostback(ctx(postbackEvent(buttonPostbackData('f1', 'f', 'button_0'))));
        assert.equal(replies.length, 1);
        assert.equal(store.members.size, 0);
    });

    it('不是 flow 的 postback → false（原本的處理照跑）', async () => {
        assert.equal(await tryHandleFlowPostback(ctx(postbackEvent('tag=VIP'))), false);
    });

    it('flow 按鈕但已取消發布 / 連線不存在 → true 且不回覆（不能回「已收到 flow:…」）', async () => {
        assert.equal(await tryHandleFlowPostback(ctx(postbackEvent(buttonPostbackData('f1', 'f', 'button_9')))), true);
        await env.KV_LINE_STORAGE.delete(BotKeys.flowPublished(BOT));
        assert.equal(await tryHandleFlowPostback(ctx(postbackEvent(buttonPostbackData('f1', 'f', 'button_0')))), true);
        assert.equal(replies.length, 0);
    });
});
