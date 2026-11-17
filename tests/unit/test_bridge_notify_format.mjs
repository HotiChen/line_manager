/**
 * Unit Tests — bridge/notify.js 的純函式（LM-3B）：請求格式驗證、action.url 白名單、Flex 訊息組裝
 *
 * 不需要資料庫；端到端行為（認證、冪等、LINE 錯誤對映…）在 test_bridge_notify.mjs。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkActionUrl, validateNotification, buildFlexMessage } from '../../worker_src/bridge/notify.js';

const REF = 'customer-0001';
const base = (over = {}) => ({ external_contact_ref: REF, event_type: 'order.shipped', title: '出貨通知', body: '您的訂單已出貨', ...over });
const ok = (over) => {
    const r = validateNotification(base(over));
    assert.equal(r.error, undefined, JSON.stringify(over));
    return r.value;
};
const bad = (over, label = JSON.stringify(over)) => {
    const r = validateNotification(base(over));
    assert.equal(typeof r.error, 'string', label);
    assert.equal(r.value, undefined, label);
};

describe('validateNotification — 欄位格式', () => {
    it('最小請求通過，回傳正規化後的值（action 為 null）', () => {
        assert.deepEqual(ok(), { ref: REF, eventType: 'order.shipped', title: '出貨通知', body: '您的訂單已出貨', action: null });
    });

    it('帶 action 通過', () => {
        const v = ok({ action: { label: '查看訂單', url: 'https://example.com/o/1' } });
        assert.deepEqual(v.action, { label: '查看訂單', url: 'https://example.com/o/1' });
    });

    it('body 不是物件 → 錯誤', () => {
        for (const b of [null, undefined, [], 'x', 5, true]) {
            assert.equal(typeof validateNotification(b).error, 'string', String(b));
        }
    });

    it('additionalProperties:false —— 多餘欄位（頂層與 action 內）都拒絕', () => {
        bad({ extra: 1 });
        bad({ to: 'U123' });
        bad({ messages: [{ type: 'text', text: 'x' }] });
        bad({ action: { label: 'a', url: 'https://example.com', extra: 1 } });
        bad({ action: { label: 'a', url: 'https://example.com', type: 'postback' } });
    });

    it('必填欄位缺一不可', () => {
        for (const k of ['external_contact_ref', 'event_type', 'title', 'body']) {
            const b = base();
            delete b[k];
            assert.equal(typeof validateNotification(b).error, 'string', k);
        }
    });

    it('external_contact_ref：^[A-Za-z0-9_-]{8,64}$', () => {
        for (const v of ['abcdefg', 'a'.repeat(65), 'has space1', 'bad/slash1', '中文名稱中文名稱', '', 12345678, null, ['customer-0001']]) bad({ external_contact_ref: v });
        for (const v of ['abcdefgh', 'a'.repeat(64), 'A_b-C_d-1']) ok({ external_contact_ref: v });
    });

    it('event_type：^[a-z][a-z0-9_.]{0,63}$', () => {
        for (const v of ['', 'Order', '1abc', '_abc', 'a b', 'a-b', 'a'.repeat(65), 5, null]) bad({ event_type: v });
        for (const v of ['a', 'order.shipped', 'a_b.c9', 'a'.repeat(64)]) ok({ event_type: v });
    });

    it('title：1–40 字元（以 code point 計），不可空白、不可是非字串', () => {
        for (const v of ['', ' ', '   ', 'a'.repeat(41), '😀'.repeat(41), 5, null, {}, ['a']]) bad({ title: v });
        for (const v of ['a', 'a'.repeat(40), '😀'.repeat(40), '中'.repeat(40)]) ok({ title: v });
    });

    it('body：1–300 字元，換行允許', () => {
        for (const v of ['', ' \n ', 'a'.repeat(301), 5, null]) bad({ body: v });
        for (const v of ['a', 'a'.repeat(300), '第一行\n第二行\n\n第四行', '😀'.repeat(300)]) ok({ body: v });
    });

    it('action.label：1–20 字元；action.url 必須是非空字串（網域白名單另測）', () => {
        for (const v of ['', ' ', 'a'.repeat(21), 5, null]) bad({ action: { label: v, url: 'https://example.com' } });
        bad({ action: { label: 'ok', url: '' } });
        bad({ action: { label: 'ok', url: 5 } });
        bad({ action: { label: 'ok' } });
        bad({ action: { url: 'https://example.com' } });
        bad({ action: 'https://example.com' });
        bad({ action: null });
        bad({ action: [] });
        ok({ action: { label: 'a'.repeat(20), url: 'https://example.com' } });
    });

    it('控制字元：title 與 label 完全不可有（含換行）；body 只允許 \\n', () => {
        for (const c of ['\u0000', '\u0007', '\t', '\r', '\n', '\u001b', '\u007f', '\u0085', ' ', ' ']) {
            bad({ title: `a${c}b` }, `title ${JSON.stringify(c)}`);
            bad({ action: { label: `a${c}b`, url: 'https://example.com' } }, `label ${JSON.stringify(c)}`);
            if (c !== '\n') bad({ body: `a${c}b` }, `body ${JSON.stringify(c)}`);
        }
        ok({ body: 'a\nb' });
    });

    it('title／body／label 不可含 http:// 或 https://（不分大小寫）', () => {
        for (const v of ['http://a.co', 'https://a.co', 'HTTP://a.co', 'HTTPS://A.CO', 'HtTpS://x', '看 http://x 這裡', 'x https://example.com/y']) {
            bad({ title: v }, `title ${v}`);
            bad({ body: v }, `body ${v}`);
            bad({ action: { label: v.slice(0, 20), url: 'https://example.com' } }, `label ${v}`);
        }
        // 沒有 :// 的字樣不算連結
        ok({ title: 'http 與 https 說明', body: 'see example.com or http:/x or http//x or www.example.com' });
    });

    it('錯誤訊息不回顯使用者輸入的內容（只有欄位名稱）', () => {
        const secret = 'SECRET-TITLE-https://x';
        const r = validateNotification(base({ title: secret }));
        assert.ok(!r.error.includes('SECRET'));
        const r2 = validateNotification(base({ ['SECRET_FIELD']: 1 }));
        assert.equal(typeof r2.error, 'string');
    });
});

// ───────────────────────── 白名單 ─────────────────────────

const DOMAINS = ['example.com'];
const accepted = (url, domains = DOMAINS) => {
    const r = checkActionUrl(url, domains);
    assert.equal(r.ok, true, String(url));
    return r.url;
};
const rejected = (url, domains = DOMAINS) => {
    assert.deepEqual(checkActionUrl(url, domains), { ok: false }, String(url));
};

describe('checkActionUrl — 白名單矩陣', () => {
    it('登記網域本身與其子網域通過；回傳正規化後的網址（主機小寫）', () => {
        assert.equal(accepted('https://example.com'), 'https://example.com/');
        assert.equal(accepted('https://example.com/'), 'https://example.com/');
        assert.equal(accepted('https://www.example.com/a?b=c#d'), 'https://www.example.com/a?b=c#d');
        assert.equal(accepted('https://A.B.Example.COM/x'), 'https://a.b.example.com/x');
        assert.equal(accepted('https://a.picker.example.com/', ['picker.example.com']), 'https://a.picker.example.com/');
    });

    it('埠 443 通過（明寫或省略），尾端點與大小寫正規化後比對', () => {
        accepted('https://example.com:443/x');
        accepted('https://example.com./x');
        accepted('https://WWW.EXAMPLE.COM./x');
    });

    it('登記值的大小寫與尾端點也先正規化', () => {
        accepted('https://shop.example.com/', ['Example.COM.']);
    });

    it('多個登記網域：任一個符合即可', () => {
        accepted('https://shop.example.org/', ['example.com', 'example.org']);
        rejected('https://example.net/', ['example.com', 'example.org']);
    });

    it('lookalike：evil-example.com、example.com.evil.com、notexample.com 都拒絕', () => {
        rejected('https://evil-example.com/');
        rejected('https://example.com.evil.com/');
        rejected('https://notexample.com/');
        rejected('https://examplecom.com/');
        rejected('https://com/');
        rejected('https://example.co/');
        rejected('https://xn--exmple-cua.com/'); // punycode 的 lookalike
        rejected('https://exаmple.com/'); // 西里爾字母 а
        rejected('https://example.com%2eevil.com/'); // 解碼後是 example.com.evil.com
    });

    it('把真正的主機藏在 \\、#、?、@ 後面的手法都拒絕', () => {
        rejected('https://evil.com\\.example.com/');
        rejected('https://evil.com#.example.com/');
        rejected('https://evil.com?.example.com/');
        rejected('https://example.com@evil.com/');
        rejected('https://user@example.com/');
        rejected('https://user:pw@example.com/');
        rejected('https://:pw@example.com/');
    });

    it('非 https 的 scheme 拒絕', () => {
        for (const u of ['http://example.com/', 'HTTP://example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', '//example.com/', 'example.com', 'mailto:a@example.com', 'line://ti/p/x', 'tel:123']) {
            rejected(u);
        }
    });

    it('埠號非 443 拒絕', () => {
        for (const u of ['https://example.com:8443/', 'https://example.com:80/', 'https://example.com:0/', 'https://example.com:444/', 'https://example.com:99999/']) {
            rejected(u);
        }
    });

    it('IP 位址（v4、v6、各種怪寫法）與 localhost 拒絕，就算被登記也一樣', () => {
        for (const u of [
            'https://127.0.0.1/', 'https://1.1.1.1/', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://2130706433/', 'https://0x7f.1/',
            'https://017700000001/', 'https://[::1]/', 'https://[::ffff:1.2.3.4]/', 'https://[2001:db8::1]/', 'https://localhost/',
            'https://LOCALHOST/', 'https://localhost./', 'https://sub.localhost/', 'https://localhost:443/',
        ]) {
            rejected(u, ['example.com', '127.0.0.1', '1.1.1.1', 'localhost', '[::1]', '2130706433', 'ffff', '1']);
        }
    });

    it('空白與控制字元拒絕（含前後空白）', () => {
        for (const u of [' https://example.com/', 'https://example.com/ ', 'https://exa mple.com/', 'https://example.com/a b', 'https://example.com/\n', 'https://example.com/\t', 'https://example.com/\r\n', 'https://example.com/\u0000', 'https://example.com/\u007f', 'https://example.com/\u0085', 'https://example.com/ ', 'https://example.com/　']) {
            rejected(u);
        }
    });

    it('長度上限 1000：1000 通過、1001 拒絕', () => {
        const prefix = 'https://example.com/';
        accepted(prefix + 'a'.repeat(1000 - prefix.length));
        rejected(prefix + 'a'.repeat(1001 - prefix.length));
    });

    it('正規化後超過 1000（非 ASCII 被百分比編碼）也拒絕', () => {
        rejected('https://example.com/' + '中'.repeat(300)); // 原長 320，編碼後 > 1000
    });

    it('不是字串或是空字串拒絕', () => {
        for (const u of [null, undefined, 5, {}, [], '', true]) rejected(u);
    });

    it('沒有登記任何網域（空、缺、型別錯、含非字串）一律拒絕', () => {
        for (const d of [[], undefined, null, 'example.com', {}, [5, null, ''], [{}]]) {
            assert.deepEqual(checkActionUrl('https://example.com/', d), { ok: false }, JSON.stringify(d));
        }
    });
});

// ───────────────────────── Flex 組裝 ─────────────────────────

describe('buildFlexMessage — 快照', () => {
    it('沒有 action：只有 type、altText、bubble.body（兩段 text），沒有 footer', () => {
        assert.deepEqual(buildFlexMessage({ title: '出貨通知', body: '第一行\n第二行', action: null }), {
            type: 'flex',
            altText: '出貨通知',
            contents: {
                type: 'bubble',
                body: {
                    type: 'box',
                    layout: 'vertical',
                    spacing: 'md',
                    contents: [
                        { type: 'text', text: '出貨通知', weight: 'bold', size: 'lg', wrap: true },
                        { type: 'text', text: '第一行\n第二行', size: 'md', wrap: true },
                    ],
                },
            },
        });
    });

    it('有 action：多一個 footer，裡面只有一顆 uri 按鈕', () => {
        assert.deepEqual(buildFlexMessage({ title: 'T', body: 'B', action: { label: '查看', url: 'https://example.com/o/1' } }), {
            type: 'flex',
            altText: 'T',
            contents: {
                type: 'bubble',
                body: {
                    type: 'box',
                    layout: 'vertical',
                    spacing: 'md',
                    contents: [
                        { type: 'text', text: 'T', weight: 'bold', size: 'lg', wrap: true },
                        { type: 'text', text: 'B', size: 'md', wrap: true },
                    ],
                },
                footer: {
                    type: 'box',
                    layout: 'vertical',
                    contents: [
                        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '查看', uri: 'https://example.com/o/1' } },
                    ],
                },
            },
        });
    });

    it('使用者文字只出現在 text／label／uri／altText 這幾個欄位，不會跑進其他欄位或影響結構', () => {
        const T = 'SENTINEL_TITLE', B = 'SENTINEL_BODY', L = 'SENTINEL_LABEL', U = 'https://example.com/SENTINEL_URL';
        const msg = buildFlexMessage({ title: T, body: B, action: { label: L, url: U } });
        const hits = [];
        (function walk(node, path) {
            if (typeof node === 'string') {
                if (/SENTINEL/.test(node)) hits.push(`${path}=${node}`);
            } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
            else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
        })(msg, '$');
        assert.deepEqual(hits.sort(), [
            `$.altText=${T}`,
            `$.contents.body.contents[0].text=${T}`,
            `$.contents.body.contents[1].text=${B}`,
            `$.contents.footer.contents[0].action.label=${L}`,
            `$.contents.footer.contents[0].action.uri=${U}`,
        ].sort());
    });

    it('看起來像標記、變數或 JSON 的文字原樣放進 text，不改變結構', () => {
        const evil = '{"type":"postback"} (@name) <b>x</b> ${x} \\u0000';
        const msg = buildFlexMessage({ title: 'T', body: evil, action: null });
        assert.equal(msg.contents.body.contents[1].text, evil);
        assert.equal(msg.contents.body.contents.length, 2);
        assert.deepEqual(Object.keys(msg).sort(), ['altText', 'contents', 'type']);
        assert.deepEqual(Object.keys(msg.contents).sort(), ['body', 'type']);
    });

    it('altText 等於標題，且不超過 LINE 的 400 字元', () => {
        assert.equal(buildFlexMessage({ title: 'abc', body: 'x', action: null }).altText, 'abc');
        assert.ok(buildFlexMessage({ title: 'a'.repeat(40), body: 'x', action: null }).altText.length <= 400);
    });
});
