/**
 * Unit Tests — Flow Designer 前端結構守門（靜態掃描原始碼，不需瀏覽器）
 *
 *   1. 不可有 inline on* 事件：setInnerHTML 的 DOMPurify 會把它們剝掉，按鈕會變成點了沒反應
 *   2. 每個 data-on 用到的動作都在 actions.js 白名單裡；白名單呼叫的方法都真的存在
 *   3. 拆出去的 mixin 之間沒有同名方法；主檔維持精簡；模組不依賴全域 window.flowDesigner
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, parseOn } from '../../js/flow/designer/actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESIGNER_DIR = path.join(ROOT, 'js/flow/designer');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const designerFiles = readdirSync(DESIGNER_DIR).filter((f) => f.endsWith('.js')).map((f) => `js/flow/designer/${f}`);
const SCANNED = ['js/flow_designer.js', 'pages/flow_designer_full.html', ...designerFiles];

/** class 內 4 格縮排的方法宣告 */
function methodNames(src) {
    const names = [];
    for (const m of src.matchAll(/^ {4}(?:async )?(?:get |set )?([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{\s*$/gm)) {
        if (!['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(m[1])) names.push(m[1]);
    }
    return names;
}

describe('inline 事件', () => {
    for (const file of SCANNED) {
        it(`${file} 沒有 inline on* 屬性`, () => {
            // (?<![\w-]) 排除 data-on=；只抓 HTML 屬性形式 on<event>="..."
            const hits = [...read(file).matchAll(/(?<![\w-])on[a-z]+\s*=\s*["']/g)]
                .map((m) => m[0])
                .filter((s) => !/^one?\b/.test(s)); // 保守：避免誤判
            assert.deepEqual(hits, []);
        });
    }
});

describe('data-on 白名單', () => {
    it('每個 data-on 用到的動作都在 ACTIONS 裡', () => {
        const unknown = [];
        for (const file of SCANNED) {
            const code = read(file).replace(/^\s*(\/\/|\*).*$/gm, ''); // 註解（含 JSDoc）裡的範例不算
            for (const m of code.matchAll(/data-on="([^"]+)"/g)) {
                for (const pair of m[1].split(/\s+/)) {
                    const action = pair.split(':')[1];
                    if (!Object.hasOwn(ACTIONS, action)) unknown.push(`${file}: ${pair}`);
                }
            }
        }
        assert.deepEqual(unknown, []);
    });

    it('ACTIONS 呼叫的 fd.方法 都定義在某個 designer 模組', () => {
        const defined = new Set(designerFiles.flatMap((f) => methodNames(read(f))));
        const actionsSrc = read('js/flow/designer/actions.js');
        const called = [...actionsSrc.matchAll(/\bfd\.([A-Za-z_]\w*)\(/g)].map((m) => m[1]);
        assert.ok(called.length > 20);
        const missing = called.filter((n) => !defined.has(n));
        assert.deepEqual(missing, []);
    });

    it('parseOn 忽略白名單外的動作與壞格式', () => {
        assert.deepEqual(parseOn('click:undo load:drawImagemapAreas'), [['click', 'undo'], ['load', 'drawImagemapAreas']]);
        assert.deepEqual(parseOn('click:alert click:constructor click:__proto__ :undo click: x'), []);
        assert.deepEqual(parseOn(undefined), []);
    });

    it('ACTIONS 是凍結的', () => {
        assert.ok(Object.isFrozen(ACTIONS));
    });
});

describe('模組結構', () => {
    it('mixin 之間沒有同名方法', () => {
        const owner = new Map();
        const dupes = [];
        for (const f of designerFiles) {
            for (const n of methodNames(read(f))) {
                if (owner.has(n)) dupes.push(`${n}: ${owner.get(n)} & ${f}`);
                owner.set(n, f);
            }
        }
        assert.deepEqual(dupes, []);
    });

    it('每個 mixin 檔都有被主檔組裝', () => {
        const main = read('js/flow_designer.js');
        const mixinFiles = designerFiles.filter((f) => /export class \w+Methods/.test(read(f)));
        assert.ok(mixinFiles.length >= 8);
        for (const f of mixinFiles) {
            const cls = read(f).match(/export class (\w+Methods)/)[1];
            assert.match(main, new RegExp(`DESIGNER_MIXINS = \\[[\\s\\S]*\\b${cls}\\b`), `${cls} 沒有列在 DESIGNER_MIXINS`);
        }
    });

    it('主檔維持精簡（< 400 行）', () => {
        assert.ok(read('js/flow_designer.js').split('\n').length < 400);
    });

    it('designer 模組不依賴全域 flowDesigner', () => {
        for (const f of designerFiles) {
            const code = read(f).replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(code, /(?<![\w.])flowDesigner\./, f);
        }
    });
});
