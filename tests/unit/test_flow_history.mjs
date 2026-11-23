/**
 * Unit Tests — js/flow/history.js（Undo / Redo）
 *
 * 舊實作在變動「之前」推快照：做兩步之後 undo 會跳回起點、redo 回到變動前。
 * 這裡釘住正確行為：每一步 undo 剛好退一步，redo 剛好進一步。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../../js/flow/history.js';

const s = (n) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), edges: [] });

describe('History', () => {
    it('連續兩步之後，undo 一次只退一步（舊 bug 的回歸測試）', () => {
        const h = new History();
        h.reset(s(0));
        h.record(s(1));
        h.record(s(2));
        assert.deepEqual(h.undo(), s(1));
        assert.deepEqual(h.undo(), s(0));
        assert.equal(h.undo(), null);
    });

    it('redo 回到變動「之後」的狀態', () => {
        const h = new History();
        h.reset(s(0));
        h.record(s(1));
        h.undo();
        assert.deepEqual(h.redo(), s(1));
        assert.equal(h.redo(), null);
    });

    it('undo 之後再 record → 丟掉 redo 分支', () => {
        const h = new History();
        h.reset(s(0));
        h.record(s(1));
        h.record(s(2));
        h.undo();
        h.record(s(5));
        assert.equal(h.canRedo(), false);
        assert.deepEqual(h.undo(), s(1));
    });

    it('與目前狀態相同的快照不記錄（不產生空的 undo 步驟）', () => {
        const h = new History();
        h.reset(s(0));
        assert.equal(h.record(s(0)), false);
        assert.equal(h.canUndo(), false);
    });

    it('超過上限時丟掉最舊的', () => {
        const h = new History(3);
        h.reset(s(0));
        for (let i = 1; i <= 5; i++) h.record(s(i));
        assert.equal(h.entries.length, 3);
        assert.deepEqual(h.undo(), s(4));
        assert.deepEqual(h.undo(), s(3));
        assert.equal(h.undo(), null);
    });

    it('回傳的快照是新物件，改它不會污染歷史', () => {
        const h = new History();
        h.reset(s(0));
        h.record(s(1));
        const snap = h.undo();
        snap.nodes.push({ id: 'evil' });
        h.redo();
        assert.deepEqual(h.undo(), s(0));
    });

    it('沒 reset 就 record 也能運作（第一筆成為起點）', () => {
        const h = new History();
        h.record(s(1));
        assert.equal(h.canUndo(), false);
        h.record(s(2));
        assert.deepEqual(h.undo(), s(1));
    });
});
