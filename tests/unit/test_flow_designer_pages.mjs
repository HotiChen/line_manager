/**
 * Static Tests — Flow Designer 頁面（Phase 0）
 *
 * 1. 每個編輯器頁面都有「草圖模式（目前儲存的流程不會被執行）」提示（C1：目前沒有執行引擎，
 *    存檔顯示成功但不會對任何 LINE 使用者產生效果，使用者必須知道）。
 *    提示是靜態標記，不經 innerHTML，深色模式下也要有對比。
 * 2. React / React-DOM / ReactFlow 的 CDN 標籤已移除（沒有任何程式使用，而且 unpkg 沒鎖版本）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const NOTICE = '草圖模式（目前儲存的流程不會被執行）';

// 真正放編輯器的頁面。flow_editor.html 只是包 iframe 的外殼，內容就是 flow_designer_full.html
const EDITOR_PAGES = ['pages/flow_designer_full.html', 'pages/flow_designer.html'];

describe('草圖模式提示', () => {
    for (const page of EDITOR_PAGES) {
        it(`${page} 有提示，且是 HTML 裡的靜態文字`, () => {
            const html = read(page);
            // runScripts 預設關閉：只解析標記，確認「不靠 JS」就在那裡
            const doc = new JSDOM(html).window.document;
            const el = doc.getElementById('draft-mode-notice');
            assert.ok(el, '找不到 #draft-mode-notice');
            assert.equal(el.textContent.replace(/\s+/g, ' ').trim(), NOTICE);
            assert.equal(el.getAttribute('role'), 'note');
        });

        it(`${page} 的提示不攔截操作、深色模式有對應色彩`, () => {
            const html = read(page);
            const rule = html.match(/\.draft-mode-notice\s*\{([^}]*)\}/);
            assert.ok(rule, '找不到 .draft-mode-notice 樣式');
            assert.match(rule[1], /pointer-events:\s*none/);

            const dark = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\.draft-mode-notice\s*\{([^}]*)\}/);
            assert.ok(dark, '缺少深色模式樣式');
            assert.match(dark[1], /background:/);
            assert.match(dark[1], /color:/);
        });
    }

    it('flow_editor.html 包的是 flow_designer_full.html（提示在 iframe 內顯示）', () => {
        assert.match(read('pages/flow_editor.html'), /<iframe[^>]+flow_designer_full\.html/);
    });

    it('提示文字不是 JS 動態塞進去的（避免 innerHTML）', () => {
        for (const file of ['js/flow_designer.js', 'js/flow_node_adapter.js', 'js/flow_editor.js']) {
            assert.ok(!read(file).includes('draft-mode-notice'), `${file} 不該動態產生提示`);
        }
    });
});

describe('React CDN 已移除', () => {
    for (const page of [...EDITOR_PAGES, 'pages/flow_editor.html']) {
        it(`${page} 沒有 React / ReactFlow 的 script 或 stylesheet`, () => {
            const html = read(page);
            assert.ok(!/<(script|link)\b[^>]*(react|reactflow)/i.test(html), '仍載入 React 相關資源');
            assert.ok(!/unpkg\.com/i.test(html), '仍從未鎖版本的 unpkg 載入');
            assert.ok(!/\.react-flow__/.test(html), '殘留 .react-flow__ 樣式');
        });
    }

    it('前端 JS 沒有任何地方使用 React / ReactFlow', () => {
        for (const file of ['js/flow_designer.js', 'js/flow_node_adapter.js', 'js/flow_designer_data_loader.js', 'js/flow_editor.js']) {
            assert.ok(!/\bReact(Flow|DOM)?\b|reactflow/.test(read(file)), `${file} 還在提到 React`);
        }
    });

    it('編輯器仍載入必要的 DOMPurify 與 Bootstrap（沒有誤刪）', () => {
        const html = read('pages/flow_designer_full.html');
        assert.match(html, /dompurify@3\.0\.6\/dist\/purify\.min\.js/);
        assert.match(html, /bootstrap@5\.3\.0\/dist\/js\/bootstrap\.bundle\.min\.js/);
        assert.match(html, /import \{ pageInit \} from '\.\.\/js\/flow_designer\.js'/);
    });
});
