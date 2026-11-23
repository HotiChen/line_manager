/**
 * Unit Tests — flow_api.js（「呼叫 API」節點的驗證與安全請求）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateApiNode, callApi, flattenApiResult, isSafeHostname } from '../../worker_src/lib/flow_api.js';

const ok = (extra = {}) => ({ url: 'https://api.example.com/v1/hello', method: 'GET', headers: '{}', body: '{}', ...extra });

describe('validateApiNode — SSRF 與設定檢查', () => {
    it('合法設定通過', () => {
        assert.equal(validateApiNode(ok()), null);
        assert.equal(validateApiNode(ok({ method: 'POST', body: '{"a":1}', headers: '{"X-Token":"abc"}' })), null);
    });

    it('只允許 https', () => {
        for (const url of ['http://api.example.com', 'ftp://api.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
            assert.notEqual(validateApiNode(ok({ url })), null, url);
        }
    });

    it('擋 IP、localhost、內網名稱、雲端 metadata、各種 IP 寫法', () => {
        for (const url of [
            'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data',
            'https://[::1]/', 'https://[fd00::1]/', 'https://localhost/', 'https://localhost./',
            'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
            'https://db.internal/', 'https://printer.local/', 'https://router.lan/', 'https://intranet/',
        ]) {
            assert.notEqual(validateApiNode(ok({ url })), null, url);
        }
    });

    it('擋帳密網址與非 443 連接埠', () => {
        assert.notEqual(validateApiNode(ok({ url: 'https://user:pw@api.example.com/' })), null);
        assert.notEqual(validateApiNode(ok({ url: 'https://api.example.com:8443/' })), null);
        assert.equal(validateApiNode(ok({ url: 'https://api.example.com:443/' })), null);
    });

    it('方法只能是 GET / POST', () => {
        assert.notEqual(validateApiNode(ok({ method: 'DELETE' })), null);
        assert.notEqual(validateApiNode(ok({ method: 'PUT' })), null);
    });

    it('標頭：壞 JSON、非物件、過多、禁用、換行注入 → 擋', () => {
        assert.notEqual(validateApiNode(ok({ headers: '{bad' })), null);
        assert.notEqual(validateApiNode(ok({ headers: '[]' })), null);
        assert.notEqual(validateApiNode(ok({ headers: JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`H${i}`, 'v']))) })), null);
        for (const h of ['Host', 'content-length', 'Cookie', 'Transfer-Encoding', 'Proxy-Authorization']) {
            assert.notEqual(validateApiNode(ok({ headers: JSON.stringify({ [h]: 'x' }) })), null, h);
        }
        assert.notEqual(validateApiNode(ok({ headers: JSON.stringify({ 'X-A': 'a\r\nHost: evil' }) })), null);
        assert.notEqual(validateApiNode(ok({ headers: JSON.stringify({ 'X A': 'a' }) })), null);
    });

    it('POST 的 body 太大或不是 JSON 物件 → 擋', () => {
        assert.notEqual(validateApiNode(ok({ method: 'POST', body: 'x'.repeat(5000) })), null);
        assert.notEqual(validateApiNode(ok({ method: 'POST', body: '"str"' })), null);
    });

    it('isSafeHostname', () => {
        assert.equal(isSafeHostname('api.example.com'), true);
        assert.equal(isSafeHostname('例子.測試.tw'), true);
        assert.equal(isSafeHostname('example'), false);
    });
});

function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
    fn.calls = calls;
    return fn;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('callApi', () => {
    it('GET：回傳 ok / status / json；不跟隨轉址、帶 User-Agent', async () => {
        const f = fakeFetch(() => json({ name: '小明' }));
        const r = await callApi(ok(), { fetchFn: f });
        assert.deepEqual(r, { ok: true, status: 200, json: { name: '小明' } });
        assert.equal(f.calls[0].init.redirect, 'manual');
        assert.equal(f.calls[0].init.headers['User-Agent'], 'LINE-Flow/1');
        assert.equal(f.calls[0].init.body, undefined);
    });

    it('POST：帶 body 與 Content-Type', async () => {
        const f = fakeFetch(() => json({}));
        await callApi(ok({ method: 'POST', body: '{"a":1}' }), { fetchFn: f });
        assert.equal(f.calls[0].init.body, '{"a":1}');
        assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
    });

    it('設定不合法（例如發布後被竄改成內網）→ 根本不發請求', async () => {
        const f = fakeFetch(() => json({}));
        const r = await callApi(ok({ url: 'https://169.254.169.254/' }), { fetchFn: f });
        assert.deepEqual(r, { ok: false, status: 0, json: null });
        assert.equal(f.calls.length, 0);
    });

    it('轉址（3xx）、錯誤狀態 → ok:false；非 JSON → json:null；網路錯誤 → 不丟例外', async () => {
        assert.equal((await callApi(ok(), { fetchFn: fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://10.0.0.1/' } })) })).ok, false);
        assert.equal((await callApi(ok(), { fetchFn: fakeFetch(() => json({}, 500)) })).status, 500);
        const html = await callApi(ok(), { fetchFn: fakeFetch(() => new Response('<html>', { status: 200 })) });
        assert.deepEqual([html.ok, html.json], [true, null]);
        assert.deepEqual(await callApi(ok(), { fetchFn: fakeFetch(() => { throw new Error('boom'); }) }), { ok: false, status: 0, json: null });
    });

    it('逾時 → ok:false', async () => {
        const f = fakeFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
        const r = await callApi(ok(), { fetchFn: f, timeoutMs: 20 });
        assert.equal(r.ok, false);
    });

    it('回應超過上限只讀前 64KB（不會被巨大回應拖垮）', async () => {
        const big = '{"a":"' + 'x'.repeat(200 * 1024) + '"}';
        const r = await callApi(ok(), { fetchFn: fakeFetch(() => new Response(big, { status: 200 })) });
        assert.equal(r.ok, true);
        assert.equal(r.json, null); // 截斷後不是完整 JSON
    });
});

describe('flattenApiResult', () => {
    it('攤平成 api.路徑，只收純量，內建 ok/status 不會被回應裡的同名欄位蓋掉', () => {
        const v = flattenApiResult({ ok: true, status: 200, json: { user: { name: '小明', tags: ['a', 'b'] }, ok: 'fake', status: 'fake', n: 5, flag: false, nothing: null } });
        assert.equal(v['api.user.name'], '小明');
        assert.equal(v['api.user.tags.0'], 'a');
        assert.equal(v['api.n'], '5');
        assert.equal(v['api.flag'], 'false');
        assert.equal(v['api.ok'], 'true');
        assert.equal(v['api.status'], '200');
        assert.equal('api.nothing' in v, false);
    });

    it('失敗時只有 ok=false / status；過深與過多會被截斷', () => {
        assert.deepEqual(flattenApiResult({ ok: false, status: 0, json: null }), { 'api.ok': 'false', 'api.status': '0' });
        const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
        assert.ok(Object.keys(flattenApiResult({ ok: true, status: 200, json: many })).length <= 52);
        assert.equal('api.a.b.c.d.e' in flattenApiResult({ ok: true, status: 200, json: { a: { b: { c: { d: { e: 1 } } } } } }), false);
    });
});
