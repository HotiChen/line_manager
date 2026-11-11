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

    it('沒有任何 env 可以把 legacy 寫進 wrangler.jsonc', () => {
        // wrangler.jsonc 的 vars 是**部署**出去的值，不是本機的值。
        // 2026-11-11 量到的實況：線上兩個 worker 對沒帶身分的請求回 401，
        // 帶一個隨手編的 X-User-Id 就回 200 —— legacy 的行為真的在線上開著，
        // 而 dev worker 當時綁的是正式 namespace，等於 845 筆會員個資只隔著
        // 一個「知道 owner 的 userId」。
        //
        // legacy 只該存在於跑在本機的那個 process。那是 .dev.vars 的職責
        // （已被 .gitignore 擋住），不是 wrangler.jsonc 的。
        for (const [name, scope] of Object.entries(readWranglerConfig().env || {})) {
            assert.notEqual(scope.vars && scope.vars.AUTH_MODE, 'legacy',
                `env.${name} 的 AUTH_MODE 是 legacy，部署出去會接受自報的 X-User-Id；`
                + '本機要用 legacy 請寫進 .dev.vars');
        }
    });

    it('prod 的 vars 也不可以是 legacy', () => {
        assert.notEqual(readWranglerConfig().vars.AUTH_MODE, 'legacy');
    });
});

describe('wrangler.jsonc — MOUNT_PATH 與 routes 必須一致', () => {
    // 這兩個分開設定，但必須講同一件事。不一致時每個請求都會 404 —— route
    // 把 /lm/x 送進來，worker 卻以為自己掛在別的地方、切不掉前綴，於是
    // 路由表比對不到、靜態資源 key 也對不上。沒有任何程式碼會報錯。
    it('每條 route 的路徑前綴都要等於 MOUNT_PATH', () => {
        const cfg = readWranglerConfig();
        const mount = cfg.vars.MOUNT_PATH || '';

        for (const route of cfg.routes || []) {
            const pattern = typeof route === 'string' ? route : route.pattern;
            const path = pattern.replace(/^[^/]*/, '');       // 去掉 host
            const prefix = path.replace(/\*+$/, '')           // 去掉結尾的 *
                .replace(/\/$/, '');                          // 去掉結尾的 /

            assert.equal(prefix, mount,
                `route "${pattern}" 的前綴是 "${prefix}"，但 MOUNT_PATH 是 "${mount}"`);
        }
    });

    it('有 route 時 MOUNT_PATH 不可為空，否則前綴不會被切掉', () => {
        const cfg = readWranglerConfig();
        if ((cfg.routes || []).length > 0) {
            assert.ok(cfg.vars.MOUNT_PATH, '設了 route 卻沒設 MOUNT_PATH');
        }
    });

    it('route 的 pattern 要用 /lm* 而不是 /lm/*', () => {
        // /lm/* 不會匹配沒有尾斜線的 /lm，於是那個網址會落到 WordPress，
        // 而我們的 301 永遠沒機會執行。
        const cfg = readWranglerConfig();
        for (const route of cfg.routes || []) {
            const pattern = typeof route === 'string' ? route : route.pattern;
            assert.ok(!pattern.endsWith('/*'),
                `route "${pattern}" 以 /* 結尾，沒有尾斜線的網址不會進到這個 worker`);
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
