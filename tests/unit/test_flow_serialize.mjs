/**
 * Unit Tests — js/flow/serialize.js 與 js/flow/node_types.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    toPersisted,
    hydrateNodes,
    parseImport,
    readDraft,
    writeDraft,
    clearDraft,
    draftKey,
    LEGACY_DRAFT_KEY,
} from '../../js/flow/serialize.js';
import { NodeTypes, NodeTypeConfig, getDefaultNodeData } from '../../js/flow/node_types.js';
import { FLOW_NODE_TYPES } from '../../js/shared/flow_schema.js';

/** localStorage 替身 */
function memoryStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m,
    };
}

const node = (id, extra = {}) => ({ id, type: 'message_text', position: { x: 1, y: 2 }, data: { text: 't' }, ...extra });

describe('node_types', () => {
    it('NodeTypes 的每個值都在後端白名單 FLOW_NODE_TYPES 內', () => {
        for (const v of Object.values(NodeTypes)) assert.ok(FLOW_NODE_TYPES.includes(v), v);
    });

    it('NodeTypeConfig 的 key 都是合法 NodeTypes', () => {
        const values = new Set(Object.values(NodeTypes));
        for (const k of Object.keys(NodeTypeConfig)) assert.ok(values.has(k), k);
    });

    it('getDefaultNodeData 每次回傳新物件', () => {
        const a = getDefaultNodeData(NodeTypes.ACTION_TAG);
        a.tags.push('x');
        assert.deepEqual(getDefaultNodeData(NodeTypes.ACTION_TAG).tags, []);
        assert.deepEqual(getDefaultNodeData('nope'), { label: '未知節點' });
    });
});

describe('toPersisted / hydrateNodes', () => {
    it('去掉 node.config 與 _ 開頭的執行期欄位、清掉懸空連線、深拷貝', () => {
        const nodes = [node('a', { config: { label: 'x' } }), node('b')];
        const edges = [
            { id: 'e1', source: 'a', target: 'b', _abortController: {} },
            { id: 'e2', source: 'a', target: 'gone' },
        ];
        const out = toPersisted({ nodes, edges });
        assert.equal('config' in out.nodes[0], false);
        assert.deepEqual(out.edges, [{ id: 'e1', source: 'a', target: 'b' }]);
        out.nodes[0].data.text = 'changed';
        assert.equal(nodes[0].data.text, 't');
    });

    it('hydrateNodes 依類型補回 config', () => {
        const [n] = hydrateNodes([node('a')], NodeTypeConfig);
        assert.equal(n.config, NodeTypeConfig.message_text);
    });
});

describe('parseImport', () => {
    it('合法 → ok，並清掉懸空連線、正規化名稱', () => {
        const r = parseImport(JSON.stringify({ name: '<b>x</b>', nodes: [node('a')], edges: [{ source: 'a', target: 'gone' }] }));
        assert.equal(r.ok, true);
        assert.equal(r.flow.name, 'x');
        assert.deepEqual(r.flow.edges, []);
    });

    it('壞 JSON / 非物件 / 格式不合 → 錯誤訊息，不丟例外', () => {
        assert.equal(parseImport('{bad').ok, false);
        assert.equal(parseImport('[]').ok, false);
        assert.equal(parseImport(JSON.stringify({ nodes: [node('a', { type: 'evil' })] })).ok, false);
    });
});

describe('草稿（每個 bot 一份）', () => {
    let storage;
    beforeEach(() => { storage = memoryStorage(); });

    it('不同 bot 互不覆蓋', () => {
        writeDraft(storage, 'botA', { nodes: [node('a')], edges: [], flowId: 'fa', flowName: 'A' });
        writeDraft(storage, 'botB', { nodes: [], edges: [], flowId: null, flowName: 'B' });
        assert.equal(readDraft(storage, 'botA').flowName, 'A');
        assert.equal(readDraft(storage, 'botA').nodes.length, 1);
        assert.equal(readDraft(storage, 'botB').flowName, 'B');
    });

    it('寫入時去掉執行期欄位', () => {
        writeDraft(storage, 'botA', { nodes: [node('a', { config: {} })], edges: [], flowId: null, flowName: 'A' });
        assert.equal('config' in JSON.parse(storage.getItem(draftKey('botA'))).nodes[0], false);
    });

    it('舊的共用草稿：第一個讀的 bot 接手，之後別的 bot 讀不到', () => {
        storage.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ nodes: [node('a')], edges: [], flowId: 'f', flowName: 'old' }));
        assert.equal(readDraft(storage, 'botA').flowName, 'old');
        assert.equal(storage.getItem(LEGACY_DRAFT_KEY), null);
        assert.equal(readDraft(storage, 'botB'), null);
        assert.equal(readDraft(storage, 'botA').flowName, 'old');
    });

    it('沒有 bot 時用 default；壞資料回 null；clearDraft 刪除', () => {
        assert.equal(draftKey(null), 'flow_designer_draft:default');
        storage.setItem(draftKey('x'), '{bad');
        assert.equal(readDraft(storage, 'x'), null);
        writeDraft(storage, 'y', { nodes: [], edges: [], flowId: null, flowName: 'Y' });
        clearDraft(storage, 'y');
        assert.equal(readDraft(storage, 'y'), null);
    });

    it('storage 丟例外（私密模式/配額滿）時不會中斷', () => {
        const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
        assert.equal(readDraft(broken, 'a'), null);
        assert.equal(writeDraft(broken, 'a', { nodes: [], edges: [] }), false);
        assert.doesNotThrow(() => clearDraft(broken, 'a'));
    });
});
