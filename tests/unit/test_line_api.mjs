/**
 * Unit Tests — lib/line_api.js
 *
 * 橋接 API 需要分辨「這個人再也推不到了（403 封鎖）」「額度/頻率（429）」
 * 「這次失敗稍後重試」——全部混成一個 Error 字串就分不出來。所以失敗要丟
 * 帶 status 的 LineApiError，同時保留既有的錯誤訊息文字（舊呼叫端看得到同樣的字）。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    pushMessage,
    multicastMessage,
    broadcastMessage,
    LineApiError,
} from '../../worker_src/lib/line_api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const MSGS = [{ type: 'text', text: 'hi' }];

function mockFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return handler(url, init);
    };
    return calls;
}

function jsonRes(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers });
}

describe('pushMessage', () => {
    it('成功：打對的 URL、帶 token 與 body，回傳 LINE 的 JSON', async () => {
        const calls = mockFetch(() => jsonRes({ sentMessages: [{ id: '1' }] }));
        const out = await pushMessage('TOKEN', 'U123', MSGS);
        assert.deepEqual(out, { sentMessages: [{ id: '1' }] });
        assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN');
        assert.deepEqual(JSON.parse(calls[0].init.body), { to: 'U123', messages: MSGS });
    });

    it('沒給 retryKey 時不帶 X-Line-Retry-Key', async () => {
        const calls = mockFetch(() => jsonRes({}));
        await pushMessage('T', 'U1', MSGS);
        assert.equal(calls[0].init.headers['X-Line-Retry-Key'], undefined);
    });

    it('有 retryKey 時帶 X-Line-Retry-Key', async () => {
        const calls = mockFetch(() => jsonRes({}));
        await pushMessage('T', 'U1', MSGS, { retryKey: '123e4567-e89b-42d3-a456-426614174000' });
        assert.equal(calls[0].init.headers['X-Line-Retry-Key'], '123e4567-e89b-42d3-a456-426614174000');
    });

    it('失敗：丟 LineApiError，帶 status 與 body', async () => {
        mockFetch(() => jsonRes({ message: 'blocked' }, 403));
        await assert.rejects(() => pushMessage('T', 'U1', MSGS), (err) => {
            assert.ok(err instanceof LineApiError);
            assert.ok(err instanceof Error);
            assert.equal(err.name, 'LineApiError');
            assert.equal(err.status, 403);
            assert.deepEqual(err.body, { message: 'blocked' });
            return true;
        });
    });

    it('失敗訊息文字與舊版相同（既有呼叫端不受影響）', async () => {
        mockFetch(() => jsonRes({ message: 'bad' }, 400));
        await assert.rejects(
            () => pushMessage('T', 'U1', MSGS),
            { message: `LINE API Push failed: ${JSON.stringify({ message: 'bad' })}` }
        );
    });

    it('429 帶 Retry-After → err.retryAfter 是數字', async () => {
        mockFetch(() => jsonRes({ message: 'slow down' }, 429, { 'Retry-After': '7' }));
        await assert.rejects(() => pushMessage('T', 'U1', MSGS), (err) => {
            assert.equal(err.status, 429);
            assert.equal(err.retryAfter, 7);
            return true;
        });
    });

    it('沒有 Retry-After → retryAfter 是 null', async () => {
        mockFetch(() => jsonRes({}, 500));
        await assert.rejects(() => pushMessage('T', 'U1', MSGS), (err) => err.retryAfter === null);
    });

    it('409（retry key 已被接受）→ 帶出 X-Line-Accepted-Request-Id', async () => {
        mockFetch(() => jsonRes({ message: 'conflict' }, 409, { 'X-Line-Accepted-Request-Id': 'req-abc' }));
        await assert.rejects(() => pushMessage('T', 'U1', MSGS, { retryKey: 'k' }), (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.acceptedRequestId, 'req-abc');
            return true;
        });
    });

    it('LINE 回非 JSON（例如 502 的 HTML）→ 仍是 LineApiError，不是 SyntaxError', async () => {
        mockFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
        await assert.rejects(() => pushMessage('T', 'U1', MSGS), (err) => {
            assert.ok(err instanceof LineApiError);
            assert.equal(err.status, 502);
            assert.equal(err.body, null);
            return true;
        });
    });

    it('成功但 body 為空 → 回 {}', async () => {
        mockFetch(() => new Response('', { status: 200 }));
        assert.deepEqual(await pushMessage('T', 'U1', MSGS), {});
    });
});

describe('multicastMessage', () => {
    it('成功：打 multicast 端點，body 是 {to: [...], messages}', async () => {
        const calls = mockFetch(() => jsonRes({}));
        await multicastMessage('T', ['U1', 'U2'], MSGS);
        assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/multicast');
        assert.deepEqual(JSON.parse(calls[0].init.body), { to: ['U1', 'U2'], messages: MSGS });
    });

    it('有 retryKey 時帶 X-Line-Retry-Key', async () => {
        const calls = mockFetch(() => jsonRes({}));
        await multicastMessage('T', ['U1'], MSGS, { retryKey: 'abc' });
        assert.equal(calls[0].init.headers['X-Line-Retry-Key'], 'abc');
    });

    it('剛好 500 人可以', async () => {
        mockFetch(() => jsonRes({}));
        const to = Array.from({ length: 500 }, (_, i) => `U${i}`);
        await multicastMessage('T', to, MSGS);
    });

    it('超過 500 人 → 在打 LINE 之前就丟錯', async () => {
        const calls = mockFetch(() => jsonRes({}));
        const to = Array.from({ length: 501 }, (_, i) => `U${i}`);
        await assert.rejects(() => multicastMessage('T', to, MSGS), /500/);
        assert.equal(calls.length, 0);
    });

    it('空名單或不是陣列 → 在打 LINE 之前就丟錯', async () => {
        const calls = mockFetch(() => jsonRes({}));
        await assert.rejects(() => multicastMessage('T', [], MSGS));
        await assert.rejects(() => multicastMessage('T', 'U1', MSGS));
        assert.equal(calls.length, 0);
    });

    it('失敗：LineApiError，訊息為 Multicast', async () => {
        mockFetch(() => jsonRes({ message: 'x' }, 400));
        await assert.rejects(() => multicastMessage('T', ['U1'], MSGS), (err) => {
            assert.ok(err instanceof LineApiError);
            assert.equal(err.status, 400);
            assert.match(err.message, /^LINE API Multicast failed:/);
            return true;
        });
    });
});

describe('broadcastMessage（既有行為）', () => {
    it('失敗訊息文字不變', async () => {
        mockFetch(() => new Response('nope', { status: 400 }));
        await assert.rejects(() => broadcastMessage('T', MSGS), { message: 'LINE API Broadcast failed: nope' });
    });
});
