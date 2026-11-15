/**
 * Static Tests — 手機版面（index.html + js/mobile_nav.js）
 *
 * 問題：側邊欄固定 240px、主內容 margin-left: 240px，手機（約 390px 寬）上
 * 內容只剩 ~150px，而且整站沒有任何針對這個版面的斷點。
 *
 * 修法：< 992px 時側邊欄收成抽屜（漢堡按鈕開關），內容吃滿寬度。
 * 這裡不跑瀏覽器，只釘住「規則與接線還在」，避免日後被改掉又沒人發現。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** 取出 @media (max-width: 991.98px) { ... } 區塊（含巢狀大括號） */
function mobileBlock() {
    const start = html.indexOf('@media (max-width: 991.98px)');
    assert.ok(start >= 0, '缺少 @media (max-width: 991.98px)');
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth++;
        if (html[i] === '}' && --depth === 0) return html.slice(open + 1, i);
    }
    throw new Error('media block 沒有結尾');
}

describe('index.html 手機版面', () => {
    it('有 viewport meta', () => {
        assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/);
    });

    it('手機斷點下側邊欄預設收在畫面外', () => {
        assert.match(mobileBlock(), /\.sidebar-container\s*\{[^}]*transform:\s*translateX\(-100%\)/);
    });

    it('手機斷點下主內容不再保留 240px 左邊界', () => {
        assert.match(mobileBlock(), /\.main-content-area\s*\{[^}]*margin-left:\s*0/);
    });

    it('開啟狀態有對應規則', () => {
        assert.match(mobileBlock(), /sidebar-open\s+\.sidebar-container\s*\{[^}]*transform:\s*none/);
    });

    it('側邊欄寬度不會超過螢幕', () => {
        assert.match(mobileBlock(), /\.sidebar-container\s*\{[^}]*width:\s*min\(\s*280px\s*,\s*85vw\s*\)/);
    });

    it('桌機版維持 240px 側邊欄與 margin-left（不被手機規則影響）', () => {
        const desktop = html.slice(0, html.indexOf('@media (max-width: 991.98px)'));
        assert.match(desktop, /\.sidebar-container\s*\{[^}]*width:\s*240px/);
        assert.match(desktop, /\.main-content-area\s*\{[^}]*margin-left:\s*240px/);
    });

    it('有漢堡按鈕與遮罩，且按鈕有無障礙標籤', () => {
        assert.match(html, /id="mobile-nav-toggle"[^>]*aria-label=/);
        assert.match(html, /id="mobile-nav-backdrop"/);
    });

    it('有載入 mobile_nav.js', () => {
        assert.match(html, /<script[^>]+src="\.\/js\/mobile_nav\.js"/);
    });

    it('相對路徑，不可用 / 開頭（掛在 /lm/ 底下會壞）', () => {
        assert.doesNotMatch(html, /src="\/js\/mobile_nav\.js"/);
    });
});

describe('js/mobile_nav.js', () => {
    const path = join(root, 'js', 'mobile_nav.js');

    it('檔案存在', () => {
        assert.ok(existsSync(path));
    });

    it('切換 body 上的 sidebar-open，並處理遮罩、Esc、點選導覽、放大到桌機寬度', () => {
        const js = readFileSync(path, 'utf8');
        assert.match(js, /sidebar-open/);
        assert.match(js, /mobile-nav-toggle/);
        assert.match(js, /mobile-nav-backdrop/);
        assert.match(js, /Escape/);
        assert.match(js, /nav-link/);
        assert.match(js, /matchMedia|innerWidth/);
    });

    it('不使用 innerHTML（專案規定）', () => {
        const js = readFileSync(path, 'utf8');
        assert.doesNotMatch(js, /innerHTML\s*=/);
    });
});
