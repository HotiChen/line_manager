/**
 * Unit Tests — lib/mount.js 的子路徑掛載
 *
 * 這個 worker 原本只掛在網域根（`pinti-line.hotichen.workers.dev`），
 * 路由判斷與靜態資源查找都直接吃 `url.pathname`。掛到
 * `imhoti.tw/lm/` 之後進來的是 `/lm/member/list`，而路由表比對的是
 * `/member`，於是每個 API 請求都會掉進靜態資源分支、每個靜態資源都 404。
 *
 * 最容易出錯的兩件事，各有測試守著：
 *
 * 1. `/lm`（沒有尾斜線）必須 301 到 `/lm/`。前端的資源參照全部是相對路徑
 *    （`css/a.css`、`./js/main.js`），而相對路徑是對「當前目錄」解析的 ——
 *    在 `/lm` 底下會解析成 `/css/a.css`（WordPress 的地盤），在 `/lm/`
 *    底下才是 `/lm/css/a.css`。
 * 2. `/lmx` 不算命中。前綴比對寫成 `startsWith('/lm')` 的話，
 *    `/lmx` 會被切成 `x`，而那是個沒有人認得的路徑。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMount, stripMount } from '../../worker_src/lib/mount.js';

describe('normalizeMount', () => {
    it('沒設定時是空字串（掛在根，行為與加這個模組之前完全相同）', () => {
        assert.equal(normalizeMount(undefined), '');
        assert.equal(normalizeMount(''), '');
        assert.equal(normalizeMount(null), '');
    });

    it('「/」等同沒設定 —— 否則每個路徑都會被切掉一個斜線', () => {
        assert.equal(normalizeMount('/'), '');
    });

    it('補上開頭斜線、去掉結尾斜線', () => {
        assert.equal(normalizeMount('lm'), '/lm');
        assert.equal(normalizeMount('/lm'), '/lm');
        assert.equal(normalizeMount('/lm/'), '/lm');
        assert.equal(normalizeMount('lm/'), '/lm');
    });

    it('多層路徑也要支援', () => {
        assert.equal(normalizeMount('/apps/lm/'), '/apps/lm');
    });

    it('非字串視為沒設定', () => {
        assert.equal(normalizeMount(123), '');
        assert.equal(normalizeMount({}), '');
    });
});

describe('stripMount — 沒有掛載前綴時', () => {
    it('原樣回傳，不重導', () => {
        assert.deepEqual(stripMount('/member/list', ''), { pathname: '/member/list', redirect: null });
        assert.deepEqual(stripMount('/', ''), { pathname: '/', redirect: null });
    });
});

describe('stripMount — 掛在 /lm', () => {
    it('根要重導到帶尾斜線的版本', () => {
        assert.deepEqual(stripMount('/lm', '/lm'), { pathname: '/', redirect: '/lm/' });
    });

    it('帶尾斜線的根對應到 /', () => {
        assert.deepEqual(stripMount('/lm/', '/lm'), { pathname: '/', redirect: null });
    });

    it('API 路徑要切掉前綴，否則路由表比對不到', () => {
        assert.deepEqual(stripMount('/lm/member/list', '/lm'), { pathname: '/member/list', redirect: null });
        assert.deepEqual(stripMount('/lm/api/webhook', '/lm'), { pathname: '/api/webhook', redirect: null });
    });

    it('靜態資源路徑要切掉前綴', () => {
        assert.deepEqual(stripMount('/lm/css/animation.css', '/lm'), { pathname: '/css/animation.css', redirect: null });
        assert.deepEqual(stripMount('/lm/pages/dashboard.html', '/lm'), { pathname: '/pages/dashboard.html', redirect: null });
    });

    it('只是開頭幾個字一樣不算命中', () => {
        // startsWith('/lm') 會把這個切成 'x'
        assert.deepEqual(stripMount('/lmx', '/lm'), { pathname: '/lmx', redirect: null });
        assert.deepEqual(stripMount('/lmx/css/a.css', '/lm'), { pathname: '/lmx/css/a.css', redirect: null });
    });

    it('前綴以外的路徑原樣放過（route 設錯時不要默默改寫）', () => {
        assert.deepEqual(stripMount('/wp-admin', '/lm'), { pathname: '/wp-admin', redirect: null });
    });

    it('前綴出現在中間不算命中', () => {
        assert.deepEqual(stripMount('/foo/lm/bar', '/lm'), { pathname: '/foo/lm/bar', redirect: null });
    });
});

describe('stripMount — 掛在多層路徑', () => {
    it('/apps/lm 也要能切', () => {
        assert.deepEqual(
            stripMount('/apps/lm/member/list', '/apps/lm'),
            { pathname: '/member/list', redirect: null },
        );
        assert.deepEqual(
            stripMount('/apps/lm', '/apps/lm'),
            { pathname: '/', redirect: '/apps/lm/' },
        );
    });
});
