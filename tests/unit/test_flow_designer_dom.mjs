/**
 * DOM Tests — Flow Designer 的事件委派（C3 回歸）
 *
 * 背景（docs/flow_designer/ARCHITECTURE_REVIEW_2026-11-18.md C3）：
 *   renderNode / showNodeProperties 的 template 都經過 helper/security.js 的 setInnerHTML，
 *   DOMPurify 會把 onclick / oninput / onchange / onmousedown / onload / onerror 全部移除，
 *   所以畫布上 richmenu 每個按鈕各自的輸出點、屬性面板的按鈕與輸入框從 2026-06 起都是死的。
 *
 * 修法是 template 改輸出 data-action（參數放 data-*，值用 escapeHTML 跳脫），再由容器上的
 * 委派 listener 分派（js/flow_designer_actions.js）。不放寬 DOMPurify。
 *
 * 這裡用 jsdom + 與正式頁面同版本的 DOMPurify（dompurify@3.0.6，見 tests/helpers/dom_env.mjs），
 * 走真正的 FlowDesigner → setInnerHTML → DOMPurify 路徑，再「點」出來的元素驗證：
 *   1. 呼叫到預期的方法、參數與原本 inline handler 一模一樣
 *   2. 舊的 inline 寫法確實會被消毒器移除（證明這次修法有其必要）
 *   3. 原始碼不再有任何 inline handler 屬性
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDom } from '../helpers/dom_env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

let env;
let FlowDesigner;
let dataLoader;
let setInnerHTML;
let designer;

before(async () => {
    env = installDom(`
        <div id="toast-container"></div>
        <div id="canvas-under-test" style="width:800px;height:600px"></div>
        <div id="sidebar"><div id="node-properties"></div></div>
    `);
    // 設計器模組一被 import 就會啟動資料載入器與 pageInit（打 API）。測試不碰網路。
    globalThis.fetch = async () => new Response(
        JSON.stringify({ success: true, data: [], flows: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const quiet = { ...console };
    console.log = console.warn = console.error = () => {};
    try {
        ({ FlowDesigner } = await import('../../js/flow_designer.js'));
        ({ dataLoader } = await import('../../js/flow_designer_data_loader.js'));
        ({ setInnerHTML } = await import('../../helper/security.js'));
    } finally {
        Object.assign(console, quiet);
    }
});

after(() => env.restore());

beforeEach(() => {
    // 每個測試一個全新的設計器與畫布
    // 容器也換新的：舊設計器綁在舊容器上的 listener 不能干擾這一個
    const doc = env.document;
    const canvas = doc.createElement('div');
    canvas.id = 'canvas-under-test';
    doc.getElementById('canvas-under-test').replaceWith(canvas);
    const props = doc.createElement('div');
    props.id = 'node-properties';
    doc.getElementById('sidebar').replaceChildren(props);
    globalThis.localStorage.clear();
    designer = new FlowDesigner('canvas-under-test');
});

// ── helpers ──────────────────────────────────────────────

const q = (sel, root = env.document) => root.querySelector(sel);
const qa = (sel, root = env.document) => [...root.querySelectorAll(sel)];

function fire(el, type, init = {}) {
    const Ctor = ['click', 'mousedown'].includes(type) ? env.window.MouseEvent : env.window.Event;
    const event = new Ctor(type, { bubbles: type !== 'load' && type !== 'error', cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
}

/** 把設計器的某些方法換成記錄用的 spy，回傳呼叫紀錄 */
function spyOn(target, names) {
    const calls = [];
    for (const name of names) {
        target[name] = (...args) => { calls.push([name, ...args]); };
    }
    return calls;
}

function addNode(type, data = {}) {
    const node = designer.addNode(type, { x: 40, y: 40 }, true);
    Object.assign(node.data, data);
    // 重新渲染，讓 template 反映補進去的資料
    env.document.getElementById(node.id)?.remove();
    designer.renderNode(node);
    return node;
}

function nodeEl(node) {
    return env.document.getElementById(node.id);
}

function showProps(node) {
    designer.showNodeProperties(node.id);
    return env.document.getElementById('node-properties');
}

