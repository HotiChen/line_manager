/**
 * Unit Tests - lib/kv_schema.js
 * 測試 KV Key 生成規則
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    KV_PREFIX,
    BotKeys,
    UserKeys,
    InviteKeys,
    LegacyKeys
} from '../../worker_src/lib/kv_schema.js';

describe('KV_PREFIX', () => {
    it('should have correct prefix values', () => {
        assert.equal(KV_PREFIX.BOT, 'bot');
        assert.equal(KV_PREFIX.USER, 'user');
        assert.equal(KV_PREFIX.INVITE, 'invite');
        assert.equal(KV_PREFIX.LEGACY, 'legacy');
    });
});

describe('BotKeys', () => {
    const botId = 'bot_test_123';

    it('should generate correct info key', () => {
        assert.equal(BotKeys.info(botId), 'bot:bot_test_123:info');
    });

    it('should generate correct permissions key', () => {
        assert.equal(BotKeys.permissions(botId), 'bot:bot_test_123:permissions');
    });

    it('should generate correct keywords key', () => {
        assert.equal(BotKeys.keywords(botId), 'bot:bot_test_123:keywords');
    });

    it('should generate correct flexList key', () => {
        assert.equal(BotKeys.flexList(botId), 'bot:bot_test_123:flex_list');
    });

    it('should generate correct imagemaps key', () => {
        assert.equal(BotKeys.imagemaps(botId), 'bot:bot_test_123:imagemaps');
    });

    it('should generate correct tags key', () => {
        assert.equal(BotKeys.tags(botId), 'bot:bot_test_123:tags');
    });

    it('should generate correct members key', () => {
        assert.equal(BotKeys.members(botId), 'bot:bot_test_123:members');
    });

    it('should generate correct quickReplies key', () => {
        assert.equal(BotKeys.quickReplies(botId), 'bot:bot_test_123:quick_replies');
    });

    it('should handle special characters in botId', () => {
        const specialId = 'U123abc-def_456';
        assert.equal(BotKeys.info(specialId), 'bot:U123abc-def_456:info');
    });
});

describe('UserKeys', () => {
    const userId = 'Uabc123';

    it('should generate correct bots key', () => {
        assert.equal(UserKeys.bots(userId), 'user:Uabc123:bots');
    });

    it('should generate correct profile key', () => {
        assert.equal(UserKeys.profile(userId), 'user:Uabc123:profile');
    });
});

describe('InviteKeys', () => {
    it('should generate correct token key', () => {
        const token = 'abc123xyz';
        assert.equal(InviteKeys.token(token), 'invite:abc123xyz');
    });
});

describe('LegacyKeys', () => {
    const userId = 'Ulegacy001';

    it('should generate correct legacy keywords key', () => {
        assert.equal(LegacyKeys.userKeywords(userId), 'legacy:user:Ulegacy001:keywords');
    });

    it('should generate correct legacy flexList key', () => {
        assert.equal(LegacyKeys.userFlexList(userId), 'legacy:user:Ulegacy001:flex_list');
    });
});
