/**
 * Unit Tests — Bridge 的 import 邊界（LM-1A，兩層防線的第一層；第二層是 eslint.config.js）
 *
 *   (i)  bridge/ 以外的檔案不得 import bridge/（只有 worker_src/index.js 例外）
 *   (ii) bridge/*.js 只能 import 兄弟檔、lm_service.js 與明確放行的共用模組
 *
 * 後半段用合成的違規原始碼測檢查器本身：檢查器若壞了，上面的掃描會「永遠綠燈」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpecifiers, checkFile, scanWorkerSrc } from '../helpers/import_boundary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('worker_src 實際的 import 邊界', () => {
    const { files, violations } = scanWorkerSrc(ROOT);

    it('有掃到檔案（不是空跑）', () => {
        assert.ok(files > 30, `只掃到 ${files} 個檔案`);
    });

    it('沒有任何違規', () => {
        assert.deepEqual(violations, [], violations.map((v) => `${v.file}: ${v.message}`).join('\n'));
    });
});

describe('extractSpecifiers', () => {
    it('抓得到各種 import 形式', () => {
        const src = `
import a from "./a.js";
import { b,
  c } from '../b.js';
import * as d from "./d.js";
import "./side.js";
export { e } from "./e.js";
export * from "./f.js";
const g = await import("./g.js");
`;
        assert.deepEqual(extractSpecifiers(src).sort(), ['../b.js', './a.js', './d.js', './e.js', './f.js', './g.js', './side.js']);
    });

    it('忽略註解裡的 import', () => {
        const src = `
// import x from "./nope.js";
/* import y from "./nope2.js"; */
/**
 * import z from "./nope3.js"
 */
import ok from "./ok.js";
`;
        assert.deepEqual(extractSpecifiers(src), ['./ok.js']);
    });
});

describe('checkFile — 規則 (ii)：bridge 內部的 import', () => {
    it('擋下直接 import LM 內部（bot_store）', () => {
        const v = checkFile('worker_src/bridge/messages.js', 'import { openBotStoreForBot } from "../lib/bot_store.js";');
        assert.equal(v.length, 1);
        assert.equal(v[0].rule, 'bridge-allowlist');
        assert.equal(v[0].specifier, '../lib/bot_store.js');
    });

    for (const spec of [
        '../lib/bot_context.js',
        '../lib/token_store.js',
        '../middleware/permission.js',
        '../middleware/auth.js',
        '../handler/team.js',
        '../index.js',
        '../lib/quota.js',
        './sub/deep.js',
        '../bridge/../lib/bot_store.js',
        '@cloudflare/kv-asset-handler',
    ]) {
        it(`擋下 ${spec}`, () => {
            assert.equal(checkFile('worker_src/bridge/x.js', `import q from "${spec}";`).length, 1);
        });
    }

    it('擋下動態 import 與 export-from', () => {
        assert.equal(checkFile('worker_src/bridge/x.js', 'const m = await import("../lib/bot_store.js");').length, 1);
        assert.equal(checkFile('worker_src/bridge/x.js', 'export { a } from "../handler/team.js";').length, 1);
    });

    for (const spec of [
        './auth.js',
        './quota.js',
        '../lm_service.js',
        '../lib/line_api.js',
        '../lib/crypto_util.js',
        '../lib/kv_schema.js',
        '../lib/utils.js',
        '../middleware/rate_limiter.js',
    ]) {
        it(`放行 ${spec}`, () => {
            assert.deepEqual(checkFile('worker_src/bridge/x.js', `import q from "${spec}";`), []);
        });
    }
});

describe('checkFile — 規則 (i)：LM core 不得 import bridge/', () => {
    it('擋下 handler 的 import', () => {
        const v = checkFile('worker_src/handler/team.js', 'import y from "../bridge/auth.js";');
        assert.equal(v.length, 1);
        assert.equal(v[0].rule, 'bridge-private');
    });

    it('擋下根目錄檔案（非 index.js）與 lib、middleware', () => {
        assert.equal(checkFile('worker_src/lm_service.js', 'import y from "./bridge/auth.js";').length, 1);
        assert.equal(checkFile('worker_src/lib/utils.js', 'import y from "../bridge/quota.js";').length, 1);
        assert.equal(checkFile('worker_src/middleware/auth.js', 'export * from "../bridge/index.js";').length, 1);
    });

    it('worker_src/index.js 是 composition root，可以 import bridge/', () => {
        assert.deepEqual(checkFile('worker_src/index.js', 'import { handleBridge } from "./bridge/index.js";'), []);
    });

    it('無關的 import 不誤報', () => {
        assert.deepEqual(checkFile('worker_src/handler/team.js', 'import y from "../lib/bridgeish.js";'), []);
    });
});
