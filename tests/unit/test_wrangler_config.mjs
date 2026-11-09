/**
 * Unit Tests — wrangler.jsonc 的部署不變量
 *
 * 這些是設定層的安全邊界，壞掉的時候沒有任何程式碼會報錯：
 *
 * 1. dev 與 prod 共用同一個 KV namespace，加上 dev 的 AUTH_MODE = "legacy"
 *    （legacy 接受自報的 X-User-Id 當身分），等於任何人在本機跑
 *    `wrangler dev --env dev` 就能用任意身分讀寫 924 筆正式資料。
 *    兩件事各自看都像設定，疊起來才是洞——所以用測試把它們釘住。
 *
 * 2. AUTH_MODE = "legacy" 只准出現在 dev。
 *
 * 3. prod 必須有 LIFF_CHANNEL_ID，否則 authenticate() 會 fail-closed 全部拒絕
 *    （見 middleware/auth.js），整個後台登不進去。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** wrangler.jsonc 允許註解與結尾逗號，JSON.parse 不吃，先剝掉 */
function readWranglerConfig() {
    const raw = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const noComments = raw
        .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
            (m) => (m.startsWith('"') ? m : ''))
        .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(noComments);
}

function kvId(scope) {
    const ns = (scope.kv_namespaces || []).find(n => n.binding === 'KV_LINE_STORAGE');
    assert.ok(ns, 'KV_LINE_STORAGE binding 不存在');
    return ns;
}

describe('wrangler.jsonc — KV namespace 隔離', () => {
    it('設定檔可以被解析', () => {
        const cfg = readWranglerConfig();
        assert.equal(typeof cfg, 'object');
        assert.ok(cfg.env && cfg.env.dev, 'dev 環境不存在');
    });

    it('dev 與 prod 不得共用同一個 KV namespace id', () => {
        const cfg = readWranglerConfig();
        const prod = kvId(cfg);
        const dev = kvId(cfg.env.dev);
        assert.notEqual(dev.id, prod.id,
            `dev 與 prod 都指向 ${prod.id}；本機 legacy 認證可直接讀寫正式資料`);
    });

    it('dev 的 preview_id 也不得指向 prod', () => {
        const cfg = readWranglerConfig();
        const prod = kvId(cfg);
        const dev = kvId(cfg.env.dev);
        if (dev.preview_id !== undefined) {
            assert.notEqual(dev.preview_id, prod.id,
                `dev preview_id 指向 prod namespace ${prod.id}`);
        }
    });
});

describe('wrangler.jsonc — AUTH_MODE', () => {
    it('prod 必須是 liff', () => {
        const cfg = readWranglerConfig();
        assert.equal(cfg.vars.AUTH_MODE, 'liff');
    });

    it('legacy 只准出現在 dev', () => {
        const cfg = readWranglerConfig();
        for (const [name, scope] of Object.entries(cfg.env || {})) {
            if (name === 'dev') continue;
            assert.notEqual(scope.vars && scope.vars.AUTH_MODE, 'legacy',
                `env.${name} 的 AUTH_MODE 是 legacy，會接受自報的 X-User-Id`);
        }
    });
});

describe('wrangler.jsonc — LIFF_CHANNEL_ID', () => {
    it('prod 與 dev 都必須設定（否則 authenticate 會全部拒絕）', () => {
        const cfg = readWranglerConfig();
        assert.ok(cfg.vars.LIFF_CHANNEL_ID, 'prod 缺 LIFF_CHANNEL_ID');
        assert.ok(cfg.env.dev.vars.LIFF_CHANNEL_ID, 'dev 缺 LIFF_CHANNEL_ID');
    });

    it('必須是 LIFF_ID 的 Channel 前綴', () => {
        // LIFF_ID 形如 "1653928585-8Kkz0jnz"，前半段就是 Channel ID。
        // 兩者對不上的話，LINE verify API 回的 client_id 永遠比對失敗。
        const cfg = readWranglerConfig();
        for (const scope of [cfg, cfg.env.dev]) {
            const [channelFromLiffId] = String(scope.vars.LIFF_ID).split('-');
            assert.equal(String(scope.vars.LIFF_CHANNEL_ID), channelFromLiffId);
        }
    });
});
