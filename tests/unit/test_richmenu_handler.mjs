/**
 * Unit Tests — handler/richmenu.js
 *
 * 這個 handler 在 2026-11 的健檢裡被點名：同步會謊報成功、編輯既有選單無效、
 * 失敗時在 LINE 上留下孤兒選單。以下測試把那些行為釘住。
 *
 * 所有對 LINE 的呼叫都走 globalThis.fetch，測試用一個會記錄呼叫的 mock 取代它。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import {
    handleSyncRichmenus,
    handleGetRichMenuImage,
} from '../../worker_src/handler/richmenu.js';

// ---------------------------------------------------------------------------
// 測試骨架
// ---------------------------------------------------------------------------

/**
 * 支援 { type: 'json' } 的 KV mock（token_store 用這個選項讀 access_tokens_*）
 */
function createJsonAwareMockKV() {
    const base = createMockKV();
    return {
        ...base,
        async get(key, opts) {
            const raw = await base.get(key);
            if (raw === null) return null;
            if (opts && opts.type === 'json') {
                try { return JSON.parse(raw); } catch { return null; }
            }
            return raw;
        },
        put: base.put.bind(base),
        delete: base.delete.bind(base),
        list: base.list.bind(base),
    };
}

/**
 * 建立一個已設定好 token 的 env。
 * token 以明文存入 —— decryptToken 對非加密命名空間的值原樣回傳。
 */
async function createEnvWithToken(userId = 'U-test', project = 'proj') {
    const kv = createJsonAwareMockKV();
    await kv.put(`access_tokens_${userId}`, JSON.stringify({
        [project]: { token: 'tok-plain', destination: 'Udest', displayName: 'Bot' },
    }));
    await kv.put(`current_token_${userId}`, project);
    return { KV_LINE_STORAGE: kv };
}