function richmenuNode() {
    return addNode('richmenu', {
        richmenuId: 'richmenu-1',
        name: '主選單',
        imageUrl: IMG,
        size: { width: 2500, height: 1686 },
        buttons: [
            { id: 'btn_0', label: '按鈕一', bounds: { x: 0, y: 0, width: 1250, height: 843 } },
            { id: 'btn_1', label: '按鈕二', bounds: { x: 1250, y: 0, width: 1250, height: 843 } },
            { id: 'btn_2', label: '按鈕三', bounds: { x: 0, y: 843, width: 2500, height: 843 } },
        ],
    });
}

// ── 1. 消毒器行為：為什麼舊寫法是死的 ─────────────────────

describe('DOMPurify 與 inline handler', () => {
    const OLD_FORM = `
        <button id="b" onclick="flowDesigner.deleteNode('n1')">刪除</button>
        <img id="i" src="${IMG}" onload="flowDesigner.drawRichmenuButtons('n1','c')" onerror="x()">
        <textarea id="t" oninput="flowDesigner.updateNodeText('n1', this.value)"></textarea>
        <select id="s" onchange="flowDesigner.updateMessageType('n1', 0, this.value)"><option>a</option></select>
        <div id="d" onmousedown="flowDesigner.startConnectionDrag('n1','output',event,'default')"></div>`;

    it('舊的 inline 寫法經 setInnerHTML 後，六種 handler 屬性全被移除', () => {
        const host = env.document.createElement('div');
        setInnerHTML(host, OLD_FORM);

        for (const el of host.querySelectorAll('*')) {
            for (const attr of el.getAttributeNames()) {
                assert.ok(!/^on/i.test(attr), `<${el.localName}> 還帶著 ${attr}`);
            }
        }
        assert.ok(host.querySelector('#b'), '元素本身還在，只是 handler 被拿掉');
    });

    it('所以舊寫法點下去什麼都不會發生', () => {
        const calls = [];
        globalThis.flowDesigner = { deleteNode: (...a) => calls.push(a) };
        env.window.flowDesigner = globalThis.flowDesigner;
        try {
            const host = env.document.createElement('div');
            env.document.body.appendChild(host);
            setInnerHTML(host, OLD_FORM);
            fire(host.querySelector('#b'), 'click');
            assert.deepEqual(calls, []);
            host.remove();
        } finally {
            delete globalThis.flowDesigner;
            delete env.window.flowDesigner;
        }
    });

    it('data-action 與 data-* 參數則會被保留（新寫法可行的前提）', () => {
        const host = env.document.createElement('div');
        setInnerHTML(host, '<button data-action="delete-node" data-node-id="n1" data-index="2">x</button>');
        const b = host.querySelector('button');
        assert.equal(b.dataset.action, 'delete-node');
        assert.equal(b.dataset.nodeId, 'n1');
        assert.equal(b.dataset.index, '2');
    });

    it('沒有放寬消毒器：helper/security.js 沒有 ADD_ATTR / 允許 on* 的設定', () => {
        const src = read('helper/security.js');
        assert.ok(!/ADD_ATTR|ALLOW_UNKNOWN_PROTOCOLS|FORBID_ATTR|ADD_TAGS|onclick/i.test(src));
        assert.match(src, /DOMPurify\.sanitize\(dirtyHTML\)/);
    });
});

// ── 2. 畫布上的節點 ──────────────────────────────────────

