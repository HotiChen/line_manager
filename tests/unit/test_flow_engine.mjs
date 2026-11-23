/**
 * Unit Tests — flow_compiler.js（發布前檢查與編譯）+ flow_runtime.js（執行）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileFlow } from '../../worker_src/lib/flow_compiler.js';
import {
    findTrigger, runTrigger, runButton, parseFlowPostback, buttonPostbackData, runFrom,
} from '../../worker_src/lib/flow_runtime.js';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source, target, sourceHandle = 'default') => ({ id: `e_${source}_${target}_${sourceHandle}`, source, target, sourceHandle });
const flex = (n = 2) => ({
    type: 'bubble',
    footer: { type: 'box', layout: 'vertical', contents: Array.from({ length: n }, (_, i) => ({ type: 'button', action: { type: 'message', label: `按鈕${i}`, text: `t${i}` } })) },
});
const compile = (nodes, edges) => compileFlow({ id: 'f1', name: 'T', nodes, edges }, { botId: 'B', now: 'NOW' });
const errorsOf = (r) => (r.ok ? [] : r.errors.map((e) => e.message));

describe('compileFlow — 檢查', () => {
    it('最小可執行流程：關鍵字 → 文字', () => {
        const r = compile([node('k', 'keyword', { keyword: '你好', matchType: 'exact' }), node('t', 'message_text', { text: '哈囉' })], [edge('k', 't')]);
        assert.equal(r.ok, true);
        assert.deepEqual(r.published.triggers, [{ nodeId: 'k', keyword: '你好', matchType: 'exact' }]);
        assert.equal(r.published.flowId, 'f1');
        assert.equal(r.published.botId, 'B');
    });

    it('沒有觸發節點 → 擋', () => {
        assert.match(errorsOf(compile([node('t', 'message_text', { text: 'x' })], []))[0], /關鍵字觸發/);
    });

    it('空關鍵字、空文字、未選 Flex / Imagemap、標籤沒設定、網址不是 http → 擋並指出節點', () => {
        const r = compile(
            [node('k', 'keyword', { keyword: ' ' }), node('a', 'message_text', { text: '' }), node('b', 'message_flex', {}),
                node('c', 'message_imagemap', {}), node('d', 'action_tag', { tags: [] }), node('e', 'url', { url: 'javascript:alert(1)' })],
            ['a', 'b', 'c', 'd', 'e'].map((t) => edge('k', t)),
        );
        assert.equal(r.ok, false);
        const ids = r.errors.map((e) => e.nodeId).sort();
        assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e', 'k']);
    });

    it('尚不支援的節點（延遲/條件/API/圖片）接在觸發後 → 擋；沒接上的只警告', () => {
        const nodes = [node('k', 'keyword', { keyword: 'a' }), node('t', 'message_text', { text: 'x' }), node('d', 'action_delay', { seconds: 1 }), node('lonely', 'action_api')];
        const bad = compile(nodes, [edge('k', 't'), edge('t', 'd')]);
        assert.match(errorsOf(bad)[0], /延遲.*還不能執行/);
        const ok = compile(nodes.filter((n) => n.id !== 'd'), [edge('k', 't')]);
        assert.equal(ok.ok, true);
        assert.equal(ok.warnings.length, 1);
    });

    it('regex 比對、重複關鍵字、循環 → 擋', () => {
        assert.match(errorsOf(compile([node('k', 'keyword', { keyword: 'a', matchType: 'regex' })], []))[0], /比對方式/);
        const dup = compile([node('k1', 'keyword', { keyword: 'Hi, 你好' }), node('k2', 'keyword', { keyword: 'hi' })], []);
        assert.match(errorsOf(dup).join(), /重複/);
        const loop = compile([node('k', 'keyword', { keyword: 'a' }), node('x', 'message_text', { text: '1' }), node('y', 'message_text', { text: '2' })], [edge('k', 'x'), edge('x', 'y'), edge('y', 'x')]);
        assert.match(errorsOf(loop).join(), /循環/);
    });

    it('一次回覆超過 5 則 → 擋', () => {
        const nodes = [node('k', 'keyword', { keyword: 'a' })];
        const edges = [];
        for (let i = 0; i < 6; i++) { nodes.push(node(`m${i}`, 'message_text', { text: `${i}` })); edges.push(edge(i ? `m${i - 1}` : 'k', `m${i}`)); }
        assert.match(errorsOf(compile(nodes, edges))[0], /超過 5 則/);
    });

    it('壞資料（未知節點類型）交給共用 schema 擋', () => {
        assert.equal(compile([node('x', 'evil')], []).ok, false);
    });

    it('已發布資料只留執行需要的欄位', () => {
        const r = compile([node('k', 'keyword', { keyword: 'a', label: 'LONG', preview: 'x' }), node('t', 'message_text', { text: 'x', label: 'L' })], [edge('k', 't')]);
        assert.deepEqual(Object.keys(r.published.nodes.t.data), ['text']);
    });
});

describe('flow_runtime — 關鍵字', () => {
    const published = compile([node('k', 'keyword', { keyword: '你好, Hello', matchType: 'exact' }), node('c', 'keyword', { keyword: '價格', matchType: 'contains' }), node('t', 'message_text', { text: '哈囉' })], [edge('k', 't'), edge('c', 't')]).published;

    it('exact：不分大小寫、逗號多關鍵字；不是整句相同不算', () => {
        assert.equal(findTrigger(published, ' hello ').nodeId, 'k');
        assert.equal(findTrigger(published, '你好').nodeId, 'k');
        assert.equal(findTrigger(published, '你好嗎'), null);
    });

    it('contains：訊息包含關鍵字', () => {
        assert.equal(findTrigger(published, '請問價格多少').nodeId, 'c');
    });

    it('空訊息 / 壞資料不會丟例外', () => {
        assert.equal(findTrigger(published, ''), null);
        assert.equal(findTrigger(null, 'x'), null);
        assert.equal(findTrigger(published, 123), null);
    });

    it('觸發後回覆下游訊息', () => {
        assert.deepEqual(runTrigger(published, findTrigger(published, '你好')).messages, [{ type: 'text', text: '哈囉' }]);
    });
});

describe('flow_runtime — 串接、標籤、Flex 按鈕', () => {
    it('文字 → 序列 → 標籤 → 結束：依序收集，標籤分開回傳', () => {
        const p = compile(
            [node('k', 'keyword', { keyword: 'a' }), node('t', 'message_text', { text: '1' }),
                node('s', 'message_sequence', { messages: [{ type: 'text', text: '2' }, { type: 'text', text: '3' }] }),
                node('g', 'action_tag', { operation: 'add', tags: ['VIP'] }), node('r', 'action_tag', { operation: 'remove', tags: ['新客'] }),
                node('e', 'end'), node('after', 'message_text', { text: '不應出現' })],
            [edge('k', 't'), edge('t', 's'), edge('s', 'g'), edge('g', 'r'), edge('r', 'e'), edge('e', 'after')],
        ).published;
        const r = runTrigger(p, p.triggers[0]);
        assert.deepEqual(r.messages.map((m) => m.text), ['1', '2', '3']);
        assert.deepEqual(r.tags, { add: ['VIP'], remove: ['新客'] });
    });

    const build = () => compile(
        [node('k', 'keyword', { keyword: 'menu' }), node('f', 'message_flex', { contents: flex(3), altText: '選單' }),
            node('a', 'message_text', { text: '回覆A' }), node('u', 'url', { url: 'https://example.com' })],
        [edge('k', 'f'), edge('f', 'a', 'button_0'), edge('f', 'u', 'button_1')],
    ).published;

    it('Flex：有連線的按鈕改寫（回覆節點→postback、URL 節點→uri），沒連線的維持原樣', () => {
        const p = build();
        const [m] = runTrigger(p, p.triggers[0]).messages;
        assert.equal(m.type, 'flex');
        const buttons = m.contents.footer.contents.map((b) => b.action);
        assert.deepEqual(buttons[0], { type: 'postback', label: '按鈕0', data: buttonPostbackData('f1', 'f', 'button_0') });
        assert.deepEqual(buttons[1], { type: 'uri', label: '按鈕1', uri: 'https://example.com' });
        assert.deepEqual(buttons[2], { type: 'message', label: '按鈕2', text: 't2' });
    });

    it('改寫不會動到已發布的原始資料', () => {
        const p = build();
        runTrigger(p, p.triggers[0]);
        assert.equal(p.nodes.f.data.contents.footer.contents[0].action.type, 'message');
    });

    it('按鈕 postback → 執行該按鈕連到的節點', () => {
        const p = build();
        const parsed = parseFlowPostback(buttonPostbackData('f1', 'f', 'button_0'));
        assert.deepEqual(runButton(p, parsed).messages, [{ type: 'text', text: '回覆A' }]);
    });

    it('按鈕 postback：flowId 不符 / 沒有連線 → null（交回原本的處理）', () => {
        const p = build();
        assert.equal(runButton(p, { flowId: 'other', nodeId: 'f', handle: 'button_0' }), null);
        assert.equal(runButton(p, { flowId: 'f1', nodeId: 'f', handle: 'button_2' }), null);
    });
});

describe('parseFlowPostback', () => {
    it('只接受 flow:<flowId>:<nodeId>:<handle>', () => {
        assert.deepEqual(parseFlowPostback('flow:f1:n1:button_0'), { flowId: 'f1', nodeId: 'n1', handle: 'button_0' });
        for (const bad of ['tag=VIP', 'flow:a:b', 'flow:a:b:c:d', 'flow::b:c', '', null, undefined, 5]) assert.equal(parseFlowPostback(bad), null);
    });
});

describe('runFrom 安全上限', () => {
    it('發布資料被竄改成循環也不會無窮迴圈', () => {
        const p = { flowId: 'f', nodes: { a: { type: 'keyword', data: {} }, b: { type: 'keyword', data: {} } }, edges: { a: [{ handle: 'default', target: 'b' }], b: [{ handle: 'default', target: 'a' }] } };
        assert.equal(runFrom(p, ['a']).loop, true);
    });
});