function jsonRequest(body) {
    return new Request('https://worker.example.com/richmenu/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * fetch mock：依 method + URL 比對 handlers，並記錄所有呼叫順序。
 *
 * @param {Array<{match: RegExp|string, method?: string, respond: Function|Object}>} routes
 */
function installFetchMock(routes) {
    const calls = [];
    const original = globalThis.fetch;

    globalThis.fetch = async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const href = typeof url === 'string' ? url : url.url;
        let body = null;
        if (init.body && typeof init.body === 'string') {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        calls.push({ method, url: href, body, raw: init.body });

        for (const route of routes) {
            const urlMatches = route.match instanceof RegExp
                ? route.match.test(href)
                : href.includes(route.match);
            const methodMatches = !route.method || route.method.toUpperCase() === method;
            if (urlMatches && methodMatches) {
                const result = typeof route.respond === 'function'
                    ? await route.respond({ method, url: href, body, init })
                    : route.respond;
                if (result instanceof Response) return result;
                const { status = 200, json = {}, text } = result || {};
                if (text !== undefined) {
                    return new Response(text, { status });
                }
                return new Response(JSON.stringify(json), {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }
        throw new Error(`fetch mock: 未預期的呼叫 ${method} ${href}`);
    };

    return {
        calls,
        restore() { globalThis.fetch = original; },
        /** 回傳符合條件的呼叫，依發生順序 */
        find(method, pattern) {
            return calls.filter(c =>
                c.method === method.toUpperCase() &&
                (pattern instanceof RegExp ? pattern.test(c.url) : c.url.includes(pattern))
            );
        },
        /** 某個呼叫在 calls 中的索引，找不到回 -1 */
        indexOf(method, pattern) {
            return calls.findIndex(c =>
                c.method === method.toUpperCase() &&
                (pattern instanceof RegExp ? pattern.test(c.url) : c.url.includes(pattern))
            );
        },
    };
}

const CREATE_MENU = 'https://api.line.me/v2/bot/richmenu';
const ALL_RICHMENU = 'https://api.line.me/v2/bot/user/all/richmenu';

/** 建立選單成功的標準回應 */
function createMenuOk(id = 'richmenu-new') {
    return { status: 200, json: { richMenuId: id } };
}

// ---------------------------------------------------------------------------
// 新增選單
// ---------------------------------------------------------------------------

describe('handleSyncRichmenus — 新增選單', () => {
    let env;
    let mock;

    beforeEach(async () => { env = await createEnvWithToken(); });
    afterEach(() => { if (mock) mock.restore(); mock = null; });

    it('selected: true 必須送到 LINE（勾了「預設開啟」要有效）', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk() },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{
                name: '主選單',
                diamention: [2500, 1686],
                areas: [],
                chatBarText: '開啟',
                selected: true,
            }],
        }), env, 'U-test');

        assert.equal(res.status, 200);
        const createCall = mock.find('POST', /\/v2\/bot\/richmenu$/)[0];
        assert.equal(createCall.body.selected, true, 'selected 不可被寫死成 false');
    });

    it('未指定 selected 時預設為 false', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk() },
        ]);

        await handleSyncRichmenus(jsonRequest({
            add: [{ name: '主選單', diamention: [2500, 1686], areas: [], chatBarText: '開啟' }],
        }), env, 'U-test');

        const createCall = mock.find('POST', /\/v2\/bot\/richmenu$/)[0];
        assert.equal(createCall.body.selected, false);
    });

    it('建立失敗時，錯誤訊息要帶上 LINE 的原文', async () => {
        mock = installFetchMock([
            {
                match: /\/v2\/bot\/richmenu$/, method: 'POST',
                respond: { status: 400, text: '{"message":"size must be 2500x1686"}' },
            },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{ name: '壞選單', diamention: [100, 100], areas: [] }],
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.added.length, 0);
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /size must be 2500x1686/,
            'LINE 的錯誤原文必須保留，不能只剩 status code');
    });

    it('圖片上傳失敗時，要刪掉剛建立的空選單（不可留孤兒）', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-orphan') },
            { match: /api-data\.line\.me/, method: 'POST', respond: { status: 400, text: 'image too large' } },
            { match: /\/v2\/bot\/richmenu\/richmenu-orphan$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        // 圖片只走 multipart 路徑
        const form = new FormData();
        form.append('name', '圖壞掉');
        form.append('diamention', JSON.stringify([2500, 1686]));
        form.append('areas', JSON.stringify([]));
        form.append('imageFile', new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));

        const res2 = await handleSyncRichmenus(
            new Request('https://worker.example.com/richmenu/sync', { method: 'POST', body: form }),
            env, 'U-test'
        );
        const body = await res2.json();

        assert.equal(body.added.length, 0, '圖片失敗就不算新增成功');
        assert.equal(body.errors.length, 1);
        assert.equal(
            mock.find('DELETE', '/richmenu/richmenu-orphan').length, 1,
            '圖片上傳失敗後必須刪除剛建立的選單'
        );
    });

    it('別名建立失敗時必須回報錯誤（不可靜默忽略）', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-a') },
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [] } } },
            {
                match: /\/v2\/bot\/richmenu\/alias$/, method: 'POST',
                respond: { status: 400, text: '{"message":"conflict richmenu alias id"}' },
            },
            { match: /\/v2\/bot\/richmenu\/richmenu-a$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{ name: '重複別名', diamention: [2500, 1686], areas: [], alias: 'main' }],
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.added.length, 0, '別名失敗不可顯示為新增成功');
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /conflict richmenu alias id/);
    });

    it('chatBarText 超過 14 字時在送出前就擋下', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk() },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{
                name: '太長',
                diamention: [2500, 1686],
                areas: [],
                chatBarText: '這段聊天列文字明顯超過十四個字元的上限',
            }],
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /chatBarText/);
        assert.equal(mock.find('POST', /\/v2\/bot\/richmenu$/).length, 0, '不該浪費一次 LINE 呼叫');
    });

    it('區域數超過 20 時在送出前就擋下', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk() },
        ]);

        const areas = Array.from({ length: 21 }, (_, i) => ({
            bounds: { x: i, y: 0, width: 10, height: 10 },
            action: { type: 'message', text: `${i}` },
        }));

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{ name: '區域太多', diamention: [2500, 1686], areas }],
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /20/);
        assert.equal(mock.find('POST', /\/v2\/bot\/richmenu$/).length, 0);
    });
});

