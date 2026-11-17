/**
 * Unit Tests — bridge/errors.js（bridge-v1 新錯誤格式 helper）
 * 決定 D-7：/raw/* 與 /systems* 維持舊格式；此 helper 供 LM-2A 之後的新端點使用。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeError, ERROR_CODES, ERROR_DEFAULTS } from '../../worker_src/bridge/errors.js';

const EXPECTED_CODES = [
    'INVALID_KEY', 'LINK_REVOKED', 'SCOPE_DENIED', 'INVALID_CODE', 'INVALID_REQUEST',
    'CONTACT_NOT_BOUND', 'RECIPIENT_BLOCKED', 'INVALID_URL_DOMAIN', 'IN_PROGRESS',
    'IDEMPOTENCY_KEY_REUSE', 'NOT_FOUND', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'INTERNAL',
];

describe('ERROR_CODES / ERROR_DEFAULTS', () => {
    it('enum 與 bridge-v1.yaml 的 Error schema 完全一致', () => {
        const yaml = readFileSync(fileURLToPath(new URL('../../docs/integration/bridge-v1.yaml', import.meta.url)), 'utf8');
        const block = yaml.split('    Error:')[1].split('retryable:')[0];
        const fromYaml = [...block.matchAll(/^\s+- ([A-Z_]+)\s*$/gm)].map((m) => m[1]);
        assert.deepEqual([...ERROR_CODES].sort(), [...fromYaml].sort());
    });

    it('14 個 code 全在，對照表每個 code 都有條目', () => {
        assert.deepEqual([...ERROR_CODES].sort(), [...EXPECTED_CODES].sort());
        assert.deepEqual(Object.keys(ERROR_DEFAULTS).sort(), [...EXPECTED_CODES].sort());
    });

    it('預設 HTTP status 對照', () => {
        const expected = {
            INVALID_KEY: 401, LINK_REVOKED: 403, SCOPE_DENIED: 403, INVALID_CODE: 400, INVALID_REQUEST: 400,
            CONTACT_NOT_BOUND: 409, RECIPIENT_BLOCKED: 409, INVALID_URL_DOMAIN: 422, IN_PROGRESS: 409,
            IDEMPOTENCY_KEY_REUSE: 422, NOT_FOUND: 404, QUOTA_EXCEEDED: 402, RATE_LIMITED: 429, INTERNAL: 500,
        };
        for (const [code, status] of Object.entries(expected)) assert.equal(ERROR_DEFAULTS[code].status, status, code);
    });

    it('預設 retryable：只有 IN_PROGRESS、RATE_LIMITED、INTERNAL 可重試', () => {
        const retryable = Object.keys(ERROR_DEFAULTS).filter((c) => ERROR_DEFAULTS[c].retryable).sort();
        assert.deepEqual(retryable, ['INTERNAL', 'IN_PROGRESS', 'RATE_LIMITED']);
    });

    it('對照表與 ERROR_CODES 不可被改動', () => {
        assert.ok(Object.isFrozen(ERROR_CODES));
        assert.ok(Object.isFrozen(ERROR_DEFAULTS));
        assert.ok(Object.isFrozen(ERROR_DEFAULTS.INVALID_KEY));
    });
});

describe('bridgeError', () => {
    it('回 {error:{code,message,retryable}} 的 JSON Response，使用預設 status', async () => {
        const res = bridgeError('INVALID_KEY', 'Invalid or revoked key');
        assert.ok(res instanceof Response);
        assert.equal(res.status, 401);
        assert.match(res.headers.get('Content-Type'), /application\/json/);
        assert.deepEqual(await res.json(), { error: { code: 'INVALID_KEY', message: 'Invalid or revoked key', retryable: false } });
    });

    it('每個 code 的 status 與 retryable 都吃對照表', async () => {
        for (const code of EXPECTED_CODES) {
            const res = bridgeError(code, 'x');
            assert.equal(res.status, ERROR_DEFAULTS[code].status, code);
            const body = await res.json();
            assert.equal(body.error.code, code);
            assert.equal(body.error.retryable, ERROR_DEFAULTS[code].retryable, code);
            assert.deepEqual(Object.keys(body), ['error']);
            assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'retryable']);
        }
    });

    it('status / retryable 可覆寫', async () => {
        const res = bridgeError('QUOTA_EXCEEDED', 'quota', { status: 429, retryable: true });
        assert.equal(res.status, 429);
        assert.equal((await res.json()).error.retryable, true);
    });

    it('headers 會帶上（例如 Retry-After），且不蓋掉 Content-Type', async () => {
        const res = bridgeError('RATE_LIMITED', 'slow down', { headers: { 'Retry-After': '30' } });
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('Retry-After'), '30');
        assert.match(res.headers.get('Content-Type'), /application\/json/);
        assert.equal((await res.json()).error.retryable, true);
    });

    it('未知 code 丟錯（程式錯誤），包含 undefined / 小寫 / 舊式字串', () => {
        for (const bad of ['NOPE', undefined, null, '', 'invalid_key', 'idempotency_key_reuse', 'toString', '__proto__', 'constructor']) {
            assert.throws(() => bridgeError(bad, 'x'), /unknown bridge error code/i, String(bad));
        }
    });

    it('message 必須是字串，否則丟錯', () => {
        assert.throws(() => bridgeError('INTERNAL', undefined), /message/);
        assert.throws(() => bridgeError('INTERNAL', new Error('boom')), /message/);
    });

    it('非法 status 丟錯', () => {
        assert.throws(() => bridgeError('INTERNAL', 'x', { status: 99 }), /status/);
        assert.throws(() => bridgeError('INTERNAL', 'x', { status: 'oops' }), /status/);
    });

    it('回應不含 stack：即使 message 來源是 Error 的 stack，也只取一行 message 語意由呼叫端負責，body 不多出欄位', async () => {
        const body = await bridgeError('INTERNAL', 'internal_error').json();
        const text = JSON.stringify(body);
        assert.ok(!/stack/i.test(text));
        assert.ok(!/\n\s+at /.test(text));
        assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'retryable']);
    });

    it('message 含多行 stack 樣式內容時被截成第一行（防止誤傳 err.stack）', async () => {
        const err = new Error('boom');
        const body = await bridgeError('INTERNAL', err.stack).json();
        assert.ok(!/\n/.test(body.error.message));
        assert.ok(!/\s+at\s+/.test(body.error.message));
    });
});
