/**
 * Static Tests — 會員頁的「產生／清除測試會員」按鈕接線
 *
 * 前端沒有瀏覽器測試環境，這裡釘住：按鈕存在、id 對得上、打對的端點、
 * 確認對話框的文字是固定字串（showConfirm 會把訊息當 HTML 插入，不可帶入資料）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'pages/member_builder.html'), 'utf8');
const js = readFileSync(join(root, 'js/member_builder.js'), 'utf8');

describe('會員頁測試會員按鈕', () => {
    it('HTML 有兩個按鈕，且 id 唯一', () => {
        assert.equal([...html.matchAll(/id="seed-demo-btn"/g)].length, 1);
        assert.equal([...html.matchAll(/id="clear-demo-btn"/g)].length, 1);
    });

    it('JS 用同樣的 id 綁定事件', () => {
        assert.match(js, /getElementById\('seed-demo-btn'\)/);
        assert.match(js, /getElementById\('clear-demo-btn'\)/);
    });

    it('打 /member/demo/seed 與 /member/demo/clear', () => {
        assert.match(js, /api\.post\('\/member\/demo\/seed'/);
        assert.match(js, /api\.post\('\/member\/demo\/clear'/);
    });

    it('清除前有危險確認；產生前也有確認', () => {
        assert.match(js, /confirmDanger\('只會刪除/);
        assert.match(js, /confirmInfo\(\s*'會產生 10 筆/);
    });

    it('新增的兩個確認對話框，訊息是固定字串（showConfirm 會把訊息當 HTML 插入）', () => {
        const start = js.indexOf('async function seedDemoMembers');
        const end = js.indexOf('/**', js.indexOf('async function clearDemoMembers'));
        assert.ok(start > 0 && end > start);
        const mine = js.slice(start, end);
        const calls = [...mine.matchAll(/confirm(?:Danger|Info)\(\s*('(?:[^'\\]|\\.)*'|`[^`]*`)/g)];
        assert.equal(calls.length, 2);
        for (const m of calls) assert.doesNotMatch(m[1], /\$\{/, '訊息不可插入變數');
    });

    it('新增的函式沒有使用 innerHTML', () => {
        const start = js.indexOf('async function seedDemoMembers');
        const end = js.indexOf('async function clearDemoMembers');
        assert.ok(start > 0 && end > start);
        assert.doesNotMatch(js.slice(start, end + 900), /innerHTML/);
    });
});
