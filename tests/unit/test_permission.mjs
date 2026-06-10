/**
 * Unit Tests - middleware/permission.js
 * 測試權限中間件：Bot 權限檢查 / withPermission 包裝
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPermission, withPermission } from '../../worker_src/middleware/permission.js';

// Mock KV storage
function createMockKV(data = {}) {
    return {
        async get(key, opts) {
            const val = data[key];
            if (val === undefined || val === null) return null;
            if (opts?.type === 'json') return typeof val === 'string' ? JSON.parse(val) : val;
            return typeof val === 'string' ? val : JSON.stringify(val);
        },
        async put(key, value) {
            data[key] = value;
        },
        async delete(key) {
            delete data[key];
        },
        async list({ prefix }) {
            const keys = Object.keys(data)
                .filter(k => k.startsWith(prefix))
                .map(name => ({ name }));
            return { keys };
        }
    };
}

function makeRequest(headers = {}) {
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) {
        h.set(k, v);
    }
    return new Request('http://localhost/api/test', { headers: h });
}

describe('checkPermission', () => {
    it('should succeed when user has permission via X-Bot-Id', async () => {
        const botId = 'bot_perm_123';
        const userId = 'Uperm001';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`bot:${botId}:permissions`]: { users: [{ userId, role: 'owner' }] }
            })
        };
        const request = makeRequest({ 'X-Bot-Id': botId });

        const result = await checkPermission(request, env, userId);
        assert.equal(result.success, true);
        assert.equal(result.botId, botId);
        assert.equal(result.role, 'owner');
    });

    it('should fail when user has no permission', async () => {
        const botId = 'bot_noperm';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`bot:${botId}:permissions`]: { users: [{ userId: 'Uother', role: 'owner' }] }
            })
        };
        const request = makeRequest({ 'X-Bot-Id': botId });

        const result = await checkPermission(request, env, 'Uunauthorized');
        assert.equal(result.success, false);
        assert.ok(result.error.includes('denied'));
    });

    it('should fail when bot has no permissions set', async () => {
        const env = {
            KV_LINE_STORAGE: createMockKV({})
        };
        const request = makeRequest({ 'X-Bot-Id': 'bot_nonexist' });

        const result = await checkPermission(request, env, 'Uany');
        assert.equal(result.success, false);
    });

    it('should use default bot from user bots when X-Bot-Id not provided', async () => {
        const userId = 'Udefault_bot';
        const defaultBotId = 'bot_default_456';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`user:${userId}:bots`]: { currentBotId: defaultBotId, bots: [] },
                [`bot:${defaultBotId}:permissions`]: { users: [{ userId, role: 'member' }] }
            })
        };
        const request = makeRequest({});

        const result = await checkPermission(request, env, userId);
        assert.equal(result.success, true);
        assert.equal(result.botId, defaultBotId);
        assert.equal(result.role, 'member');
    });

    it('should fail when no Bot ID and no default bot', async () => {
        const env = {
            KV_LINE_STORAGE: createMockKV({})
        };
        const request = makeRequest({});

        const result = await checkPermission(request, env, 'Unobots');
        assert.equal(result.success, false);
        assert.ok(result.error.includes('No Bot ID'));
    });
});

describe('withPermission', () => {
    it('should pass botId and role to wrapped handler', async () => {
        let captured = {};
        const handler = async (req, env, userId, botId, role) => {
            captured = { userId, botId, role };
            return new Response('OK');
        };

        const botId = 'bot_wrap_001';
        const userId = 'Uwrap001';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`bot:${botId}:permissions`]: { users: [{ userId, role: 'owner' }] }
            })
        };
        const request = makeRequest({ 'X-Bot-Id': botId });

        const wrapped = withPermission(handler);
        await wrapped(request, env, userId);

        assert.equal(captured.userId, userId);
        assert.equal(captured.botId, botId);
        assert.equal(captured.role, 'owner');
    });

    it('should return 403 when permission check fails', async () => {
        const handler = async () => new Response('Should not reach');
        const env = {
            KV_LINE_STORAGE: createMockKV({})
        };
        const request = makeRequest({ 'X-Bot-Id': 'bot_noaccess' });

        const wrapped = withPermission(handler);
        const res = await wrapped(request, env, 'Unoaccess');
        assert.equal(res.status, 403);
    });

    it('should return 403 when required role does not match', async () => {
        const handler = async () => new Response('Should not reach');
        const botId = 'bot_role_check';
        const userId = 'Umember_only';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`bot:${botId}:permissions`]: { users: [{ userId, role: 'member' }] }
            })
        };
        const request = makeRequest({ 'X-Bot-Id': botId });

        const wrapped = withPermission(handler, 'owner'); // requires owner
        const res = await wrapped(request, env, userId);
        assert.equal(res.status, 403);
        const body = await res.json();
        assert.ok(body.error.includes('owner'));
    });

    it('should allow when role matches required', async () => {
        let called = false;
        const handler = async (req, env, userId, botId, role) => {
            called = true;
            return new Response('OK');
        };

        const botId = 'bot_owner';
        const userId = 'Uowner';
        const env = {
            KV_LINE_STORAGE: createMockKV({
                [`bot:${botId}:permissions`]: { users: [{ userId, role: 'owner' }] }
            })
        };
        const request = makeRequest({ 'X-Bot-Id': botId });

        const wrapped = withPermission(handler, 'owner');
        await wrapped(request, env, userId);
        assert.equal(called, true);
    });
});