describe('畫布節點（renderNode → setInnerHTML → 委派）', () => {
    it('渲染出來的節點沒有任何 on* 屬性', () => {
        const nodes = [
            richmenuNode(),
            addNode('message_text'),
            addNode('message_imagemap', { imageUrl: IMG, title: 'im', actions: [] }),
        ];
        for (const node of nodes) {
            for (const el of nodeEl(node).querySelectorAll('*')) {
                for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), attr);
            }
        }
    });

    it('richmenu 圖片載入 → drawRichmenuButtons(nodeId, containerId)', () => {
        const node = richmenuNode();
        const calls = spyOn(designer, ['drawRichmenuButtons']);

        const img = q('img', nodeEl(node));
        fire(img, 'load');

        assert.deepEqual(calls, [['drawRichmenuButtons', node.id, `richmenu-img-${node.id}`]]);
        // 容器 id 與實際存在的容器一致
        assert.ok(env.document.getElementById(`richmenu-img-${node.id}`));
    });

    it('richmenu 每個按鈕各自有一個可拖曳的輸出點，且連線來源是該按鈕的 id', () => {
        const node = richmenuNode();
        const dragCalls = spyOn(designer, ['startConnectionDrag']);

        // 不 spy 繪製：走真正的 drawRichmenuButtons（由 img 的 load 事件觸發）
        fire(q('img', nodeEl(node)), 'load');

        const ports = qa('.richmenu-connection-point', nodeEl(node));
        assert.equal(ports.length, 3, '三個按鈕 → 三個輸出點');
        assert.deepEqual(ports.map((p) => p.dataset.output), ['btn_0', 'btn_1', 'btn_2']);

        fire(ports[1], 'mousedown');
        assert.equal(dragCalls.length, 1);
        assert.equal(dragCalls[0][0], 'startConnectionDrag');
        assert.deepEqual(dragCalls[0].slice(1, 3), [node.id, 'output']);
        assert.equal(dragCalls[0][4], 'btn_1');
    });

    it('重複觸發 load 不會重複產生輸出點', () => {
        const node = richmenuNode();
        const img = q('img', nodeEl(node));
        fire(img, 'load');
        fire(img, 'load');
        assert.equal(qa('.richmenu-connection-point', nodeEl(node)).length, 3);
    });

    it('imagemap 圖片載入 → drawImagemapAreas；載入失敗 → 隱藏圖片並顯示備援', () => {
        const node = addNode('message_imagemap', { imageUrl: IMG, title: 'im', actions: [] });
        const calls = spyOn(designer, ['drawImagemapAreas']);
        const img = q('img', nodeEl(node));

        fire(img, 'load');
        assert.deepEqual(calls, [['drawImagemapAreas', node.id, `imagemap-img-${node.id}`]]);

        fire(img, 'error');
        assert.equal(img.style.display, 'none');
        assert.equal(img.nextElementSibling.style.display, 'block');
    });

    it('一般節點的輸出點 mousedown → startConnectionDrag(id, "output", event, "default")，並攔下事件', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['startConnectionDrag']);

        const reached = [];
        env.document.addEventListener('mousedown', () => reached.push('document'));
        nodeEl(node).addEventListener('mousedown', () => reached.push('node'));

        const port = q('.node-output-point', nodeEl(node));
        const event = fire(port, 'mousedown');

        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'startConnectionDrag');
        assert.equal(calls[0][1], node.id);
        assert.equal(calls[0][2], 'output');
        assert.equal(calls[0][3], event, '第三個參數是原生事件');
        assert.equal(calls[0][4], 'default');
        // 原本的 inline handler 會 stopPropagation：節點本身的拖曳與畫布平移都不該被觸發
        assert.deepEqual(reached, []);
    });

    it('imagemap 節點的輸出點也一樣', () => {
        const imagemap = addNode('message_imagemap', { imageUrl: IMG, title: 'im', actions: [] });
        const calls = spyOn(designer, ['startConnectionDrag']);
        fire(q('.node-output-point', nodeEl(imagemap)), 'mousedown');
        assert.deepEqual(calls.map((c) => [c[1], c[2], c[4]]), [[imagemap.id, 'output', 'default']]);
    });

    it('縮放按鈕 → zoomNode(id, ±0.1)，而且不會同時選取節點', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['zoomNode', 'selectNode']);

        const [plus, minus] = qa('.node-zoom-controls button', nodeEl(node));
        fire(plus, 'click');
        fire(minus, 'click');

        assert.deepEqual(calls, [
            ['zoomNode', node.id, 0.1],
            ['zoomNode', node.id, -0.1],
        ]);
    });

    it('點節點的其他地方仍然會選取節點（委派沒有吃掉原本的 click）', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['selectNode']);
        fire(q('.node-preview', nodeEl(node)), 'click');
        assert.deepEqual(calls, [['selectNode', node.id]]);
    });

    it('節點 id 含引號時，不能借 template 注入 data-action', () => {
        const evil = 'n"1" data-action="delete-node" data-x="';
        const node = designer.addNode('message_text', { x: 0, y: 0 }, true);
        node.id = evil;
        env.document.querySelectorAll('.flow-node').forEach((el) => el.remove());
        designer.renderNode(node);

        const actions = qa('[data-action]', designer.canvasContent).map((el) => el.dataset.action);
        assert.ok(actions.every((a) => a === 'zoom-node' || a === 'start-connection-drag'), actions.join(','));
        // 參數原樣（解跳脫後）送到方法
        const calls = spyOn(designer, ['zoomNode']);
        fire(q('.node-zoom-controls button', designer.canvasContent), 'click');
        assert.equal(calls[0][1], evil);
    });
});

