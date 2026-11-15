/**
 * Unit Tests - lib/crypto_util.js
 * 橋接 API 用的雜湊 / 隨機 token / 定時比較工具
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, randomToken, timingSafeEqual } from '../../worker_src/lib/crypto_util.js';

describe('sha256Hex', () => {
    it('與 node:crypto 的結果一致', async () => {
        const expected = createHash('sha256').update('hello', 'utf8').digest('hex');
        assert.equal(await sha256Hex('hello'), expected);
    });

    it('空字串也能算，且長度固定 64', async () => {
        const out = await sha256Hex('');
        assert.equal(out.length, 64);
        assert.match(out, /^[0-9a-f]{64}$/);
    });

    it('支援中文（UTF-8）', async () => {
        const expected = createHash('sha256').update('品棧', 'utf8').digest('hex');
        assert.equal(await sha256Hex('品棧'), expected);
    });
});

describe('randomToken', () => {
    it('帶指定前綴', () => {
        assert.ok(randomToken('sk_').startsWith('sk_'));
    });

    it('前綴之後是 base64url，且夠長（32 bytes ≈ 43 字元）', () => {
        const t = randomToken('sk_');
        assert.match(t.slice(3), /^[A-Za-z0-9_-]{43}$/);
    });

    it('不含 ":"（KV key 以冒號分隔，不可混入）', () => {
        for (let i = 0; i < 50; i++) assert.ok(!randomToken('sk_').includes(':'));
    });

    it('每次都不同', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(randomToken('sk_'));
        assert.equal(seen.size, 200);
    });

    it('沒給前綴時就是純隨機字串', () => {
        assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
    });
});

describe('timingSafeEqual', () => {
    it('相同內容為 true', () => {
        assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    });

    it('內容不同為 false', () => {
        assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    });

    it('長度不同為 false', () => {
        assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
    });

    it('兩個空陣列為 true', () => {
        assert.equal(timingSafeEqual(new Uint8Array(), new Uint8Array()), true);
    });
});
