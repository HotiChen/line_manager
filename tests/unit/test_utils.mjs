/**
 * Unit Tests - lib/utils.js
 * 測試 jsonResponse 和 getCorsHeaders
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, getCorsHeaders } from '../../worker_src/lib/utils.js';

describe('getCorsHeaders', () => {
    it('should return correct CORS headers', () => {
        const headers = getCorsHeaders();
        assert.equal(headers['Access-Control-Allow-Origin'], '*');
        assert.ok(headers['Access-Control-Allow-Methods'].includes('GET'));
        assert.ok(headers['Access-Control-Allow-Methods'].includes('POST'));
        assert.ok(headers['Access-Control-Allow-Methods'].includes('PUT'));
        assert.ok(headers['Access-Control-Allow-Methods'].includes('DELETE'));
        assert.ok(headers['Access-Control-Allow-Headers'].includes('Authorization'));
        assert.ok(headers['Access-Control-Allow-Headers'].includes('X-User-Id'));
        assert.ok(headers['Access-Control-Allow-Headers'].includes('X-Bot-Id'));
        assert.ok(headers['Access-Control-Allow-Headers'].includes('Content-Type'));
    });
});

describe('jsonResponse', () => {
    it('should return 200 status by default', () => {
        const res = jsonResponse({ ok: true });
        assert.equal(res.status, 200);
    });

    it('should return custom status code', () => {
        const res = jsonResponse({ error: 'Not found' }, 404);
        assert.equal(res.status, 404);
    });

    it('should return JSON content type', () => {
        const res = jsonResponse({ ok: true });
        assert.equal(res.headers.get('Content-Type'), 'application/json');
    });

    it('should include CORS headers', () => {
        const res = jsonResponse({ ok: true });
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    });

    it('should serialize body as JSON', async () => {
        const data = { foo: 'bar', count: 42 };
        const res = jsonResponse(data);
        const body = await res.json();
        assert.deepEqual(body, data);
    });

    it('should handle empty object', async () => {
        const res = jsonResponse({});
        const body = await res.json();
        assert.deepEqual(body, {});
    });

    it('should handle array data', async () => {
        const data = [1, 2, 3];
        const res = jsonResponse(data);
        const body = await res.json();
        assert.deepEqual(body, [1, 2, 3]);
    });

    it('should handle 401 status', () => {
        const res = jsonResponse({ error: 'Unauthorized' }, 401);
        assert.equal(res.status, 401);
    });

    it('should handle 429 status', () => {
        const res = jsonResponse({ error: 'Too many requests' }, 429);
        assert.equal(res.status, 429);
    });

    it('should handle 500 status', () => {
        const res = jsonResponse({ error: 'Server error' }, 500);
        assert.equal(res.status, 500);
    });
});
