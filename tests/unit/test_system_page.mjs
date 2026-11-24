/**
 * Static Tests — 系統管理頁（pages/system_management.html + js/system_management.js）
 *
 * 前端沒有瀏覽器測試環境，這裡釘住「不可退步」的規則：
 *   - 專案規定：前端不可新增裸 innerHTML 賦值
 *   - API key 只在建立／輪替當下顯示一次：不寫進 localStorage / sessionStorage / console
 *   - JS 取用的每個 id 都真的存在於 HTML（改一邊忘了另一邊是這類頁面最常見的壞法）
 *   - 導覽有入口，並用相對路徑（掛在 /lm/ 底下）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** 註解不算程式：說明文字提到「不寫 localStorage」不該讓檢查誤判 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const htmlPath = 'pages/system_management.html';
const jsPath = 'js/system_management.js';

describe('檔案與接線', () => {
    it('頁面與腳本都存在', () => {
        assert.ok(existsSync(join(root, htmlPath)));
        assert.ok(existsSync(join(root, jsPath)));
    });

    it('腳本匯出 pageInit（loadPage 會呼叫）', () => {
        assert.match(read(jsPath), /export\s+(async\s+)?function\s+pageInit/);
    });

    it('側邊欄有入口，data-page 對應檔名', () => {
        assert.match(read('index.html'), /data-page="system_management"/);
    });

    it('腳本 import 的相對路徑都存在', () => {
        const js = read(jsPath);
        for (const m of js.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
            assert.ok(existsSync(join(root, 'js', m[1])), `找不到 ${m[1]}`);
        }
    });

    it('不使用 / 開頭的絕對路徑 import（掛在 /lm/ 底下會壞）', () => {
        assert.doesNotMatch(read(jsPath), /from\s+'\/[^']/);
    });
});

describe('安全規則', () => {
    const js = stripComments(read(jsPath));
    const html = read(htmlPath);

    it('沒有 innerHTML / outerHTML / insertAdjacentHTML / document.write', () => {
        assert.doesNotMatch(js, /\.innerHTML\s*=/);
        assert.doesNotMatch(js, /\.outerHTML\s*=/);
        assert.doesNotMatch(js, /insertAdjacentHTML/);
        assert.doesNotMatch(js, /document\.write/);
    });

    it('API key 不落地：不碰 localStorage / sessionStorage / indexedDB', () => {
        assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/);
    });

    it('不把東西印到 console（key 與回應不可進 log）', () => {
        assert.doesNotMatch(js, /console\.(log|info|debug)/);
    });

    it('HTML 沒有行內事件處理器或行內 script', () => {
        assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
        assert.doesNotMatch(html, /<script/i);
    });

    it('key 顯示欄位是唯讀，且關閉對話框時會清掉', () => {
        assert.match(html, /id="system-key-value"[^>]*readonly/);
        assert.match(js, /hidden\.bs\.modal/);
        assert.match(js, /system-key-value[\s\S]{0,400}value\s*=\s*''/);
    });

    it('提醒金鑰只會顯示一次', () => {
        assert.match(html, /只會顯示這一次|只顯示一次|只會出現一次/);
    });
});

describe('id 一致性', () => {
    const js = read(jsPath);
    const html = read(htmlPath);
    const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    // 頁面用 byId('x') 小工具包 getElementById，兩種寫法都算
    const usedIds = [...js.matchAll(/(?:getElementById|byId)\('([^']+)'\)/g)].map((m) => m[1]);

    it('JS 有取用 id（不是空檔案）', () => {
        assert.ok(usedIds.length >= 5);
    });

    for (const id of new Set(usedIds)) {
        it(`#${id} 存在於 HTML`, () => {
            assert.ok(htmlIds.has(id), `HTML 缺少 id="${id}"`);
        });
    }

    it('HTML 沒有重複的 id', () => {
        const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(all.length, new Set(all).size);
    });
});

describe('呼叫的 API', () => {
    const js = stripComments(read(jsPath));

    it('只打 /bridge/v1/systems、/bridge/v1/admin/links（LM-2A 已連結的產品）、/bridge/v1/admin/event-fallbacks（LM-4B 備用訊息）、/bridge/v1/admin/identity（LM-4C 身分設定）與 /team/members', () => {
        const paths = [...js.matchAll(/'(\/[a-z0-9/_${}.-]+)'|`(\/[a-z0-9/_${}.-]+)`/gi)].map((m) => m[1] || m[2]);
        for (const p of paths) {
            assert.ok(
                p.startsWith('/bridge/v1/systems') || p.startsWith('/bridge/v1/admin/links') || p.startsWith('/bridge/v1/admin/event-fallbacks') || p.startsWith('/bridge/v1/admin/identity') || p.startsWith('/team/members'),
                `意外的路徑 ${p}`
            );
        }
    });

    it('路徑中的系統代號有 encodeURIComponent', () => {
        assert.match(js, /encodeURIComponent/);
    });
});

describe('入口預設隱藏，由 /features 決定是否顯示（LM-1A）', () => {
    it('側邊欄的 system_management 那個 <li> 預設帶 d-none', () => {
        const m = read('index.html').match(/<li class="([^"]*)">\s*<a [^>]*data-page="system_management"/);
        assert.ok(m, '找不到 system_management 的 <li>');
        assert.ok(m[1].split(/\s+/).includes('d-none'), `<li class="${m[1]}"> 缺 d-none`);
    });

    it('main.js 呼叫 /features，且只在 bridge === true 時才移除 d-none', () => {
        const js = stripComments(read('js/main.js'));
        assert.match(js, /['"`]\/features['"`]/);
        assert.match(js, /bridge\s*===\s*true/);
        assert.match(js, /system_management/);
        assert.match(js, /classList\.remove\(\s*['"]d-none['"]\s*\)/);
    });

    it('/features 失敗不會讓初始化中斷（有 catch）', () => {
        const js = stripComments(read('js/main.js'));
        const fn = js.match(/async function \w*[Ff]eature\w*[\s\S]*?\n}\n/);
        assert.ok(fn, '找不到功能探測函式');
        assert.match(fn[0], /try\s*\{[\s\S]*catch/);
    });
});
