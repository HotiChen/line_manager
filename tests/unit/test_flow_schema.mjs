/**
 * Unit Tests — js/shared/flow_schema.js（前後端共用的 flow 資料格式）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    validateFlow,
    pruneDanglingEdges,
    normalizeFlowName,
    FLOW_NODE_TYPES,
    FLOW_LIMITS,
    FLOW_ID_PATTERN,
} from '../../js/shared/flow_schema.js';

const node = (id, type = 'message_text', extra = {}) => ({ id, type, position: { x: 0, y: 0 }, data: {}, ...extra });

describe('validateFlow', () => {
    it('合法的 flow 通過', () => {
        const r = validateFlow({
            nodes: [node('node_1', 'keyword'), node('node_2')],
            edges: [{ id: 'edge_1', source: 'node_1', sourceHandle: 'default', target: 'node_2' }],
        });
        assert.deepEqual(r, { ok: true, errors: [] });
    });

    it('空 flow 通過（nodes/edges 缺值視為空陣列）', () => {
        assert.equal(validateFlow({}).ok, true);
    });

    it('前端存下來的 node.config 等額外欄位不擋', () => {
        assert.equal(validateFlow({ nodes: [node('n1', 'richmenu', { config: { label: 'x' } })] }).ok, true);
    });

    it('非物件 / 非陣列 → 拒絕', () => {
        assert.equal(validateFlow(null).ok, false);
        assert.equal(validateFlow({ nodes: 'x' }).ok, false);
        assert.equal(validateFlow({ edges: {} }).ok, false);
    });

    it('未知節點類型 → 拒絕', () => {
        const r = validateFlow({ nodes: [node('n1', 'evil')] });
        assert.equal(r.ok, false);
        assert.match(r.errors[0], /type/);
    });

    it('節點 id 不合法或重複 → 拒絕', () => {
        assert.equal(validateFlow({ nodes: [node('a"><img>')] }).ok, false);
        assert.equal(validateFlow({ nodes: [node('n1'), node('n1')] }).ok, false);
    });

    it('position 不是數字 → 拒絕', () => {
        assert.equal(validateFlow({ nodes: [node('n1', 'end', { position: { x: '1', y: 0 } })] }).ok, false);
        assert.equal(validateFlow({ nodes: [node('n1', 'end', { position: { x: NaN, y: 0 } })] }).ok, false);
    });

    it('data 不是物件 → 拒絕', () => {
        assert.equal(validateFlow({ nodes: [node('n1', 'end', { data: 'x' })] }).ok, false);
    });

    it('連線指向不存在的節點或自己連自己 → 拒絕', () => {
        assert.equal(validateFlow({ nodes: [node('n1')], edges: [{ source: 'n1', target: 'ghost' }] }).ok, false);
        assert.equal(validateFlow({ nodes: [node('n1')], edges: [{ source: 'n1', target: 'n1' }] }).ok, false);
    });

    it('超過節點上限 → 拒絕', () => {
        const nodes = Array.from({ length: FLOW_LIMITS.maxNodes + 1 }, (_, i) => node(`n${i}`));
        const r = validateFlow({ nodes });
        assert.equal(r.ok, false);
        assert.match(r.errors[0], /Too many nodes/);
    });
});

describe('pruneDanglingEdges', () => {
    it('只留下兩端都存在的連線', () => {
        const edges = pruneDanglingEdges(
            [node('a'), node('b')],
            [{ source: 'a', target: 'b' }, { source: 'a', target: 'gone' }, null],
        );
        assert.deepEqual(edges, [{ source: 'a', target: 'b' }]);
    });
});

describe('normalizeFlowName', () => {
    it('去標籤、去空白、截長、空值給預設', () => {
        assert.equal(normalizeFlowName(' <b>主選單</b> '), '主選單');
        assert.equal(normalizeFlowName(''), '未命名流程');
        assert.equal(normalizeFlowName(undefined), '未命名流程');
        assert.equal(normalizeFlowName('x'.repeat(500)).length, FLOW_LIMITS.maxNameLength);
    });
});

describe('FLOW_ID_PATTERN', () => {
    it('接受新舊兩種 flowId，拒絕路徑/分隔字元', () => {
        assert.ok(FLOW_ID_PATTERN.test('flow_1700000000000_abc123def'));
        assert.ok(FLOW_ID_PATTERN.test('flow_U0123456789abcdef0123456789abcdef_1700000000000_abc123def'));
        assert.ok(!FLOW_ID_PATTERN.test('../x'));
        assert.ok(!FLOW_ID_PATTERN.test('a:b'));
        assert.ok(!FLOW_ID_PATTERN.test(''));
    });
});
