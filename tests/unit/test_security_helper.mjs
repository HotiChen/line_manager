/**
 * Unit Tests — helper/security.js 的 fail-closed 行為
 *
 * 背景：setInnerHTML() 有 103 個呼叫點，全部走 safeHTML()，而 safeHTML()
 * 在 window.DOMPurify 不存在時「回傳原值並警告」。DOMPurify 是 index.html
 * 從 cdnjs 載入的——CDN 掛掉、被牆、或 CSP 擋掉的那一刻，103 個注入點
 * 同時從「已消毒」變成「原始 HTML 直接寫進 DOM」，而且只有 console 一行警告。
 *
 * 消毒失敗時正確的行為是讓標記失效（逸出成純文字），不是原封不動放行。
 * 代價是 DOMPurify 缺席時畫面會顯示字面標記——看得見的壞，勝過看不見的 XSS。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalWindow = globalThis.window;

function setWindow(win) {
    globalThis.window = win;
}

async function loadSecurity() {
    // 每個 case 重新載入，避免模組快取住上一個 window 狀態
    const mod = await import(`../../helper/security.js?t=${Math.random()}`);
    return mod;
}

describe('safeHTML — DOMPurify 缺席時必須 fail-closed', () => {
    beforeEach(() => setWindow({ location: { hostname: 'localhost', origin: 'http://localhost' } }));
    afterEach(() => setWindow(originalWindow));

    it('script 標籤不得原封不動回傳', async () => {
        const { safeHTML } = await loadSecurity();
        const out = safeHTML('<script>alert(1)</script>');
        assert.ok(!out.includes('<script'), `仍含可執行標記: ${out}`);
    });

    it('img onerror 不得原封不動回傳', async () => {
        const { safeHTML } = await loadSecurity();
        const out = safeHTML('<img src=x onerror="alert(1)">');
        assert.ok(!out.includes('<img'), `仍含可執行標記: ${out}`);
    });

    it('svg onload 不得原封不動回傳', async () => {
        const { safeHTML } = await loadSecurity();
        const out = safeHTML('<svg onload=alert(1)>');
        assert.ok(!out.includes('<svg'), `仍含可執行標記: ${out}`);
    });

    it('純文字內容仍可讀（逸出不等於清空）', async () => {
        const { safeHTML } = await loadSecurity();
        assert.equal(safeHTML('王小明'), '王小明');
    });

    it('非字串輸入不得丟例外', async () => {
        const { safeHTML } = await loadSecurity();
        assert.equal(safeHTML(null), '');
        assert.equal(safeHTML(undefined), '');
    });
});

describe('safeHTML — DOMPurify 存在時照常委派', () => {
    afterEach(() => setWindow(originalWindow));

    it('回傳 DOMPurify.sanitize 的結果', async () => {
        const calls = [];
        setWindow({
            location: { hostname: 'localhost', origin: 'http://localhost' },
            DOMPurify: {
                sanitize: (html) => { calls.push(html); return '<b>safe</b>'; },
            },
        });
        const { safeHTML } = await loadSecurity();
        const out = safeHTML('<b onclick="x">safe</b>');
        assert.equal(out, '<b>safe</b>');
        assert.deepEqual(calls, ['<b onclick="x">safe</b>']);
    });

    it('不得繞過 sanitize（每次呼叫都要經過它）', async () => {
        let count = 0;
        setWindow({
            location: { hostname: 'localhost', origin: 'http://localhost' },
            DOMPurify: { sanitize: (h) => { count++; return h; } },
        });
        const { safeHTML } = await loadSecurity();
        safeHTML('<p>a</p>');
        safeHTML('<p>b</p>');
        assert.equal(count, 2);
    });
});

describe('setInnerHTML — 103 個呼叫點共用的注入路徑', () => {
    afterEach(() => setWindow(originalWindow));

    it('DOMPurify 缺席時不得把 script 寫進 DOM', async () => {
        setWindow({ location: { hostname: 'localhost', origin: 'http://localhost' } });
        const { setInnerHTML } = await loadSecurity();
        const el = { innerHTML: '' };
        setInnerHTML(el, '<script>alert(1)</script>');
        assert.ok(!el.innerHTML.includes('<script'), `寫入了可執行標記: ${el.innerHTML}`);
    });

    it('element 為 null 時安靜略過，不丟例外', async () => {
        setWindow({ location: { hostname: 'localhost', origin: 'http://localhost' } });
        const { setInnerHTML } = await loadSecurity();
        assert.doesNotThrow(() => setInnerHTML(null, '<b>x</b>'));
    });
});
