import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampActionLabel, ACTION_LABEL_MAX } from '../../helper/action_label.js';

describe('clampActionLabel — LINE 的 action label 上限 20 字', () => {
    it('上限是 20', () => assert.equal(ACTION_LABEL_MAX, 20));

    it('不超過 20 字的原樣回傳', () => {
        assert.equal(clampActionLabel('主頁面'), '主頁面');
        assert.equal(clampActionLabel('x'.repeat(20)), 'x'.repeat(20));
    });

    it('超過 20 字的截成 20 字（網址當 label 的情況）', () => {
        const url = 'https://liff.line.me/1234567890-abcdefgh?p=ip&to=/photos';
        const out = clampActionLabel(url);
        assert.equal([...out].length, 20);
        assert.ok(url.startsWith(out));
    });

    it('以字元計，不把表情符號（代理對）切一半', () => {
        const out = clampActionLabel('😀'.repeat(25));
        assert.equal([...out].length, 20);
        assert.equal(out, '😀'.repeat(20));
    });

    it('沒有 label 時回 undefined，非字串也不丟錯', () => {
        assert.equal(clampActionLabel(undefined), undefined);
        assert.equal(clampActionLabel(''), undefined);
        assert.equal(clampActionLabel(123), '123');
    });
});
