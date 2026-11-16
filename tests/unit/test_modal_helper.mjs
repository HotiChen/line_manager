/**
 * Unit Tests — helper/modal.helper.js 的 HTML 組裝
 *
 * 問題：showConfirm 把 title / message / 按鈕文字直接插進 HTML 樣板，再交給
 * setInnerHTML。呼叫端會傳入使用者可控的資料（例如 LINE 顯示名稱、標籤名稱）：
 * 「確定要刪除會員「${member.name}」嗎？」。DOMPurify 會擋掉腳本，但仍可注入
 * 連結、圖片、版面（HTML 注入），而且依賴 CDN 上的 DOMPurify 是否載入。
 *
 * 修法：在樣板組裝這一層就把所有文字欄位跳脫。28 個呼叫點全是純文字（換行靠
 * white-space: pre-line），沒有任何呼叫端依賴 HTML。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHTML } from '../../helper/security.js';
import { buildConfirmModalHTML } from '../../helper/modal.helper.js';

const base = { modalId: 'confirm-modal-1', title: '標題', message: '內容', confirmText: '確定', cancelText: '取消', type: 'warning' };
const IMG = '<img src=x onerror="alert(1)">';

describe('escapeHTML', () => {
    it('跳脫 & < > " \' 五個字元', () => {
        assert.equal(escapeHTML(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    });

    it('非字串也不會炸', () => {
        assert.equal(escapeHTML(42), '42');
        assert.equal(escapeHTML(null), 'null');
    });

    it('一般中文與全形標點原樣保留', () => {
        assert.equal(escapeHTML('確定要刪除「王小明」嗎？'), '確定要刪除「王小明」嗎？');
    });
});

describe('buildConfirmModalHTML — 跳脫', () => {
    for (const field of ['title', 'message', 'confirmText', 'cancelText']) {
        it(`${field} 含 HTML 時被跳脫，不會生出節點`, () => {
            const html = buildConfirmModalHTML({ ...base, [field]: IMG });
            assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), '應出現跳脫後的文字');
            assert.ok(!html.includes('<img'), '不可出現真正的 <img');
        });
    }

    it('message 含連結與標籤也只當文字', () => {
        const html = buildConfirmModalHTML({ ...base, message: '<a href="https://evil.example">點我</a><script>1</script>' });
        assert.ok(!html.includes('<a href'));
        assert.ok(!html.includes('<script'));
    });

    it('title 含引號與角括號，不會破壞周圍的屬性', () => {
        const html = buildConfirmModalHTML({ ...base, title: `"><img src=x>` });
        assert.ok(!html.includes('<img'));
        assert.match(html, /aria-labelledby="confirm-modal-1Label"/);
    });

    it('訊息裡的換行保留（靠 white-space: pre-line 顯示）', () => {
        const html = buildConfirmModalHTML({ ...base, message: '第一行\n第二行' });
        assert.ok(html.includes('第一行\n第二行'));
        assert.match(html, /white-space:\s*pre-line/);
    });

    it('正常的中文訊息原樣出現', () => {
        const html = buildConfirmModalHTML({ ...base, message: '確定要刪除會員「王小明」嗎？' });
        assert.ok(html.includes('確定要刪除會員「王小明」嗎？'));
    });

    it('會員顯示名稱是攻擊字串時，整個訊息仍是純文字', () => {
        const name = '<svg onload=alert(1)>';
        const html = buildConfirmModalHTML({ ...base, message: `確定要刪除會員「${name}」嗎？` });
        assert.ok(!html.includes('<svg'));
        assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
    });
});

describe('buildConfirmModalHTML — 結構', () => {
    it('保留呼叫端依賴的 data-action 與 id', () => {
        const html = buildConfirmModalHTML(base);
        assert.match(html, /id="confirm-modal-1"/);
        assert.match(html, /data-action="confirm"/);
        assert.match(html, /data-action="cancel"/);
    });

    it('type 對應按鈕樣式，未知值退回 warning', () => {
        assert.match(buildConfirmModalHTML({ ...base, type: 'danger' }), /btn btn-danger/);
        assert.match(buildConfirmModalHTML({ ...base, type: 'info' }), /btn btn-info/);
        assert.match(buildConfirmModalHTML({ ...base, type: 'x" onclick="evil' }), /btn btn-warning/);
        assert.doesNotMatch(buildConfirmModalHTML({ ...base, type: 'x" onclick="evil' }), /onclick/);
    });
});
