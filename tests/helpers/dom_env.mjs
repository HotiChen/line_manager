/**
 * dom_env.mjs — 給前端 DOM 層測試用的 jsdom 環境（含「真的」DOMPurify）
 *
 * 前端沒有 bundler，模組在瀏覽器裡直接讀 window / document / localStorage，
 * 而 helper/security.js 的 safeHTML 讀 window.DOMPurify（index.html 與
 * flow_designer_full.html 從 CDN 載入 dompurify@3.0.6）。這裡用同版本的 npm 套件
 * 掛上去，讓測試走和正式頁面一樣的消毒路徑，而不是自己假造一個。
 *
 * 用法（import 前端模組「之前」呼叫）：
 *   const env = installDom(html);
 *   const { FlowDesigner } = await import('../../js/flow_designer.js');
 *   ...
 *   env.restore();
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createDOMPurify = require('dompurify');

const GLOBALS = [
    'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location',
    'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent',
    'MutationObserver', 'getComputedStyle',
];

/**
 * @param {string} [html] body 內容
 * @param {{ purify?: boolean, url?: string }} [options] purify:false 模擬 CDN 沒載入
 */
export function installDom(html = '', { purify = true, url = 'https://flow.example.test/pages/flow_designer_full.html' } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
    const { window } = dom;

    const saved = new Map();
    for (const name of GLOBALS) {
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, {
            value: window[name],
            configurable: true,
            writable: true,
        });
    }

    if (purify) window.DOMPurify = createDOMPurify(window);

    // jsdom 沒有 canvas 實作（會印 "Not implemented" 並回 null）。設計器的 minimap 與
    // richmenu 按鈕繪製只需要「呼叫不會炸」，所以給一個什麼都不做的 2D context。
    const noopContext = new Proxy({}, {
        get: (target, prop) => (prop in target ? target[prop] : () => noopContext),
        set: (target, prop, value) => { target[prop] = value; return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = () => noopContext;

    // jsdom 的 confirm / alert 會印 "Not implemented"。預設「使用者按取消」。
    window.confirm = () => false;
    window.alert = () => {};

    return {
        window,
        document: window.document,
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
            window.close();
        },
    };
}
