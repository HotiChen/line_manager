/**
 * Unit Tests — js/flow/flow_store.js（Flow 的資料層，不碰 DOM）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FlowStore } from '../../js/flow/flow_store.js';

const node = (id) => ({ id, type: 'message_text', position: { x: 0, y: 0 }, data: {} });
const edge = (id, source, target, sourceHandle = 'default') => ({ id, source, target, sourceHandle });

let store;
let events;
beforeEach(() => {
    store = new FlowStore();
    events = [];
    store.subscribe((e) => events.push(e.type));
});

describe('FlowStore — 節點', () => {
    it('addNode 加入並發事件；重複 id 拒絕', () => {
        assert.ok(store.addNode(node('a')));
        assert.equal(store.addNode(node('a')), null);
        assert.equal(store.nodes.length, 1);
        assert.deepEqual(events, ['node:add']);
    });

    it('removeNodes 一併刪掉相連的連線，回傳實際刪除的東西', () => {
        ['a', 'b', 'c'].forEach((id) => store.addNode(node(id)));
        store.addEdge(edge('e1', 'a', 'b'));
        store.addEdge(edge('e2', 'b', 'c'));

        const removed = store.removeNodes(['b']);
        assert.deepEqual(removed.nodeIds, ['b']);
        assert.deepEqual(removed.edges.map((e) => e.id).sort(), ['e1', 'e2']);
        assert.deepEqual(store.nodes.map((n) => n.id), ['a', 'c']);
        assert.deepEqual(store.edges, []);
        assert.equal(events.at(-1), 'nodes:remove');
    });

    it('removeNodes 不存在的 id → 不發事件', () => {
        store.removeNodes(['ghost']);
        assert.deepEqual(events, []);
    });

    it('collectDescendants 走完所有下游，不含自己，遇到菱形不重複', () => {
        ['a', 'b', 'c', 'd', 'x'].forEach((id) => store.addNode(node(id)));
        store.addEdge(edge('1', 'a', 'b'));
        store.addEdge(edge('2', 'a', 'c'));
        store.addEdge(edge('3', 'b', 'd'));
        store.addEdge(edge('4', 'c', 'd'));
        assert.deepEqual(store.collectDescendants('a').sort(), ['b', 'c', 'd']);
        assert.deepEqual(store.collectDescendants('x'), []);
    });
});

describe('FlowStore — 連線', () => {
    beforeEach(() => ['a', 'b', 'c'].forEach((id) => store.addNode(node(id))));

    it('合法連線 → ok', () => {
        assert.deepEqual(store.addEdge(edge('e1', 'a', 'b')).ok, true);
        assert.equal(store.edges.length, 1);
    });

    it('拒絕：端點不存在 / 自己連自己 / 重複 / 循環；拒絕時不改資料', () => {
        store.addEdge(edge('e1', 'a', 'b'));
        store.addEdge(edge('e2', 'b', 'c'));
        assert.equal(store.addEdge(edge('x', 'a', 'ghost')).reason, 'missing');
        assert.equal(store.addEdge(edge('x', 'a', 'a')).reason, 'self');
        assert.equal(store.addEdge(edge('x', 'a', 'b')).reason, 'duplicate');
        assert.equal(store.addEdge(edge('x', 'c', 'a')).reason, 'cycle');
        assert.equal(store.edges.length, 2);
    });

    it('同一對節點、不同 handle 可以各連一條', () => {
        store.addEdge(edge('e1', 'a', 'b', 'btn_0'));
        assert.equal(store.addEdge(edge('e2', 'a', 'b', 'btn_1')).ok, true);
    });

    it('removeEdge 回傳被刪的連線；不存在回 null', () => {
        store.addEdge(edge('e1', 'a', 'b'));
        assert.equal(store.removeEdge('e1').id, 'e1');
        assert.equal(store.removeEdge('e1'), null);
        assert.equal(store.edges.length, 0);
    });
});

describe('FlowStore — replace / clear', () => {
    it('replace 換掉資料；沒給 flowId/flowName 就保留原值', () => {
        store.flowId = 'f1';
        store.flowName = 'A';
        store.replace({ nodes: [node('a')], edges: [] });
        assert.equal(store.nodes.length, 1);
        assert.equal(store.flowId, 'f1');
        assert.equal(store.flowName, 'A');
        assert.equal(events.at(-1), 'replace');
    });

    it('clear 回到全新狀態', () => {
        store.replace({ nodes: [node('a')], flowId: 'f1', flowName: 'A' });
        store.clear();
        assert.deepEqual([store.nodes, store.edges, store.flowId, store.flowName], [[], [], null, '未命名流程']);
    });

    it('unsubscribe 後不再收到事件', () => {
        const got = [];
        const off = store.subscribe((e) => got.push(e.type));
        off();
        store.addNode(node('z'));
        assert.deepEqual(got, []);
    });
});
