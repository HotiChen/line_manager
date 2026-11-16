/**
 * Unit Tests — /bridge/v1/* 的路由分類
 *
 * index.js 在 Workers 環境才載得進來，所以分類邏輯放在 bridge/routes.js 與 auth_routes.js 單獨測。
 *
 *   /bridge/v1/systems*   人主體（LIFF）—— 發 key 只能由人操作，key 不能發 key
 *   其他 /bridge/v1/*     系統主體（service key）
 *
 * 兩邊都不是公開路徑（唯一例外是 /bridge/v1/health）：/bridge 前綴必須在 PROTECTED_PREFIXES。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiresAuthentication } from '../../worker_src/middleware/auth_routes.js';
import * as authRoutes from '../../worker_src/middleware/auth_routes.js';
import { isBridgeServiceRoute } from '../../worker_src/bridge/routes.js';

describe('isBridgeServiceRoute', () => {
    it('/bridge/v1/raw/* 是系統路由', () => {
        assert.equal(isBridgeServiceRoute('/bridge/v1/raw/push'), true);
        assert.equal(isBridgeServiceRoute('/bridge/v1/raw/multicast'), true);
    });

    it('/bridge/v1/systems 與其子路徑是人主體，不是系統路由', () => {
        assert.equal(isBridgeServiceRoute('/bridge/v1/systems'), false);
        assert.equal(isBridgeServiceRoute('/bridge/v1/systems/imgpicker'), false);
        assert.equal(isBridgeServiceRoute('/bridge/v1/systems/imgpicker/keys/rotate'), false);
    });

    it('前綴相似但不同的路徑不誤判', () => {
        assert.equal(isBridgeServiceRoute('/api/v1'), false);
        assert.equal(isBridgeServiceRoute('/api/v10/messages'), false);
        assert.equal(isBridgeServiceRoute('/api/send-message'), false);
        assert.equal(isBridgeServiceRoute('/api/webhook'), false);
        assert.equal(isBridgeServiceRoute('/api/v1systems'), false);
        assert.equal(isBridgeServiceRoute('/bridge/v1'), false);
        assert.equal(isBridgeServiceRoute('/bridge/v10/raw/push'), false);
        assert.equal(isBridgeServiceRoute('/bridgeX/v1/raw/push'), false);
    });

    it('舊的 /api/v1/* 不再是橋接路由', () => {
        assert.equal(isBridgeServiceRoute('/api/v1/messages/push'), false);
        assert.equal(isBridgeServiceRoute('/api/v1/messages/multicast'), false);
    });

    it('health 是公開端點，不走 service key', () => {
        assert.equal(isBridgeServiceRoute('/bridge/v1/health'), false);
    });

    it('已從 auth_routes.js 移除（歸 bridge/ 所有）', () => {
        assert.equal('isBridgeServiceRoute' in authRoutes, false);
    });

    it('/bridge/v1/systemsX 不被當成 systems（它是系統路由，會被 service key 認證擋下）', () => {
        assert.equal(isBridgeServiceRoute('/bridge/v1/systemsX'), true);
    });
});

describe('requiresAuthentication 對 /bridge 保持 fail-closed', () => {
    it('/bridge/v1/* 全部都不是公開路徑', () => {
        for (const p of [
            '/bridge/v1/systems',
            '/bridge/v1/systems/imgpicker/keys/rotate',
            '/bridge/v1/raw/push',
            '/bridge/v1/raw/multicast',
            '/api/v1/anything',
        ]) {
            assert.equal(requiresAuthentication(p), true, p);
        }
    });

    it('/api/webhook 仍然公開（有 LINE 簽章）', () => {
        assert.equal(requiresAuthentication('/api/webhook'), false);
    });
});

describe('requiresAuthentication — /bridge 與 /features', () => {
    it('/bridge/v1/health 是 /bridge 底下唯一公開的路徑', () => {
        assert.equal(requiresAuthentication('/bridge/v1/health'), false);
    });

    it('其他 /bridge/* 一律要認證（含長得像 health 的）', () => {
        for (const p of [
            '/bridge',
            '/bridge/',
            '/bridge/v1',
            '/bridge/v1/health/',
            '/bridge/v1/healthz',
            '/bridge/v1/health/x',
            '/bridge/v2/health',
            '/bridge/v1/anything',
            '/bridge/v1/systems',
        ]) {
            assert.equal(requiresAuthentication(p), true, p);
        }
    });

    it('/features 要 LIFF 認證', () => {
        assert.equal(requiresAuthentication('/features'), true);
    });
});
