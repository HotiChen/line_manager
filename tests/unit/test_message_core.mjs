/**
 * Unit Tests — js/shared/message_core.js（訊息類型的共用核心）與 message_pipeline.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import {
    MESSAGE_TYPES, LINE_MAX_MESSAGES, isHttpsUrl, validateMessage, toLineMessage,
    normalizeImagemapActions, pickQuickReplyId, usesVariables, IMAGEMAP_REDIRECT_BASE,
} from '../../js/shared/message_core.js';
import { formatReplyMessage } from '../../worker_src/lib/line_client.js';
import { formatReplies, attachQuickReply, finalizeMessages, sendMessages } from '../../worker_src/lib/message_pipeline.js';

describe('isHttpsUrl', () => {
    it('只有 https 通過', () => {
        assert.equal(isHttpsUrl('https://a.com/x.jpg'), true);
        assert.equal(isHttpsUrl('HTTPS://a.com'), true);
        for (const bad of ['http://a.com', 'ftp://a.com', 'javascript:alert(1)', '//a.com', '', null, undefined, 5]) assert.equal(isHttpsUrl(bad), false, String(bad));
    });
});

describe('validateMessage / toLineMessage — 每種類型', () => {
    it('text：空白、非字串、超過 5000 字 → 不合法', () => {
        assert.equal(validateMessage({ type: 'text', text: '嗨' }), null);
        for (const text of ['', '   ', undefined, 5, 'x'.repeat(5001)]) assert.notEqual(validateMessage({ type: 'text', text }), null, String(text).slice(0, 10));
        assert.deepEqual(toLineMessage({ type: 'text', text: ' 嗨 ' }), { type: 'text', text: ' 嗨 ' });
        assert.equal(toLineMessage({ type: 'text', text: '' }), null);
    });

    it('image：必須 https；預覽圖預設用原圖', () => {
        assert.deepEqual(toLineMessage({ type: 'image', originalContentUrl: 'https://a.com/1.jpg' }), { type: 'image', originalContentUrl: 'https://a.com/1.jpg', previewImageUrl: 'https://a.com/1.jpg' });
        assert.notEqual(validateMessage({ type: 'image', originalContentUrl: 'http://a.com/1.jpg' }), null);
        assert.notEqual(validateMessage({ type: 'image', originalContentUrl: 'https://a.com/1.jpg', previewImageUrl: 'javascript:1' }), null);
    });

    it('flex：要有 contents 物件；altText 預設值且截到 400 字', () => {
        assert.notEqual(validateMessage({ type: 'flex' }), null);
        assert.notEqual(validateMessage({ type: 'flex', contents: 'x' }), null);
        assert.notEqual(validateMessage({ type: 'flex', contents: [] }), null);
        const m = toLineMessage({ type: 'flex', contents: { type: 'bubble' } });
        assert.equal(m.altText, '您收到了一則 Flex 訊息');
        assert.equal(toLineMessage({ type: 'flex', altText: 'a'.repeat(900), contents: {} }).altText.length, 400);
    });

    it('imagemap：要有 baseUrl 與 actions；http(s) 的 baseUrl 套重導向並去掉 .jpg', () => {
        assert.notEqual(validateMessage({ type: 'imagemap', baseUrl: 'https://a.com/m.jpg' }), null);
        const m = toLineMessage({ type: 'imagemap', baseUrl: 'https://a.com/m.jpg', baseSize: { width: 1040, height: 1040 }, actions: [] });
        assert.equal(m.baseUrl, `${IMAGEMAP_REDIRECT_BASE}https://a.com/m`);
        assert.equal(toLineMessage({ type: 'imagemap', baseUrl: 'relative/path', actions: [] }).baseUrl, 'relative/path');
    });

    it('未知類型 / 壞輸入 → 不合法，不丟例外；原型鏈上的名稱不算類型', () => {
        for (const bad of [null, undefined, 'x', 5, {}, { type: 'video' }, { type: 'constructor' }, { type: '__proto__' }, { type: 'toString' }]) {
            assert.notEqual(validateMessage(bad), null);
            assert.equal(toLineMessage(bad), null);
        }
    });

    it('登錄表是凍結的；每種類型都有 label / validate / toLine', () => {
        assert.ok(Object.isFrozen(MESSAGE_TYPES));
        for (const [name, t] of Object.entries(MESSAGE_TYPES)) {
            assert.equal(typeof t.label, 'string', name);
            assert.equal(typeof t.validate, 'function', name);
            assert.equal(typeof t.toLine, 'function', name);
        }
    });
});

describe('其他共用函式', () => {
    it('normalizeImagemapActions：keyword → message，不改原物件', () => {
        const msg = { type: 'imagemap', actions: [{ type: 'keyword', keyword: '客服' }, { type: 'uri', linkUri: 'https://a.com' }] };
        const out = normalizeImagemapActions(msg);
        assert.deepEqual(out.actions[0], { type: 'message', keyword: '客服', text: '客服' });
        assert.equal(msg.actions[0].type, 'keyword');
        assert.equal(normalizeImagemapActions({ type: 'text', text: 'x' }).text, 'x');
        assert.equal(normalizeImagemapActions(null), null);
    });

    it('pickQuickReplyId：自己的優先，否則取 replies 裡第一個有設定的', () => {
        assert.equal(pickQuickReplyId({ quickReplyId: 'a', replies: [{ quickReplyId: 'b' }] }), 'a');
        assert.equal(pickQuickReplyId({ replies: [{ type: 'text' }, { quickReplyId: 'b' }, { quickReplyId: 'c' }] }), 'b');
        assert.equal(pickQuickReplyId({ replies: [] }), null);
        assert.equal(pickQuickReplyId(null), null);
        assert.equal(pickQuickReplyId({}), null);
    });

    it('usesVariables：text 或 altText 有 (@…) 才算', () => {
        assert.equal(usesVariables([{ type: 'text', text: '嗨 (@name)' }]), true);
        assert.equal(usesVariables([{ type: 'flex', altText: '(@tier)' }]), true);
        assert.equal(usesVariables([{ type: 'text', text: '嗨' }, null]), false);
        assert.equal(usesVariables(undefined), false);
    });
});

// ── 管線 ────────────────────────────────────────────────────────────────

function jsonKV() {
    const base = createMockKV();
    return { ...base, async get(k, o) { const raw = await base.get(k); return raw !== null && o && o.type === 'json' ? JSON.parse(raw) : raw; } };
}

describe('formatReplyMessage（相容包裝）', () => {
    it('Flex 只存 id → 從 store 查回內容；找不到 → null', async () => {
        const env = { KV_LINE_STORAGE: jsonKV() };
        // 沒有 bot 資料時 openBotStore 讀不到清單 → null
        assert.equal(await formatReplyMessage({ type: 'flex', id: 'nope' }, env, 'U1'), null);
        assert.deepEqual(await formatReplyMessage({ type: 'flex', contents: { type: 'bubble' }, altText: 'x' }, env, 'U1'), { type: 'flex', altText: 'x', contents: { type: 'bubble' } });
    });

    it('壞輸入回 null', async () => {
        for (const bad of [null, undefined, {}, { type: 'video' }, 'x']) assert.equal(await formatReplyMessage(bad, {}, 'U1'), null);
    });
});

describe('formatReplies', () => {
    it('丟掉不合法的、保留順序、Imagemap 正規化', async () => {
        const out = await formatReplies([
            { type: 'text', text: 'a' },
            { type: 'text', text: '' },
            { type: 'video' },
            { type: 'imagemap', baseUrl: 'rel', actions: [{ type: 'keyword', keyword: 'k' }] },
            null,
        ], {}, 'U1');
        assert.deepEqual(out.map((m) => m.type), ['text', 'imagemap']);
        assert.equal(out[1].actions[0].type, 'message');
    });

    it('超過 5 則 → 截斷（否則 LINE 會整次拒絕）', async () => {
        const replies = Array.from({ length: 8 }, (_, i) => ({ type: 'text', text: `${i}` }));
        const out = await formatReplies(replies, {}, 'U1');
        assert.equal(out.length, LINE_MAX_MESSAGES);
        assert.equal(out[4].text, '4');
    });

    it('空 / 非陣列 → 空陣列', async () => {
        assert.deepEqual(await formatReplies([], {}, 'U1'), []);
        assert.deepEqual(await formatReplies(undefined, {}, 'U1'), []);
    });
});

describe('finalizeMessages / attachQuickReply', () => {
    const store = (list) => ({ getOr: async (k, d) => (k === 'quickReplies' ? list : d) });
    const qr = [{ id: 'q1', name: 'x', items: [{ action: { type: 'message', label: 'A', text: 'a' } }] }, { id: 'empty', items: [] }];

    it('Quick Reply 套在最後一則；沒有模板 / 空模板 / 沒有 id → 不套', async () => {
        const msgs = [{ type: 'text', text: '1' }, { type: 'text', text: '2' }];
        assert.equal(await attachQuickReply(store(qr), msgs, 'q1'), true);
        assert.equal(msgs[0].quickReply, undefined);
        assert.deepEqual(msgs[1].quickReply.items[0], { type: 'action', action: { type: 'message', label: 'A', text: 'a' } });

        for (const id of ['missing', 'empty', null, '']) {
            const m = [{ type: 'text', text: '1' }];
            assert.equal(await attachQuickReply(store(qr), m, id), false, String(id));
            assert.equal(m[0].quickReply, undefined);
        }
        assert.equal(await attachQuickReply(store(qr), [], 'q1'), false);
    });

    it('變數與 Quick Reply 一起處理；variables 為 null 不替換', async () => {
        const msgs = [{ type: 'text', text: '嗨 (@name)' }];
        await finalizeMessages(msgs, { variables: { userName: '小明', tierInfo: {} }, store: store(qr), quickReplyId: 'q1' });
        assert.equal(msgs[0].text, '嗨 小明');
        assert.ok(msgs[0].quickReply);

        const keep = [{ type: 'text', text: '嗨 (@name)' }];
        await finalizeMessages(keep, { variables: null });
        assert.equal(keep[0].text, '嗨 (@name)');
    });
});

describe('sendMessages', () => {
    let calls, realFetch;
    beforeEach(() => { calls = []; realFetch = globalThis.fetch; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }; });
    afterEach(() => { globalThis.fetch = realFetch; });

    it('有 replyToken → 回覆；沒有 → 推播；沒有訊息 → 什麼都不送', async () => {
        const msgs = [{ type: 'text', text: 'x' }];
        assert.equal(await sendMessages(msgs, { replyToken: 'rt', to: 'U1', accessToken: 't' }), 'reply');
        assert.ok(calls[0].url.endsWith('/message/reply'));
        assert.equal(await sendMessages(msgs, { to: 'U1', accessToken: 't' }), 'push');
        assert.ok(calls[1].url.endsWith('/message/push'));
        assert.equal(calls[1].body.to, 'U1');
        assert.equal(await sendMessages([], { replyToken: 'rt', accessToken: 't' }), null);
        assert.equal(calls.length, 2);
    });
});