// ── 3. 屬性面板 ──────────────────────────────────────────

describe('屬性面板（showNodeProperties → setInnerHTML → 委派）', () => {
    it('每種節點的面板都沒有任何 on* 屬性', () => {
        const nodes = [
            richmenuNode(),
            addNode('message_text'),
            addNode('message_sequence', { messages: [{ type: 'text', text: 'a' }] }),
            addNode('keyword', { keyword: 'k' }),
            addNode('action_delay', { seconds: 5 }),
            addNode('action_tag', { operation: 'add', tags: ['a'] }),
            addNode('message_flex', { buttons: [{ label: 'b' }] }),
            addNode('message_imagemap', { actions: [{ type: 'uri', linkUri: 'https://x.test' }] }),
        ];
        for (const node of nodes) {
            const panel = showProps(node);
            assert.ok(panel.children.length > 0, node.type);
            for (const el of panel.querySelectorAll('*')) {
                for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${node.type}: ${attr}`);
            }
        }
    });

    // [節點類型, 補進去的資料, 選擇器, 事件, 輸入值, 預期的方法, 預期參數（node.id 以 '$id' 代表）]
    const cases = [
        ['richmenu', {}, '[data-action="select-richmenu"]', 'click', null, 'selectRichmenu', ['$id']],
        ['richmenu', { buttons: [{ id: 'btn_0', label: 'a' }] }, '[data-action="expand-richmenu-buttons"]', 'click', null, 'expandRichmenuButtons', ['$node']],
        ['message_flex', {}, '[data-action="select-flex"]', 'click', null, 'selectFlex', ['$id']],
        ['message_flex', { buttons: [{ label: 'b' }] }, '[data-action="expand-flex-buttons"]', 'click', null, 'expandFlexButtons', ['$node']],
        ['message_imagemap', {}, '[data-action="select-imagemap"]', 'click', null, 'selectImagemap', ['$id']],
        ['message_imagemap', { actions: [{ type: 'message', text: 'hi' }] }, '[data-action="expand-imagemap-buttons"]', 'click', null, 'expandImagemapButtons', ['$node']],
        ['message_text', {}, '[data-action="update-node-text"]', 'input', '新的內容', 'updateNodeText', ['$id', '新的內容']],
        ['message_sequence', { messages: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, '[data-action="remove-sequence-message"][data-index="1"]', 'click', null, 'removeSequenceMessage', ['$id', 1]],
        ['message_sequence', { messages: [{ type: 'text', text: 'a' }] }, '[data-action="update-message-type"]', 'change', 'image', 'updateMessageType', ['$id', 0, 'image']],
        ['message_sequence', { messages: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, '[data-action="update-message-content"][data-index="1"]', 'change', '改過的文字', 'updateMessageContent', ['$id', 1, '改過的文字']],
        ['message_sequence', {}, '[data-action="add-sequence-message"]', 'click', null, 'addSequenceMessage', ['$id']],
        ['message_sequence', {}, '[data-action="update-sequence-delay"]', 'change', '1500', 'updateSequenceDelay', ['$id', '1500']],
        ['keyword', {}, '[data-action="select-keyword"]', 'click', null, 'selectKeyword', ['$id']],
        ['keyword', {}, '[data-action="update-node-keyword"]', 'change', 'hello', 'updateNodeKeyword', ['$id', 'hello']],
        ['keyword', {}, '[data-action="update-node-match-type"]', 'change', 'regex', 'updateNodeMatchType', ['$id', 'regex']],
        ['action_delay', { seconds: 5 }, '[data-action="update-node-delay"]', 'change', '30', 'updateNodeDelay', ['$id', '30']],
        ['action_tag', { operation: 'add', tags: [] }, '[data-action="update-node-tag-operation"]', 'change', 'remove', 'updateNodeTagOperation', ['$id', 'remove']],
        ['action_tag', { operation: 'add', tags: [] }, '[data-action="update-node-tags"]', 'change', 'a, b', 'updateNodeTags', ['$id', 'a, b']],
    ];

    for (const [type, data, selector, eventType, value, method, expected] of cases) {
        it(`${type}：${selector} 的 ${eventType} → ${method}`, () => {
            const node = addNode(type, data);
            const calls = spyOn(designer, [method]);
            const panel = showProps(node);

            const el = q(selector, panel);
            assert.ok(el, `面板裡找不到 ${selector}`);
            if (value !== null) {
                if (el.localName === 'select') {
                    // 面板裡沒有這個 <option> 時，值設不進去；補一個再選（等同使用者選到它）
                    if (![...el.options].some((o) => o.value === value)) el.add(new env.window.Option(value, value));
                }
                el.value = value;
            }
            fire(el, eventType);

            assert.equal(calls.length, 1, `${method} 應被呼叫一次`);
            const args = calls[0].slice(1).map((a) => (a === node ? '$node' : a === node.id ? '$id' : a));
            assert.deepEqual(args, expected);
        });
    }

    it('「刪除節點」按鈕 → deleteNode(id)', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['deleteNode']);
        const panel = showProps(node);
        fire(q('[data-action="delete-node"]', panel), 'click');
        assert.deepEqual(calls, [['deleteNode', node.id]]);
    });

    it('「載入 Richmenu」「展開所有按鈕」是 richmenu 面板的具名案例：真的找得到這兩顆按鈕', () => {
        const loaded = showProps(richmenuNode());
        assert.ok(q('[data-action="expand-richmenu-buttons"]', loaded));
        assert.ok(!q('[data-action="select-richmenu"]', loaded), '已載入時選擇器鎖定，不顯示載入按鈕');

        const empty = showProps(addNode('richmenu'));
        assert.ok(q('[data-action="select-richmenu"]', empty));
        assert.ok(!q('[data-action="expand-richmenu-buttons"]', empty));
    });

    it('展開按鈕傳的是 nodes 陣列裡真正的節點物件（與舊的 nodes.find 相同）', () => {
        const node = richmenuNode();
        const calls = spyOn(designer, ['expandRichmenuButtons']);
        fire(q('[data-action="expand-richmenu-buttons"]', showProps(node)), 'click');
        assert.equal(calls[0][1], designer.nodes.find((n) => n.id === node.id));
        assert.equal(calls[0].length, 2, '只傳一個參數');
    });

    it('資料載入器的「重新載入」按鈕（空清單與有資料兩種版本）→ dataLoader.reloadData(type)', () => {
        const originalReload = dataLoader.reloadData;
        const originalCache = dataLoader.cache;
        const calls = [];
        dataLoader.reloadData = (...a) => { calls.push(a); };
        try {
            // 空清單版本
            dataLoader.cache = { ...originalCache, flexMessages: [] };
            const flexPanel = showProps(addNode('message_flex'));
            const emptyBtn = q('.alert [data-action="reload-data"]', flexPanel);
            assert.ok(emptyBtn);
            fire(emptyBtn, 'click');

            // 有資料版本
            dataLoader.cache = { ...originalCache, richmenus: [{ richMenuId: 'r1', name: 'M' }] };
            const rmPanel = showProps(addNode('richmenu'));
            const btn = q('select + [data-action="reload-data"]', rmPanel);
            assert.ok(btn);
            fire(btn, 'click');

            assert.deepEqual(calls, [['flex'], ['richmenu']]);
        } finally {
            dataLoader.reloadData = originalReload;
            dataLoader.cache = originalCache;
        }
    });

    it('面板重畫很多次，一次點擊仍然只觸發一次（只綁了一個委派 listener）', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['deleteNode']);
        for (let i = 0; i < 5; i++) showProps(node);
        fire(q('[data-action="delete-node"]', env.document.getElementById('node-properties')), 'click');
        assert.equal(calls.length, 1);
    });

    it('沒有 data-action 的元素、未註冊的 action 名稱，點了不會有任何事', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['deleteNode', 'updateNodeText']);
        const panel = showProps(node);
        fire(q('h6', panel), 'click');
        const bogus = env.document.createElement('button');
        bogus.dataset.action = 'constructor';
        panel.appendChild(bogus);
        fire(bogus, 'click');
        assert.deepEqual(calls, []);
    });

    it('同一個 action 名稱只回應註冊的事件類型（textarea 的 change 不會觸發 input 的 action）', () => {
        const node = addNode('message_text');
        const calls = spyOn(designer, ['updateNodeText']);
        const area = q('[data-action="update-node-text"]', showProps(node));
        fire(area, 'change');
        assert.deepEqual(calls, []);
    });
});

// ── 4. 搜尋面板 ──────────────────────────────────────────

describe('搜尋面板', () => {
    it('關閉按鈕 → hideSearch()', () => {
        designer.showSearch();
        const calls = spyOn(designer, ['hideSearch']);
        fire(q('#flow-search-panel [data-action="hide-search"]'), 'click');
        assert.deepEqual(calls, [['hideSearch']]);
        env.document.getElementById('flow-search-panel')?.remove();
    });
});

// ── 5. 原始碼掃描：不可再出現 inline handler ─────────────

/** 去掉註解，避免說明文字裡提到 onclick 造成誤判 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** `on<事件>=` 後面接引號 = HTML 屬性寫法（`el.onclick = fn` 不算） */
const INLINE_HANDLER = /(^|[\s"'`<])on[a-z]{3,}\s*=\s*["'\\]/gim;

describe('原始碼掃描：flow 設計器沒有 inline handler 屬性', () => {
    const files = [
        'js/flow_designer.js',
        'js/flow_node_adapter.js',
        'js/flow_designer_data_loader.js',
        'js/flow_designer_actions.js',
    ];

    for (const file of files) {
        it(`${file} 的 template 字串沒有 on*="…"`, () => {
            const src = stripComments(read(file));
            const hits = [...src.matchAll(INLINE_HANDLER)].map((m) => m[0].trim());
            assert.deepEqual(hits, [], `${file} 仍有 inline handler：${hits.join(' | ')}`);
        });
    }

    it('掃描規則本身有效：舊寫法會被抓到，新寫法與屬性賦值不會', () => {
        assert.equal([...`<button onclick="x()">`.matchAll(INLINE_HANDLER)].length, 1);
        assert.equal([...`<img\n  onload='x()'>`.matchAll(INLINE_HANDLER)].length, 1);
        assert.equal([...`<div onmousedown=\\"x\\">`.matchAll(INLINE_HANDLER)].length, 1);
        assert.equal([...`<button data-action="x">`.matchAll(INLINE_HANDLER)].length, 0);
        assert.equal([...`nodeElement.onclick = (e) => {}`.matchAll(INLINE_HANDLER)].length, 0);
    });

    it('每個 template 裡出現的 data-action 都有對應的註冊（沒有「寫了卻沒人處理」的 action）', async () => {
        const { createActionTables } = await import('../../js/flow_designer_actions.js');
        const tables = createActionTables({}, {});
        const registered = new Set();
        for (const table of Object.values(tables)) {
            for (const actions of Object.values(table)) for (const name of Object.keys(actions)) registered.add(name);
        }

        const used = new Set();
        for (const file of files) {
            const src = read(file);
            for (const m of src.matchAll(/data-(?:error-)?action="([a-z-]+)"/g)) used.add(m[1]);
        }
        assert.ok(used.size >= 20, `預期至少 20 種 action，實際 ${used.size}`);
        for (const name of used) assert.ok(registered.has(name), `data-action="${name}" 沒有註冊`);
        for (const name of registered) assert.ok(used.has(name), `註冊了 ${name} 但沒有任何 template 使用它`);
    });

    it('經 loadPage（setInnerHTML）載入的片段 pages/flow_designer.html 不可帶 inline handler，或根本沒有導覽入口', () => {
        const fragment = read('pages/flow_designer.html');
        const reachable = /data-page="flow_designer"/.test(read('index.html'));
        const hasInline = [...stripComments(fragment).matchAll(INLINE_HANDLER)].length > 0;
        assert.ok(!(reachable && hasInline),
            'index.html 有 data-page="flow_designer" 入口，但該頁的 inline handler 會被 DOMPurify 移除');
    });

    it('獨立文件 pages/flow_designer_full.html 與 flow_editor.html 不經 setInnerHTML（有完整 <html>，或是 iframe）', () => {
        assert.match(read('pages/flow_designer_full.html'), /<!DOCTYPE html>/i);
        assert.match(read('pages/flow_editor.html'), /<iframe[^>]+flow_designer_full\.html/);
    });
});
