/**
 * Unit Tests - migration/migrate.js
 * 測試 Migration API Handler 安全性和功能
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMigrate } from '../../worker_src/migration/migrate.js';

// Mock KV
function createMockKV(data = {}) {
    return {
        async get(key, opts) {
            const val = data[key];
            if (val === undefined || val === null) return null;
            if (opts?.type === 'json') return typeof val === 'string' ? JSON.parse(val) : val;
            return typeof val === 'string' ? val : JSON.stringify(val);
        },
        async put(key, value) { data[key] = value; },
        async delete(key) { delete data[key]; },
        async list({ prefix }) {
            return { keys: Object.keys(data).filter(k => k.startsWith(prefix)).map(name => ({ name })) };
        }
    };
}

describe('handleMigrate - Security', () => {
    it('should return 401 when no key provided', async () => {
        const env = { MIGRATION_SECRET: 'secret123', KV_LINE_STORAGE: createMockKV() };
        const request = new Request('http://localhost/admin/migrate?userId=U1');
        const res = await handleMigrate(request, env);
        assert.equal(res.status, 401);
    });

    it('should return 401 when wrong key provided', async () => {
        const env = { MIGRATION_SECRET: 'secret123', KV_LINE_STORAGE: createMockKV() };
        const request = new Request('http://localhost/admin/migrate?key=wrong&userId=U1');
        const res = await handleMigrate(request, env);
        assert.equal(res.status, 401);
    });

    it('should return 503 when MIGRATION_SECRET not configured', async () => {
        // Fail-closed: MIGRATION_SECRET 未設定時端點必須拒絕（503 = endpoint not configured）。
        const env = { KV_LINE_STORAGE: createMockKV() };
        const request = new Request('http://localhost/admin/migrate?key=anything&userId=U1');
        const res = await handleMigrate(request, env);
        assert.equal(res.status, 503);
    });

    it('should return 400 when userId not provided', async () => {
        const env = { MIGRATION_SECRET: 'secret123', KV_LINE_STORAGE: createMockKV() };
        const request = new Request('http://localhost/admin/migrate?key=secret123');
        const res = await handleMigrate(request, env);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('userId'));
    });
});

describe('handleMigrate - Functionality', () => {
    it('should accept correct key and migrate user', async () => {
        const kv = createMockKV({});
        const env = { MIGRATION_SECRET: 'secret123', KV_LINE_STORAGE: kv };
        const request = new Request('http://localhost/admin/migrate?key=secret123&userId=Umigrate1');

        const res = await handleMigrate(request, env);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.ok(Array.isArray(body.logs));
    });

    it('should handle rollback mode', async () => {
        const kv = createMockKV({});
        const env = { MIGRATION_SECRET: 'secret123', KV_LINE_STORAGE: kv };
        const request = new Request('http://localhost/admin/migrate?key=secret123&userId=Urollback1&mode=rollback');

        const res = await handleMigrate(request, env);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
    });

    it('should migrate user with access tokens', async () => {
        const kv = createMockKV({
            'access_tokens_Ufull': JSON.stringify({
                'MyBot': {
                    token: 'tok_123',
                    destination: 'Cbot_dest_1',
                    displayName: 'Test Bot'
                }
            }),
            'current_token_Ufull': 'MyBot'
        });
        const env = { MIGRATION_SECRET: 'correct', KV_LINE_STORAGE: kv };
        const request = new Request('http://localhost/admin/migrate?key=correct&userId=Ufull');

        const res = await handleMigrate(request, env);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);

        // Verify bot info was created
        const botInfo = await kv.get('bot:Cbot_dest_1:info', { type: 'json' });
        assert.ok(botInfo);
        assert.equal(botInfo.botId, 'Cbot_dest_1');
        assert.equal(botInfo.createdBy, 'Ufull');

        // Verify permissions were created
        const perms = await kv.get('bot:Cbot_dest_1:permissions', { type: 'json' });
        assert.ok(perms);
        assert.equal(perms.users[0].userId, 'Ufull');
        assert.equal(perms.users[0].role, 'owner');

        // Verify user bots list
        const userBots = await kv.get('user:Ufull:bots', { type: 'json' });
        assert.ok(userBots);
        assert.equal(userBots.bots.length, 1);
        assert.equal(userBots.currentBotId, 'Cbot_dest_1');
    });
});
