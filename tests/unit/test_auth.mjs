/**
 * Unit Tests - middleware/auth.js
 * 測試認證中間件：LIFF token 驗證 / Legacy X-User-Id / withAuth 包裝
 */
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock global fetch for LINE API calls
const originalFetch = globalThis.fetch;

function mockFetch(handler) {
    globalThis.fetch = handler;
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

// Dynamic import to get fresh module
async function loadAuth() {
    // We need to import auth.js - it depends on utils.js jsonResponse
    const { authenticate, withAuth } = await import('../../worker_src/middleware/auth.js');
    return { authenticate, withAuth };
}

function makeRequest(headers = {}) {
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) {
        h.set(k, v);
    }
    return new Request('http://localhost/api/test', { headers: h });
}

describe('authenticate - Legacy mode', () => {
    it('should authenticate with X-User-Id header in legacy mode', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({ 'X-User-Id': 'U12345' });

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, true);
        assert.equal(result.userId, 'U12345');
    });

    it('should authenticate with userId query param in legacy mode', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };
        const request = new Request('http://localhost/api/test?userId=U67890');

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, true);
        assert.equal(result.userId, 'U67890');
    });

    it('should fail when no auth provided in legacy mode', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({});

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, false);
        assert.ok(result.error);
    });

    it('should default to liff mode (fail-closed) when AUTH_MODE not set', async () => {
        // SEC-002: AUTH_MODE 未設定時，預設為 liff（fail-closed）。
        // X-User-Id fallback 在 liff 模式下應被拒絕，不可意外開放 legacy 通道。
        const { authenticate } = await loadAuth();
        const env = {};
        const request = makeRequest({ 'X-User-Id': 'Udefault' });

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.error, 'Authorization header required');
    });
});

describe('authenticate - LIFF mode', () => {
    it('should fail when no Authorization header in LIFF mode', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({});

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, false);
    });

    it('should reject X-User-Id fallback in LIFF mode (SEC-002)', async () => {
        // SEC-002: LIFF 模式下已禁用 X-User-Id 回退，必須提供 Authorization header。
        // 此測試驗證新的正確行為：有 X-User-Id 但沒有 Authorization，應被拒絕。
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({ 'X-User-Id': 'Ufallback' });

        const result = await authenticate(request, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.error, 'Authorization header required');
    });

    it('should reject invalid Bearer token', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };

        // Mock LINE API to return error
        mockFetch(async (url) => {
            return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        });

        try {
            const request = makeRequest({ 'Authorization': 'Bearer invalid_token_xxx' });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, false);
            assert.ok(result.error);
        } finally {
            restoreFetch();
        }
    });

    it('should accept valid Bearer token and extract userId', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };

        // Mock LINE API: verify → ok, profile → userId
        mockFetch(async (url) => {
            if (url.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ expires_in: 3600, client_id: 'test' }), { status: 200 });
            }
            if (url.includes('v2/profile')) {
                return new Response(JSON.stringify({ userId: 'Uverified123', displayName: 'TestUser' }), { status: 200 });
            }
            return new Response('Not found', { status: 404 });
        });

        try {
            const request = makeRequest({ 'Authorization': 'Bearer valid_access_token' });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, true);
            assert.equal(result.userId, 'Uverified123');
        } finally {
            restoreFetch();
        }
    });

    it('should reject expired token', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };

        mockFetch(async (url) => {
            if (url.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ expires_in: 0, client_id: 'test' }), { status: 200 });
            }
            return new Response('Not found', { status: 404 });
        });

        try {
            const request = makeRequest({ 'Authorization': 'Bearer expired_token' });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, false);
            assert.ok(result.error.includes('expired'));
        } finally {
            restoreFetch();
        }
    });

    it('should reject when profile has no userId', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };

        mockFetch(async (url) => {
            if (url.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ expires_in: 3600, client_id: 'test' }), { status: 200 });
            }
            if (url.includes('v2/profile')) {
                return new Response(JSON.stringify({ displayName: 'NoId' }), { status: 200 });
            }
            return new Response('Not found', { status: 404 });
        });

        try {
            const request = makeRequest({ 'Authorization': 'Bearer no_userid_token' });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, false);
            assert.ok(result.error.includes('userId'));
        } finally {
            restoreFetch();
        }
    });

    it('should reject when profile API fails', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'liff', LIFF_CHANNEL_ID: 'test' };

        mockFetch(async (url) => {
            if (url.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ expires_in: 3600, client_id: 'test' }), { status: 200 });
            }
            if (url.includes('v2/profile')) {
                return new Response('Unauthorized', { status: 401 });
            }
            return new Response('Not found', { status: 404 });
        });

        try {
            const request = makeRequest({ 'Authorization': 'Bearer bad_profile_token' });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, false);
        } finally {
            restoreFetch();
        }
    });
});

describe('authenticate - Bearer token takes priority', () => {
    it('should use Bearer token over X-User-Id in legacy mode', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };

        mockFetch(async (url) => {
            if (url.includes('oauth2/v2.1/verify')) {
                return new Response(JSON.stringify({ expires_in: 3600, client_id: 'test' }), { status: 200 });
            }
            if (url.includes('v2/profile')) {
                return new Response(JSON.stringify({ userId: 'UfromToken' }), { status: 200 });
            }
            return new Response('Not found', { status: 404 });
        });

        try {
            const request = makeRequest({
                'Authorization': 'Bearer valid_token',
                'X-User-Id': 'UfromHeader'
            });
            const result = await authenticate(request, env);
            assert.equal(result.authenticated, true);
            assert.equal(result.userId, 'UfromToken');
        } finally {
            restoreFetch();
        }
    });

    it('should reject if Bearer token is provided but invalid, even with valid X-User-Id', async () => {
        const { authenticate } = await loadAuth();
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };

        mockFetch(async () => {
            return new Response('Bad', { status: 400 });
        });

        try {
            const request = makeRequest({
                'Authorization': 'Bearer bad_token',
                'X-User-Id': 'UvalidHeader'
            });
            const result = await authenticate(request, env);
            // If Bearer is provided but invalid, it should reject (not fall through)
            assert.equal(result.authenticated, false);
        } finally {
            restoreFetch();
        }
    });
});

describe('withAuth', () => {
    it('should pass userId to wrapped handler on success', async () => {
        const { withAuth } = await loadAuth();
        let capturedUserId = null;

        const handler = async (request, env, userId) => {
            capturedUserId = userId;
            return new Response('OK');
        };

        const wrapped = withAuth(handler);
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({ 'X-User-Id': 'Uwrapped123' });

        await wrapped(request, env);
        assert.equal(capturedUserId, 'Uwrapped123');
    });

    it('should return 401 when not authenticated', async () => {
        const { withAuth } = await loadAuth();
        const handler = async () => new Response('Should not reach');

        const wrapped = withAuth(handler);
        const env = { AUTH_MODE: 'legacy', LIFF_CHANNEL_ID: 'test' };
        const request = makeRequest({});

        const res = await wrapped(request, env);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.ok(body.error);
    });
});
