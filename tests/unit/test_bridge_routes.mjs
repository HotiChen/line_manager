/**
 * Unit Tests — /api/v1/* 的路由分類
 *
 * index.js 在 Workers 環境才載得進來，所以分類邏輯放在 auth_routes.js 單獨測。
 *
 *   /api/v1/systems*   人主體（LIFF）—— 發 key 只能由人操作，key 不能發 key
 *   其他 /api/v1/*     系統主體（service key）
 *
 * 兩邊都不是公開路徑：/api/v1 絕不可出現在 PUBLIC_PATHS。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiresAuthentication, isBridgeServiceRoute } from '../../worker_src/middleware/auth_routes.js';

describe('isBridgeServiceRoute', () => {
    it('/api/v1/messages/* 是系統路由', () => {
        assert.equal(isBridgeServiceRoute('/api/v1/messages/push'), true);
        assert.equal(isBridgeServiceRoute('/api/v1/messages/multicast'), true);
    });

    it('/api/v1/systems 與其子路徑是人主體，不是系統路由', () => {
        assert.equal(isBridgeServiceRoute('/api/v1/systems'), false);
        assert.equal(isBridgeServiceRoute('/api/v1/systems/imgpicker'), false);
        assert.equal(isBridgeServiceRoute('/api/v1/systems/imgpicker/keys/rotate'), false);
    });

    it('前綴相似但不同的路徑不誤判', () => {
        assert.equal(isBridgeServiceRoute('/api/v1'), false);
        assert.equal(isBridgeServiceRoute('/api/v10/messages'), false);
        assert.equal(isBridgeServiceRoute('/api/send-message'), false);
        assert.equal(isBridgeServiceRoute('/api/webhook'), false);
        assert.equal(isBridgeServiceRoute('/api/v1systems'), false);
    });

    it('/api/v1/systemsX 不被當成 systems（它是系統路由，會被 service key 認證擋下）', () => {
        assert.equal(isBridgeServiceRoute('/api/v1/systemsX'), true);
    });
});

describe('requiresAuthentication 對 /api/v1 保持 fail-closed', () => {
    it('/api/v1/* 全部都不是公開路徑', () => {
        for (const p of [
            '/api/v1/systems',
            '/api/v1/systems/imgpicker/keys/rotate',
            '/api/v1/messages/push',
            '/api/v1/messages/multicast',
            '/api/v1/anything',
        ]) {
            assert.equal(requiresAuthentication(p), true, p);
        }
    });

    it('/api/webhook 仍然公開（有 LINE 簽章）', () => {
        assert.equal(requiresAuthentication('/api/webhook'), false);
    });
});