// ---------------------------------------------------------------------------
// 編輯既有選單（LINE 沒有修改 API，必須走「建新→換別名→刪舊」）
// ---------------------------------------------------------------------------

describe('handleSyncRichmenus — 編輯既有選單', () => {
    let env;
    let mock;

    beforeEach(async () => { env = await createEnvWithToken(); });
    afterEach(() => { if (mock) mock.restore(); mock = null; });

    it('update 不可被丟掉：要建新選單、搬圖、改別名、刪舊選單', async () => {
        mock = installFetchMock([
            { match: ALL_RICHMENU, method: 'GET', respond: { status: 200, json: { richMenuId: 'other' } } },
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-new') },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-old\/content/, method: 'GET', respond: new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'Content-Type': 'image/png' } }) },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-new\/content/, method: 'POST', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [{ richMenuAliasId: 'main', richMenuId: 'richmenu-old' }] } } },
            { match: /\/v2\/bot\/richmenu\/alias\/main$/, method: 'POST', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/richmenu-old$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            update: [{
                richMenuId: 'richmenu-old',
                name: '改過的選單',
                diamention: [2500, 1686],
                areas: [],
                chatBarText: '選單',
                alias: 'main',
            }],
        }), env, 'U-test');

        const body = await res.json();
        assert.deepEqual(body.errors, []);
        assert.equal(body.updated.length, 1);
        assert.equal(body.updated[0].richMenuId, 'richmenu-new');
        assert.equal(body.updated[0].previousRichMenuId, 'richmenu-old');

        // 順序：建新 → 搬圖 → 改別名 → 刪舊
        const iCreate = mock.indexOf('POST', /\/v2\/bot\/richmenu$/);
        const iUpload = mock.indexOf('POST', /api-data.*richmenu-new\/content/);
        const iAlias = mock.indexOf('POST', /\/alias\/main$/);
        const iDelete = mock.indexOf('DELETE', /\/richmenu\/richmenu-old$/);

        assert.ok(iCreate > -1 && iUpload > iCreate, '必須先建立新選單再上傳圖片');
        assert.ok(iAlias > iUpload, '別名要在圖片就緒後才指過去');
        assert.ok(iDelete > iAlias, '舊選單必須最後才刪');
    });

    it('沒有新圖片時，要把舊選單的圖搬到新選單', async () => {
        mock = installFetchMock([
            { match: ALL_RICHMENU, method: 'GET', respond: { status: 200, json: { richMenuId: 'other' } } },
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-new') },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-old\/content/, method: 'GET', respond: new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'Content-Type': 'image/png' } }) },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-new\/content/, method: 'POST', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [] } } },
            { match: /\/v2\/bot\/richmenu\/richmenu-old$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        await handleSyncRichmenus(jsonRequest({
            update: [{ richMenuId: 'richmenu-old', name: 'x', diamention: [2500, 1686], areas: [] }],
        }), env, 'U-test');

        assert.equal(
            mock.find('GET', /api-data.*richmenu-old\/content/).length, 1,
            '必須讀回舊圖'
        );
        assert.equal(
            mock.find('POST', /api-data.*richmenu-new\/content/).length, 1,
            '必須把舊圖寫進新選單'
        );
    });

    it('中途失敗時要刪掉剛建立的新選單，且不可刪舊選單', async () => {
        mock = installFetchMock([
            { match: ALL_RICHMENU, method: 'GET', respond: { status: 200, json: { richMenuId: 'other' } } },
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-new') },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-old\/content/, method: 'GET', respond: new Response(new Uint8Array([9, 9]), { status: 200 }) },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-new\/content/, method: 'POST', respond: { status: 500, text: 'upload exploded' } },
            { match: /\/v2\/bot\/richmenu\/richmenu-new$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            update: [{ richMenuId: 'richmenu-old', name: 'x', diamention: [2500, 1686], areas: [] }],
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.updated.length, 0);
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /upload exploded/);
        assert.equal(mock.find('DELETE', '/richmenu/richmenu-new').length, 1, '要清掉新建的那個');
        assert.equal(mock.find('DELETE', '/richmenu/richmenu-old').length, 0, '舊的必須留著');
    });

    it('舊選單原本是預設時，新選單要接手成為預設', async () => {
        mock = installFetchMock([
            { match: ALL_RICHMENU, method: 'GET', respond: { status: 200, json: { richMenuId: 'richmenu-old' } } },
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-new') },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-old\/content/, method: 'GET', respond: new Response(new Uint8Array([9]), { status: 200 }) },
            { match: /api-data\.line\.me\/v2\/bot\/richmenu\/richmenu-new\/content/, method: 'POST', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [] } } },
            { match: ALL_RICHMENU, method: 'POST', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/richmenu-old$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        await handleSyncRichmenus(jsonRequest({
            update: [{ richMenuId: 'richmenu-old', name: 'x', diamention: [2500, 1686], areas: [] }],
        }), env, 'U-test');

        const setDefault = mock.find('POST', ALL_RICHMENU);
        assert.equal(setDefault.length, 1, '原本是預設就必須重新指定');
        assert.equal(setDefault[0].body.richMenuId, 'richmenu-new');
    });
});

// ---------------------------------------------------------------------------
// 設定預設選單
// ---------------------------------------------------------------------------

describe('handleSyncRichmenus — 設定預設選單', () => {
    let env;
    let mock;

    beforeEach(async () => { env = await createEnvWithToken(); });
    afterEach(() => { if (mock) mock.restore(); mock = null; });

    it('剛新增、還沒有 ID 的選單也能設為預設（用 name 對回去）', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-fresh') },
            { match: ALL_RICHMENU, method: 'POST', respond: { status: 200, json: {} } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            add: [{ name: '新主選單', diamention: [2500, 1686], areas: [] }],
            setDefault: { name: '新主選單', richMenuId: '' },
        }), env, 'U-test');

        const body = await res.json();
        assert.deepEqual(body.errors, []);
        const call = mock.find('POST', ALL_RICHMENU)[0];
        assert.ok(call, '必須真的呼叫設定預設的 API');
        assert.equal(call.body.richMenuId, 'richmenu-fresh');
        assert.equal(body.setDefault.richMenuId, 'richmenu-fresh');
    });

    it('新增必須排在設定預設之前', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu$/, method: 'POST', respond: createMenuOk('richmenu-fresh') },
            { match: ALL_RICHMENU, method: 'POST', respond: { status: 200, json: {} } },
        ]);

        await handleSyncRichmenus(jsonRequest({
            add: [{ name: '新主選單', diamention: [2500, 1686], areas: [] }],
            setDefault: { name: '新主選單' },
        }), env, 'U-test');

        assert.ok(
            mock.indexOf('POST', /\/v2\/bot\/richmenu$/) < mock.indexOf('POST', ALL_RICHMENU),
            'setDefault 不可與 add 併發'
        );
    });

    it('設定預設失敗時 results.setDefault 不可被填上', async () => {
        mock = installFetchMock([
            { match: ALL_RICHMENU, method: 'POST', respond: { status: 400, text: '{"message":"richMenuId not found"}' } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({
            setDefault: { name: '不存在', richMenuId: 'richmenu-ghost' },
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.setDefault, null, '失敗就不能回報成功');
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /richMenuId not found/);
    });

    it('找不到對應的 richMenuId 時要記錯誤，而不是靜默跳過', async () => {
        mock = installFetchMock([]);

        const res = await handleSyncRichmenus(jsonRequest({
            setDefault: { name: '沒建起來的選單', richMenuId: '' },
        }), env, 'U-test');

        const body = await res.json();
        assert.equal(body.setDefault, null);
        assert.equal(body.errors.length, 1, '靜默 return 會讓前端顯示「已設定」');
    });
});

// ---------------------------------------------------------------------------
// 刪除
// ---------------------------------------------------------------------------

describe('handleSyncRichmenus — 刪除選單', () => {
    let env;
    let mock;

    beforeEach(async () => { env = await createEnvWithToken(); });
    afterEach(() => { if (mock) mock.restore(); mock = null; });

    it('刪除前先清掉指向它的別名', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [{ richMenuAliasId: 'main', richMenuId: 'richmenu-x' }] } } },
            { match: /\/v2\/bot\/richmenu\/alias\/main$/, method: 'DELETE', respond: { status: 200, json: {} } },
            { match: /\/v2\/bot\/richmenu\/richmenu-x$/, method: 'DELETE', respond: { status: 200, json: {} } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({ remove: ['richmenu-x'] }), env, 'U-test');
        const body = await res.json();

        assert.deepEqual(body.removed, ['richmenu-x']);
        assert.deepEqual(body.errors, []);
        assert.ok(
            mock.indexOf('DELETE', '/alias/main') < mock.indexOf('DELETE', '/richmenu/richmenu-x')
        );
    });

    it('刪除失敗時帶上 LINE 原文', async () => {
        mock = installFetchMock([
            { match: /\/v2\/bot\/richmenu\/alias\/list$/, method: 'GET', respond: { status: 200, json: { aliases: [] } } },
            { match: /\/v2\/bot\/richmenu\/richmenu-x$/, method: 'DELETE', respond: { status: 404, text: '{"message":"richmenu not found"}' } },
        ]);

        const res = await handleSyncRichmenus(jsonRequest({ remove: ['richmenu-x'] }), env, 'U-test');
        const body = await res.json();

        assert.deepEqual(body.removed, []);
        assert.equal(body.errors.length, 1);
        assert.match(body.errors[0].error, /richmenu not found/);
    });
});

