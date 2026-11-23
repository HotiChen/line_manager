/**
 * Unit Tests — handler/push_message.js 的變數替換已改用共用版本
 * （以前這裡有自己的一套：只支援 4 種變數、用 UTC、(@day) 少了「星期」）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { handleSendPushMessage } from '../../worker_src/handler/push_message.js';

const USER = 'Uowner0000000000000000000000001';
const TARGET = 'Utarget000000000000000000000002';

function jsonKV() {
    const base = createMockKV();
    return { ...base, async get(k, o) { const raw = await base.get(k); return raw !== null && o && o.type === 'json' ? JSON.parse(raw) : raw; } };
}

let env, pushed, realFetch;
beforeEach(async () => {
    env = { KV_LINE_STORAGE: jsonKV() };
    await env.KV_LINE_STORAGE.put(`current_token_${USER}`, 'P');
    await env.KV_LINE_STORAGE.put(`access_tokens_${USER}`, JSON.stringify({ P: { token: 'tok', destination: 'Ubot00000000000000000000000000a' } }));
    pushed = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { pushed.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const send = (messages) => handleSendPushMessage(
    new Request('https://x.test/api/push', { method: 'POST', body: JSON.stringify({ to: TARGET, messages }) }), env, USER);

describe('推播的變數替換', () => {
    it('支援所有共用變數（以前只有 4 種）；找不到會員姓名時預設「朋友」', async () => {
        const res = await send([{ type: 'text', text: '嗨 (@name)，(@tier) (@tier_name)，(@year) 年 (@month) 月，(@day)' }]);
        assert.equal(res.status, 200);
        const text = pushed[0].messages[0].text;
        assert.match(text, /^嗨 朋友，/);
        assert.doesNotMatch(text, /\(@/, `還有沒替換的變數：${text}`);
        assert.match(text, /星期[日一二三四五六]$/);
    });

    it('altText 也會替換；不改到呼叫端傳進來的物件', async () => {
        const input = [{ type: 'flex', altText: '給 (@name)', contents: {} }];
        await send(input);
        assert.equal(pushed[0].messages[0].altText, '給 朋友');
        assert.equal(input[0].altText, '給 (@name)');
    });
});
