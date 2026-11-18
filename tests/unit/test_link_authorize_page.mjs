/**
 * Static Tests — 同意頁（pages/link_authorize.html + js/link_authorize.js）與後台「已連結的產品」
 *
 * 沒有瀏覽器測試環境，這裡釘住不可退步的規則；真實瀏覽器行為另有 Playwright 驗證（見 docs 的 2A-2 對照）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const htmlPath = 'pages/link_authorize.html';
const jsPath = 'js/link_authorize.js';
const helperPath = 'helper/link_authorize_form.js';

describe('同意頁：檔案與接線', () => {
  it('三個檔案都存在', () => {
    for (const p of [htmlPath, jsPath, helperPath]) assert.ok(existsSync(join(root, p)), p);
  });
  it('HTML 以相對路徑載入模組（掛在 /lm/ 底下）並載入 LIFF SDK', () => {
    const html = read(htmlPath);
    assert.match(html, /<script type="module" src="\.\.\/js\/link_authorize\.js">/);
    assert.match(html, /static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
  });
  it('JS import 的相對路徑都存在', () => {
    for (const m of read(jsPath).matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      assert.ok(existsSync(join(root, 'js', m[1])), m[1]);
    }
  });
  it('JS 取用的每個 id 都存在於 HTML，且 HTML 沒有重複 id', () => {
    const html = read(htmlPath);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, new Set(ids).size);
    const used = [...read(jsPath).matchAll(/(?:getElementById|byId)\('([^']+)'\)/g)].map((m) => m[1]);
    const stateIds = [...read(jsPath).matchAll(/'(state-[a-z]+)'/g)].map((m) => m[1]);
    assert.ok(used.length >= 8);
    for (const id of new Set([...used, ...stateIds])) assert.ok(ids.includes(id), `HTML 缺少 id="${id}"`);
  });
});

describe('同意頁：安全規則', () => {
  const html = read(htmlPath);
  const js = strip(read(jsPath));
  const helper = strip(read(helperPath));

  it('有 referrer: no-referrer meta', () => {
    assert.match(html, /<meta\s+name="referrer"\s+content="no-referrer"/);
  });
  it('防點擊劫持：HTML 與 JS 都有 top / self 檢查', () => {
    assert.match(html, /window\.top\s*!==\s*window\.self/);
    assert.match(js, /window\.top\s*===\s*window\.self/);
    assert.match(html, /請在瀏覽器直接開啟/);
  });
  it('被嵌入時 JS 在呼叫 liff 與 API 之前就返回', () => {
    const initBody = js.slice(js.indexOf('function init()'));
    assert.ok(initBody.indexOf('isTopLevel()') < initBody.indexOf('start()'));
    assert.match(initBody, /isTopLevel\(\)[\s\S]{0,200}return;/);
  });
  it('沒有裸 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function', () => {
    for (const src of [js, helper]) {
      assert.doesNotMatch(src, /\.innerHTML\s*=/);
      assert.doesNotMatch(src, /\.outerHTML\s*=/);
      assert.doesNotMatch(src, /insertAdjacentHTML|document\.write/);
      assert.doesNotMatch(src, /\beval\s*\(|new\s+Function\s*\(/);
    }
    assert.doesNotMatch(js, /setInnerHTML/); // 這一頁完全不需要
  });
  it('不印任何 console（參數、state、code 不可進 log）', () => {
    assert.doesNotMatch(js, /console\./);
    assert.doesNotMatch(helper, /console\./);
  });
  it('HTML 沒有行內事件處理器；唯一的行內 script 是 framed 檢查', () => {
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(inline.length, 1);
    assert.match(inline[0][1], /framed/);
  });
  it('產品名稱只用 textContent 顯示', () => {
    assert.match(js, /byId\('product-name'\)\.textContent\s*=/);
  });
  it('M-03：顯示回調主機名稱與授權效果；只用 textContent，不是連結（沒有 href／anchor／innerHTML）', () => {
    assert.match(js, /byId\('redirect-host'\)\.textContent\s*=\s*redirectHostLabel\(/);
    assert.match(js, /byId\('consent-notice'\)\.textContent\s*=\s*consentNotice\(/);
    // HTML：兩個容器都不是 <a>，而且元素本身沒有 href
    const host = html.match(/<(\w+)[^>]*\sid="redirect-host"[^>]*>/);
    const notice = html.match(/<(\w+)[^>]*\sid="consent-notice"[^>]*>/);
    assert.ok(host && notice);
    for (const m of [host, notice]) {
      assert.notEqual(m[1].toLowerCase(), 'a');
      assert.doesNotMatch(m[0], /href\s*=/i);
    }
    // JS 不替它們設定 href／onclick／連結
    assert.doesNotMatch(js, /redirect-host[^;]*\.(href|setAttribute)/);
    assert.doesNotMatch(js, /createElement\('a'\)/);
  });
  it('M-03：選擇官方帳號時，授權效果那一句跟著更新（含初次渲染）', () => {
    const change = js.slice(js.indexOf("byId('bot-select').addEventListener"));
    assert.match(change.slice(0, 250), /renderNotice\(\)/);
    const render = js.slice(js.indexOf('function renderConsent'), js.indexOf('// ── 動作 ──'));
    assert.match(render, /renderNotice\(\)/);
    assert.match(render, /redirectHostLabel\(view\.params/);
  });
  it('導向前一定驗證，且導向用 location.replace', () => {
    const calls = js.match(/validateRedirectTarget\(/g) || [];
    assert.ok(calls.length >= 2, 'approve 與 cancel 都要驗證');
    assert.match(js, /window\.location\.replace\(url\)/);
    assert.match(js, /navigate\(target\.url\)/);
  });
  it('只有 navigate() 一個地方會離開頁面（不繞過驗證）', () => {
    assert.equal((js.match(/location\.replace\(/g) || []).length, 1);
    assert.doesNotMatch(js, /location\.(assign|href\s*=)|window\.open/);
  });
  it('登入前存 sessionStorage 在 liff.login 之前，且存取都在 helper 的 try/catch 內', () => {
    assert.ok(js.indexOf('saveAuthParams(storage, params)') < js.indexOf('liff.login()'));
    assert.doesNotMatch(js, /sessionStorage\.(get|set|remove)Item/);
    assert.match(js, /try\s*\{\s*return window\.sessionStorage;?\s*\}\s*catch/);
  });
  it('按下同意後立即停用按鈕（busy 先於 await）', () => {
    const fn = js.slice(js.indexOf('async function onApprove'));
    assert.ok(fn.indexOf('view.busy = true') < fn.indexOf('await call('));
    assert.ok(fn.indexOf('refreshButtons()') < fn.indexOf('await call('));
  });
  it('只打三個 preview / approve 端點（沒有別的路徑）', () => {
    const paths = [...js.matchAll(/'(\/bridge\/[^']*)'|`(\/bridge\/[^`]*)`/g)].map((m) => m[1] || m[2]);
    assert.deepEqual(paths.map((p) => p.split('?')[0]).sort(), ['/bridge/v1/link/authorize/approve', '/bridge/v1/link/authorize/preview']);
  });
  it('有說明「無法取得客戶 LINE 帳號資料、無法發送任意訊息」', () => {
    assert.match(html, /此產品無法取得你的客戶的 LINE 帳號資料，也無法發送任意訊息/);
  });
  it('只有「同意」「取消」兩個按鈕', () => {
    assert.equal((html.match(/<button\b/g) || []).length, 2);
  });
  it('支援深色：prefers-color-scheme 與 data-theme', () => {
    assert.match(html, /prefers-color-scheme:\s*dark/);
    assert.match(html, /\[data-theme="dark"\]/);
  });
});

describe('後台「已連結的產品」', () => {
  const js = strip(read('js/system_management.js'));
  const html = read('pages/system_management.html');

  it('區塊存在，並有空狀態與載入中', () => {
    for (const id of ['link-section', 'link-list', 'link-empty', 'link-loading', 'link-notice']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /已連結的產品/);
  });
  it('只用 DOM 組裝與 textContent；沒有 innerHTML', () => {
    assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    assert.match(js, /h\('h5', \{ class: 'mb-0 text-break', style: 'min-width:0', text: link\.productName \}\)/);
  });
  it('列表與撤銷都帶 X-Bot-Id，路徑的 link_id 有編碼', () => {
    assert.match(js, /call\('GET', '\/bridge\/v1\/admin\/links', null, \{ 'X-Bot-Id': botId \}\)/);
    assert.match(js, /call\('DELETE', `\/bridge\/v1\/admin\/links\/\$\{encodeURIComponent\(link\.linkId\)\}`, null, \{ 'X-Bot-Id': botId \}\)/);
  });
  it('撤銷前有確認對話框並說明立即失效', () => {
    assert.match(js, /showConfirm\(\{[\s\S]{0,200}撤銷連結/);
    assert.match(js, /該產品立即無法再使用，需重新授權才能恢復/);
  });
  it('載入連結失敗被隔離：loadLinks 自己 try/catch，且排在 loadSystems 之後', () => {
    const fn = js.slice(js.indexOf('async function loadLinks'), js.indexOf('async function revokeLink'));
    assert.match(fn, /try\s*\{[\s\S]*\}\s*catch\s*\{[\s\S]*\}\s*finally/);
    const init = js.slice(js.indexOf('export async function pageInit'));
    assert.ok(init.indexOf('await loadSystems()') < init.indexOf('loadLinks()'));
    assert.doesNotMatch(init, /await loadLinks\(\)/, '不 await：連結區塊慢或失敗不能拖住頁面載入');
  });
});