// ---------------------------------------------------------------------------
// 縮圖的 CORS
// ---------------------------------------------------------------------------

describe('handleGetRichMenuImage — CORS', () => {
    let env;
    let mock;

    beforeEach(async () => { env = await createEnvWithToken(); });
    afterEach(() => { if (mock) mock.restore(); mock = null; });

    it('不可回傳 Access-Control-Allow-Origin: *', async () => {
        mock = installFetchMock([
            { match: /api-data\.line\.me/, method: 'GET', respond: new Response(new Uint8Array([1]), { status: 200 }) },
        ]);

        const request = new Request('https://worker.example.com/richmenu/image/abc', {
            headers: { Origin: 'https://evil.example.com' },
        });
        const res = await handleGetRichMenuImage(env, 'U-test', 'abc', request);

        assert.notEqual(res.headers.get('Access-Control-Allow-Origin'), '*',
            'CLAUDE.md：CORS 不可退回 *');
        assert.equal(res.headers.get('Content-Type'), 'image/png');
    });

    it('白名單內的 origin 會被反射', async () => {
        mock = installFetchMock([
            { match: /api-data\.line\.me/, method: 'GET', respond: new Response(new Uint8Array([1]), { status: 200 }) },
        ]);

        env.ALLOWED_ORIGIN = 'https://admin.example.com';
        const request = new Request('https://worker.example.com/richmenu/image/abc', {
            headers: { Origin: 'https://admin.example.com' },
        });
        const res = await handleGetRichMenuImage(env, 'U-test', 'abc', request);

        assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://admin.example.com');
    });
});
