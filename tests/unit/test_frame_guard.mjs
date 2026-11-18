/**
 * Unit Tests — lib/frame_guard.js
 *
 * 授權同意頁（link_authorize）是靜態檔，頁面內的 top === self 檢查在 JS 被停用時擋不住嵌入；
 * 這裡在伺服器端補 X-Frame-Options 與 CSP frame-ancestors。只動這一頁，其他頁面（含 LIFF 頁面）行為不變。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFrameProtectedPath, withFrameProtection } from '../../worker_src/lib/frame_guard.js';

describe('isFrameProtectedPath', () => {
    it('同意頁（含 .html 與結尾斜線以外的精確比對）', () => {
        assert.equal(isFrameProtectedPath('/pages/link_authorize.html'), true);
    });

    it('其他頁面與路徑不受影響', () => {
        for (const p of ['/', '/index.html', '/pages/dashboard.html', '/pages/link_authorize.html.bak', '/pages/link_authorize', '/js/link_authorize.js', '/bridge/v1/link/authorize']) {
            assert.equal(isFrameProtectedPath(p), false, p);
        }
    });

    it('URL 變體（百分比編碼、重複斜線、點段）也算同一頁（審查 L-01）', () => {
        for (const p of ['/pages/%6Cink_authorize.html', '/pages/link%5Fauthorize.html', '//pages/link_authorize.html', '/pages//link_authorize.html', '/pages/./link_authorize.html', '/pages/x/../link_authorize.html', '/pages/%2e/link_authorize.html', '/PAGES/link_authorize.html']) {
            assert.equal(isFrameProtectedPath(p), true, p);
        }
    });

    it('無法解碼的百分比序列：不丟錯，視為不受保護', () => {
        assert.equal(isFrameProtectedPath('/pages/%E0%A4%A.html'), false);
    });

    it('非字串 → false', () => {
        assert.equal(isFrameProtectedPath(undefined), false);
        assert.equal(isFrameProtectedPath(null), false);
    });
});

describe('withFrameProtection', () => {
    it('同意頁：加 X-Frame-Options: DENY 與 frame-ancestors none，保留原本的狀態與標頭', async () => {
        const original = new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=60' } });
        const res = withFrameProtection(original, '/pages/link_authorize.html');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
        assert.equal(res.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
        assert.equal(res.headers.get('Content-Type'), 'text/html');
        assert.equal(res.headers.get('Cache-Control'), 'max-age=60');
        assert.equal(await res.text(), '<html></html>');
    });

    it('已有 CSP 時合併，不覆蓋既有指令', () => {
        const original = new Response('x', { headers: { 'Content-Security-Policy': "default-src 'self'" } });
        const res = withFrameProtection(original, '/pages/link_authorize.html');
        assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'self'; frame-ancestors 'none'");
    });

    it('已有 frame-ancestors 時不重複加', () => {
        const original = new Response('x', { headers: { 'Content-Security-Policy': "frame-ancestors 'self'" } });
        const res = withFrameProtection(original, '/pages/link_authorize.html');
        assert.equal(res.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
    });

    it('其他路徑：原樣回傳同一個 Response', () => {
        const original = new Response('x');
        assert.equal(withFrameProtection(original, '/pages/dashboard.html'), original);
    });

    it('404 或錯誤回應也一併保護（避免以錯誤頁嵌入探測）', () => {
        const res = withFrameProtection(new Response('nf', { status: 404 }), '/pages/link_authorize.html');
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    });
});
