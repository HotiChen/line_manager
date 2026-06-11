/**
 * Unit Tests - lib/signature.js
 * 測試 LINE Webhook 簽章驗證函式 verifySignature()
 *
 * verifySignature(request, bodyText, channelSecret)
 *   - 使用 crypto.subtle (Web Crypto API) 計算 HMAC-SHA256
 *   - 與 request.headers['x-line-signature'] (base64) 做時間安全比較
 *   - 若 header 不存在，直接回傳 false
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../../worker_src/lib/signature.js';

// ────────────────────────────────────────────────────────────
// 輔助：產生合法的 LINE x-line-signature
// LINE 規格：HMAC-SHA256(channelSecret, bodyText) → base64
// ────────────────────────────────────────────────────────────
function makeSignature(channelSecret, bodyText) {
    return createHmac('sha256', channelSecret)
        .update(bodyText, 'utf8')
        .digest('base64');
}

function makeRequest(signature) {
    const headers = new Headers();
    if (signature !== undefined) {
        headers.set('x-line-signature', signature);
    }
    return new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body: 'body'
    });
}

// ────────────────────────────────────────────────────────────
// 正確簽章：應回傳 true
// ────────────────────────────────────────────────────────────
describe('verifySignature — 合法簽章', () => {
    it('正確的 HMAC-SHA256 簽章應被接受', async () => {
        const secret = 'my-channel-secret';
        const body = '{"events":[]}';
        const sig = makeSignature(secret, body);

        const req = makeRequest(sig);
        const result = await verifySignature(req, body, secret);
        assert.equal(result, true);
    });

    it('空白 body 搭配對應簽章也應被接受', async () => {
        const secret = 'another-secret';
        const body = '';
        const sig = makeSignature(secret, body);

        const req = makeRequest(sig);
        const result = await verifySignature(req, body, secret);
        assert.equal(result, true);
    });

    it('Unicode body 搭配對應簽章應被接受', async () => {
        const secret = 'unicode-secret';
        const body = '{"message":"你好世界"}';
        const sig = makeSignature(secret, body);

        const req = makeRequest(sig);
        const result = await verifySignature(req, body, secret);
        assert.equal(result, true);
    });
});

// ────────────────────────────────────────────────────────────
// 篡改的 body：應回傳 false
// ────────────────────────────────────────────────────────────
describe('verifySignature — 篡改 body', () => {
    it('簽章正確但 body 被篡改時應回傳 false', async () => {
        const secret = 'tamper-secret';
        const originalBody = '{"events":[{"type":"message"}]}';
        const tamperedBody = '{"events":[{"type":"follow"}]}';
        const sig = makeSignature(secret, originalBody);

        const req = makeRequest(sig);
        const result = await verifySignature(req, tamperedBody, secret);
        assert.equal(result, false);
    });

    it('body 末尾多一個空白也會導致驗證失敗', async () => {
        const secret = 'space-secret';
        const body = '{"events":[]}';
        const sig = makeSignature(secret, body);

        const req = makeRequest(sig);
        const result = await verifySignature(req, body + ' ', secret);
        assert.equal(result, false);
    });
});

// ────────────────────────────────────────────────────────────
// 錯誤簽章：應回傳 false
// ────────────────────────────────────────────────────────────
describe('verifySignature — 錯誤簽章', () => {
    it('簽章使用錯誤 secret 計算時應回傳 false', async () => {
        const secret = 'correct-secret';
        const wrongSecret = 'wrong-secret';
        const body = '{"events":[]}';
        const sig = makeSignature(wrongSecret, body);

        const req = makeRequest(sig);
        const result = await verifySignature(req, body, secret);
        assert.equal(result, false);
    });

    it('簽章為任意字串（非合法 base64 HMAC）時應回傳 false', async () => {
        const secret = 'some-secret';
        const body = '{"events":[]}';

        const req = makeRequest('totally-invalid-signature');
        const result = await verifySignature(req, body, secret);
        assert.equal(result, false);
    });

    it('簽章長度不符（截短）時應回傳 false', async () => {
        const secret = 'length-secret';
        const body = '{"events":[]}';
        const sig = makeSignature(secret, body);
        // 截短簽章（長度不符會在 timingSafeEqual 的 length check 被擋下）
        const shortSig = sig.slice(0, 10);

        const req = makeRequest(shortSig);
        const result = await verifySignature(req, body, secret);
        assert.equal(result, false);
    });
});

// ────────────────────────────────────────────────────────────
// 缺少 x-line-signature header：應回傳 false（fail-closed）
// ────────────────────────────────────────────────────────────
describe('verifySignature — 缺少簽章 header', () => {
    it('無 x-line-signature header 時回傳 false', async () => {
        const req = makeRequest(undefined); // 不設定 header
        const result = await verifySignature(req, '{"events":[]}', 'any-secret');
        assert.equal(result, false);
    });
});
