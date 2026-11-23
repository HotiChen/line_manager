// js/flow/designer/actions.js
// 取代 inline on* 事件的白名單綁定。
//
// 為什麼不用 inline onclick：
//   1. 模板經 setInnerHTML（DOMPurify）消毒時，所有 on* 屬性都會被剝掉 —— 按鈕看得到但點了沒反應。
//   2. inline handler 等於在 HTML 字串裡執行任意 JS，也依賴全域 window.flowDesigner。
//
// 寫法：<button data-on="click:deleteNode" data-node-id="n1">；多個事件用空白分隔
//      （data-on="load:drawImagemapAreas error:showImageFallback"）。
//      data-stop 存在時先 stopPropagation（取代原本 inline 的 event.stopPropagation()）。
//
// 為什麼直接綁在元素上、不在 document 委派：
//   節點本身有 mousedown/click（拖曳、選取）listener。委派要等事件冒泡到 document，
//   那時節點的 listener 已經跑過了，stopPropagation 擋不住；直接綁才跟原本的時序一樣。
//   load / error 也不會冒泡，只能直接綁。

const nodeId = (el) => el.dataset.nodeId;
const index = (el) => Number(el.dataset.index);

/** 唯一允許的動作；未列在這裡的名稱一律忽略 */
export const ACTIONS = Object.freeze({
    // 節點卡片
    zoomNode: (fd, el) => fd.zoomNode(nodeId(el), Number(el.dataset.delta)),
    startConnectionDrag: (fd, el, ev) => fd.startConnectionDrag(nodeId(el), 'output', ev, el.dataset.handle || 'default'),
    drawRichmenuButtons: (fd, el) => fd.drawRichmenuButtons(nodeId(el), el.dataset.containerId),
    drawImagemapAreas: (fd, el) => fd.drawImagemapAreas(nodeId(el), el.dataset.containerId),
    showImageFallback: (fd, el) => {
        el.style.display = 'none';
        if (el.nextElementSibling) el.nextElementSibling.style.display = 'block';
    },

    // 側欄屬性面板
    deleteNode: (fd, el) => fd.deleteNode(nodeId(el)),
    selectRichmenu: (fd, el) => fd.selectRichmenu(nodeId(el)),
    expandRichmenuButtons: (fd, el) => fd.expandRichmenuButtons(fd.store.getNode(nodeId(el))),
    selectFlex: (fd, el) => fd.selectFlex(nodeId(el)),
    expandFlexButtons: (fd, el) => fd.expandFlexButtons(fd.store.getNode(nodeId(el))),
    selectImagemap: (fd, el) => fd.selectImagemap(nodeId(el)),
    expandImagemapButtons: (fd, el) => fd.expandImagemapButtons(fd.store.getNode(nodeId(el))),
    selectKeyword: (fd, el) => fd.selectKeyword(nodeId(el)),
    updateNodeText: (fd, el) => fd.updateNodeText(nodeId(el), el.value),
    addSequenceMessage: (fd, el) => fd.addSequenceMessage(nodeId(el)),
    removeSequenceMessage: (fd, el) => fd.removeSequenceMessage(nodeId(el), index(el)),
    updateMessageType: (fd, el) => fd.updateMessageType(nodeId(el), index(el), el.value),
    updateMessageContent: (fd, el) => fd.updateMessageContent(nodeId(el), index(el), el.value),
    updateSequenceDelay: (fd, el) => fd.updateSequenceDelay(nodeId(el), el.value),
    updateNodeKeyword: (fd, el) => fd.updateNodeKeyword(nodeId(el), el.value),
    updateNodeMatchType: (fd, el) => fd.updateNodeMatchType(nodeId(el), el.value),
    updateNodeDelay: (fd, el) => fd.updateNodeDelay(nodeId(el), el.value),
    updateNodeTagOperation: (fd, el) => fd.updateNodeTagOperation(nodeId(el), el.value),
    updateNodeTags: (fd, el) => fd.updateNodeTags(nodeId(el), el.value),

    // 工具列 / 面板
    showFlowList: (fd) => fd.showFlowList(),
    clearFlow: (fd) => fd.clearFlow(),
    undo: (fd) => fd.undo(),
    redo: (fd) => fd.redo(),
    copySelected: (fd) => fd.copySelected(),
    pasteNodes: (fd) => fd.pasteNodes(),
    showSearch: (fd) => fd.showSearch(),
    hideSearch: (fd) => fd.hideSearch(),
    reloadFlow: (fd) => fd.reloadFlow(),
    toggleSidebar: (fd) => fd.toggleSidebar(),
    togglePalette: () => document.getElementById('node-palette')?.classList.toggle('collapsed'),
});

/**
 * 解析 data-on="click:a load:b" → [['click','a'], ['load','b']]；格式不對或不在白名單的略過
 */
export function parseOn(spec) {
    return String(spec || '')
        .split(/\s+/)
        .map((pair) => pair.split(':'))
        .filter(([event, action]) => /^[a-z]+$/.test(event || '') && Object.hasOwn(ACTIONS, action || ''));
}

/**
 * 把 root（含自己）底下所有 [data-on] 綁上事件；重複呼叫不會重複綁
 * @param {Element|Document} root
 * @param {object} fd FlowDesigner 實例
 */
export function bindActions(root, fd) {
    if (!root) return;
    const els = [];
    if (root.matches && root.matches('[data-on]')) els.push(root);
    if (root.querySelectorAll) els.push(...root.querySelectorAll('[data-on]'));

    for (const el of els) {
        if (el.__flowActionsBound) continue;
        el.__flowActionsBound = true;
        for (const [event, action] of parseOn(el.dataset.on)) {
            el.addEventListener(event, (ev) => {
                if (el.hasAttribute('data-stop')) ev.stopPropagation();
                ACTIONS[action](fd, el, ev);
            });
        }
    }
}
