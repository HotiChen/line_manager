// js/flow_designer_actions.js
// Flow Designer 的事件委派（取代 template 裡的 inline handler）
//
// 為什麼存在：
//   renderNode / showNodeProperties 的 template 都經過 setInnerHTML，而 setInnerHTML 用
//   DOMPurify 消毒（helper/security.js），onclick / oninput / onchange / onmousedown /
//   onload / onerror 全部會被移除 —— 2026-06 的 XSS 修正之後，這些 handler 一直是死的
//   （見 docs/flow_designer/ARCHITECTURE_REVIEW_2026-11-18.md C3）。
//
//   不可以為了相容而放寬 DOMPurify。template 改成輸出 data-action="…"（以及 data-* 參數，
//   值一律用 escapeHTML 跳脫），再由「每個容器一個」委派 listener 分派到原本的方法。
//
// 約定：
//   - click / mousedown / load / input / change 讀 `data-action`
//   - error 讀 `data-error-action`（同一個 <img> 要同時處理 load 與 error）
//   - 參數放在 data-node-id / data-index / data-delta / data-container-id / data-resource-type
//   - 一個 action 名稱只註冊在一種事件類型下；同名元素上其他事件類型的 listener 會忽略它

const ACTION_ATTR = 'data-action';
const ERROR_ACTION_ATTR = 'data-error-action';

/** 事件類型 → 讀哪個屬性 */
function attrFor(eventType) {
    return eventType === 'error' ? ERROR_ACTION_ATTR : ACTION_ATTR;
}

/**
 * 在 root 上為 table 裡出現的每一種事件類型各綁一個 listener。
 *
 * @param {Element} root 容器（畫布內容、屬性面板…）
 * @param {Object<string, Object<string, function(Element, Event): void>>} table
 *   { eventType: { actionName: (el, event) => void } }
 * @param {{capture?: boolean}} [options]
 *   capture：畫布需要。load / error 不冒泡；而 click / mousedown 要在節點本身的
 *   listener（選取、拖曳）之前攔截並 stopPropagation，行為才與原本掛在目標元素上的
 *   inline handler 相同。
 * @returns {function(): void} 解除綁定
 */
export function bindActionDelegation(root, table, { capture = false } = {}) {
    const bound = [];

    for (const [eventType, actions] of Object.entries(table)) {
        const attr = attrFor(eventType);
        const listener = (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;

            const el = target.closest(`[${attr}]`);
            if (!el || !root.contains(el)) return;

            const name = el.getAttribute(attr);
            if (!Object.prototype.hasOwnProperty.call(actions, name)) return;

            actions[name](el, event);
        };
        root.addEventListener(eventType, listener, capture);
        bound.push([eventType, listener]);
    }

    return () => {
        for (const [eventType, listener] of bound) root.removeEventListener(eventType, listener, capture);
    };
}

/**
 * 每個 action 對應到原本 inline handler 呼叫的那個方法，參數與順序不變。
 *
 * @param {Object} designer FlowDesigner 實例
 * @param {{reloadData: function(string): *}} dataLoader
 * @returns {{canvas: Object, panel: Object, search: Object}}
 */
export function createActionTables(designer, dataLoader) {
    const nodeId = (el) => el.dataset.nodeId;
    const index = (el) => Number(el.dataset.index);
    const findNode = (el) => designer.nodes.find((n) => n.id === nodeId(el));

    return {
        // renderNode 產生的節點（#canvas-content 底下）
        canvas: {
            click: {
                'zoom-node': (el, e) => {
                    e.stopPropagation();
                    designer.zoomNode(nodeId(el), Number(el.dataset.delta));
                },
            },
            mousedown: {
                'start-connection-drag': (el, e) => {
                    e.stopPropagation();
                    designer.startConnectionDrag(nodeId(el), 'output', e, 'default');
                },
            },
            load: {
                'draw-richmenu-buttons': (el) => designer.drawRichmenuButtons(nodeId(el), el.dataset.containerId),
                'draw-imagemap-areas': (el) => designer.drawImagemapAreas(nodeId(el), el.dataset.containerId),
            },
            error: {
                'hide-broken-image': (el) => {
                    el.style.display = 'none';
                    if (el.nextElementSibling) el.nextElementSibling.style.display = 'block';
                },
            },
        },

        // showNodeProperties 產生的屬性面板（#node-properties）
        panel: {
            click: {
                'delete-node': (el) => designer.deleteNode(nodeId(el)),
                'select-richmenu': (el) => designer.selectRichmenu(nodeId(el)),
                'expand-richmenu-buttons': (el) => designer.expandRichmenuButtons(findNode(el)),
                'select-flex': (el) => designer.selectFlex(nodeId(el)),
                'expand-flex-buttons': (el) => designer.expandFlexButtons(findNode(el)),
                'select-imagemap': (el) => designer.selectImagemap(nodeId(el)),
                'expand-imagemap-buttons': (el) => designer.expandImagemapButtons(findNode(el)),
                'select-keyword': (el) => designer.selectKeyword(nodeId(el)),
                'add-sequence-message': (el) => designer.addSequenceMessage(nodeId(el)),
                'remove-sequence-message': (el) => designer.removeSequenceMessage(nodeId(el), index(el)),
                'reload-data': (el) => dataLoader.reloadData(el.dataset.resourceType),
            },
            input: {
                'update-node-text': (el) => designer.updateNodeText(nodeId(el), el.value),
            },
            change: {
                'update-message-type': (el) => designer.updateMessageType(nodeId(el), index(el), el.value),
                'update-message-content': (el) => designer.updateMessageContent(nodeId(el), index(el), el.value),
                'update-sequence-delay': (el) => designer.updateSequenceDelay(nodeId(el), el.value),
                'update-node-keyword': (el) => designer.updateNodeKeyword(nodeId(el), el.value),
                'update-node-match-type': (el) => designer.updateNodeMatchType(nodeId(el), el.value),
                'update-node-delay': (el) => designer.updateNodeDelay(nodeId(el), el.value),
                'update-node-tag-operation': (el) => designer.updateNodeTagOperation(nodeId(el), el.value),
                'update-node-tags': (el) => designer.updateNodeTags(nodeId(el), el.value),
            },
        },

        // showSearch 的搜尋面板（不經 setInnerHTML，但一併去掉 inline handler，
        // 讓「flow 設計器 JS 不含任何 inline handler」這條規則沒有例外）
        search: {
            click: {
                'hide-search': () => designer.hideSearch(),
            },
        },
    };
}
