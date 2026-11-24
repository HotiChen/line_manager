/**
 * Unit Tests — postback data 解析（LM-4A，草案 §A.1）
 *
 *   lm:<action>[?query]                  → kind 'lm'
 *   px:<product_key>:<action>[?query]    → kind 'px'
 *   沒有前綴                              → kind 'legacy'（tag=／untag=）
 *   任何格式不合                          → kind 'invalid' + 原因碼
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePostback, POSTBACK_MAX_LENGTH, REASON } from '../../worker_src/lib/postback_route.js';

const invalid = (data, reason) => assert.deepEqual(parsePostback(data), { kind: 'invalid', reason }, `data=${JSON.stringify(data)}`);

describe('lm: 前綴', () => {
    it('lm:reply?key=hours', () => {
        assert.deepEqual(parsePostback('lm:reply?key=hours'), { kind: 'lm', action: 'reply', params: { key: 'hours' } });
    });
    it('沒有 query → params 為空物件', () => {
        assert.deepEqual(parsePostback('lm:menu'), { kind: 'lm', action: 'menu', params: {} });
    });
    it('query 值會被 URL 解碼（中文關鍵字）', () => {
        const data = `lm:reply?key=${encodeURIComponent('營業時間')}`;
        assert.deepEqual(parsePostback(data).params, { key: '營業時間' });
    });
    it('action 允許 a-z0-9_.- ，最長 32', () => {
        assert.equal(parsePostback(`lm:a${'b'.repeat(31)}`).kind, 'lm');
        invalid(`lm:a${'b'.repeat(32)}`, REASON.BAD_ACTION);
        assert.equal(parsePostback('lm:a.b_c-d9').action, 'a.b_c-d9');
    });
    it('action 不合格式', () => {
        invalid('lm:', REASON.BAD_ACTION);
        invalid('lm:Reply', REASON.BAD_ACTION);
        invalid('lm:1reply', REASON.BAD_ACTION);
        invalid('lm:re ply', REASON.BAD_ACTION);
        invalid('lm:reply:x', REASON.BAD_ACTION);
    });
});

describe('px: 前綴', () => {
    it('px:ip:plans', () => {
        assert.deepEqual(parsePostback('px:ip:plans'), { kind: 'px', productKey: 'ip', action: 'plans', params: {} });
    });
    it('px:ip:plans?type=wedding', () => {
        assert.deepEqual(parsePostback('px:ip:plans?type=wedding'),
            { kind: 'px', productKey: 'ip', action: 'plans', params: { type: 'wedding' } });
    });
    it('product_key 為 ^[a-z][a-z0-9]{1,15}$', () => {
        assert.equal(parsePostback(`px:a${'b'.repeat(15)}:x`).kind, 'px');
        invalid(`px:a${'b'.repeat(16)}:x`, REASON.BAD_PRODUCT_KEY);
        invalid('px:i:x', REASON.BAD_PRODUCT_KEY);       // 太短
        invalid('px:IP:x', REASON.BAD_PRODUCT_KEY);
        invalid('px:i_p:x', REASON.BAD_PRODUCT_KEY);
        invalid('px::x', REASON.BAD_PRODUCT_KEY);
    });
    it('缺 action', () => {
        invalid('px:ip', REASON.BAD_ACTION);
        invalid('px:ip:', REASON.BAD_ACTION);
        invalid('px:ip?x=1', REASON.BAD_PRODUCT_KEY);
    });
});

describe('query 限制', () => {
    it('最多 8 組', () => {
        const q = (n) => Array.from({ length: n }, (_, i) => `k${i}=v`).join('&');
        assert.equal(Object.keys(parsePostback(`lm:x?${q(8)}`).params).length, 8);
        invalid(`lm:x?${q(9)}`, REASON.TOO_MANY_PARAMS);
    });
    it('key 為 ^[a-z][a-z0-9_]{0,15}$', () => {
        assert.equal(parsePostback(`lm:x?a${'b'.repeat(15)}=1`).kind, 'lm');
        invalid(`lm:x?a${'b'.repeat(16)}=1`, REASON.BAD_PARAM_KEY);
        invalid('lm:x?Key=1', REASON.BAD_PARAM_KEY);
        invalid('lm:x?_k=1', REASON.BAD_PARAM_KEY);
        invalid('lm:x?__proto__=1', REASON.BAD_PARAM_KEY);
        invalid('lm:x?=1', REASON.BAD_PARAM_KEY);
    });
    it('value 解碼後 ≤ 64 字元', () => {
        assert.equal(parsePostback(`lm:x?k=${'v'.repeat(64)}`).kind, 'lm');
        invalid(`lm:x?k=${'v'.repeat(65)}`, REASON.PARAM_VALUE_TOO_LONG);
    });
    it('重複的 key 不接受（意思不明確）', () => {
        invalid('lm:x?k=1&k=2', REASON.DUPLICATE_PARAM);
    });
    it('空 query（結尾只有 ?）視為沒有參數', () => {
        assert.deepEqual(parsePostback('lm:x?').params, {});
    });
});

describe('長度與型別', () => {
    it('300 字元上限', () => {
        assert.equal(POSTBACK_MAX_LENGTH, 300);
        assert.equal(parsePostback('a'.repeat(300)).kind, 'legacy');
        invalid('a'.repeat(301), REASON.TOO_LONG);
        invalid(`lm:x?k=${'v'.repeat(300)}`, REASON.TOO_LONG); // 長度先擋，不進解析
    });
    it('空字串、非字串', () => {
        invalid('', REASON.EMPTY);
        invalid(undefined, REASON.EMPTY);
        invalid(null, REASON.EMPTY);
        invalid(42, REASON.EMPTY);
    });
});

describe('沒有前綴與未知前綴', () => {
    it('tag=／untag= 是 legacy', () => {
        assert.deepEqual(parsePostback('tag=VIP'), { kind: 'legacy' });
        assert.deepEqual(parsePostback('untag=Normal&tag=VIP'), { kind: 'legacy' });
        assert.deepEqual(parsePostback('x'), { kind: 'legacy' });
    });
    it('看起來像前綴但不是 lm／px → unknown_prefix', () => {
        invalid('xx:foo', REASON.UNKNOWN_PREFIX);
        invalid('LM:reply', REASON.UNKNOWN_PREFIX);
        invalid('pX:ip:plans', REASON.UNKNOWN_PREFIX);
    });
    it('回傳值不含原始 data', () => {
        const r = parsePostback('xx:secret-internal-string');
        assert.ok(!JSON.stringify(r).includes('secret'));
    });
});
