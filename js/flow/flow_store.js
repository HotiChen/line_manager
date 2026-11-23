// js/flow/flow_store.js
// Flow 的唯一資料來源：nodes / edges / flowId / flowName 與所有結構性操作。
// 純 JS、不碰 DOM —— 畫面層訂閱事件，自己決定怎麼重畫。

/**
 * 結構性變動會發出事件：
 *   node:add {node} / nodes:remove {nodeIds, edges} / edge:add {edge} / edge:remove {edge} / replace {}
 * 節點 data 的就地修改（editor 直接改 node.data.xxx）不經過 store，不會發事件；
 * 由呼叫端在改完後 commit（見 FlowDesigner.commit）。
 */
export class FlowStore {
    constructor({ nodes = [], edges = [], flowId = null, flowName = '未命名流程' } = {}) {
        this.nodes = nodes;
        this.edges = edges;
        this.flowId = flowId;
        this.flowName = flowName;
        this._listeners = new Set();
    }

    // ── 事件 ──────────────────────────────────────

    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _emit(type, payload = {}) {
        for (const fn of this._listeners) fn({ type, ...payload });
    }

    // ── 查詢 ──────────────────────────────────────

    getNode(id) {
        return this.nodes.find((n) => n.id === id) || null;
    }

    hasEdge(source, sourceHandle, target) {
        return this.edges.some((e) => e.source === source && e.sourceHandle === sourceHandle && e.target === target);
    }

    /** 從 targetId 沿連線走得到 sourceId → 新增 source→target 會形成循環 */
    wouldCreateCycle(sourceId, targetId) {
        const visited = new Set();
        const queue = [targetId];
        while (queue.length) {
            const current = queue.shift();
            if (current === sourceId) return true;
            if (visited.has(current)) continue;
            visited.add(current);
            for (const e of this.edges) if (e.source === current) queue.push(e.target);
        }
        return false;
    }

    /** 所有下游節點 id（不含自己），用於「刪除展開出來的子節點」 */
    collectDescendants(nodeId) {
        const collected = [];
        const seen = new Set([nodeId]);
        const stack = [nodeId];
        while (stack.length) {
            const current = stack.pop();
            for (const e of this.edges) {
                if (e.source === current && !seen.has(e.target)) {
                    seen.add(e.target);
                    collected.push(e.target);
                    stack.push(e.target);
                }
            }
        }
        return collected;
    }

    // ── 變動 ──────────────────────────────────────

    addNode(node) {
        if (!node || !node.id || this.getNode(node.id)) return null;
        this.nodes.push(node);
        this._emit('node:add', { node });
        return node;
    }

    /**
     * 刪除節點與所有相連的連線
     * @returns {{nodeIds: string[], edges: object[]}} 實際刪掉的東西（畫面層據此移除 DOM）
     */
    removeNodes(ids) {
        const idSet = new Set(ids);
        const nodeIds = this.nodes.filter((n) => idSet.has(n.id)).map((n) => n.id);
        const edges = this.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target));
        if (!nodeIds.length && !edges.length) return { nodeIds, edges };

        this.nodes = this.nodes.filter((n) => !idSet.has(n.id));
        this.edges = this.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target));
        this._emit('nodes:remove', { nodeIds, edges });
        return { nodeIds, edges };
    }

    /**
     * 新增連線；不合法時不改任何東西
     * @returns {{ok: true, edge: object} | {ok: false, reason: 'missing'|'self'|'duplicate'|'cycle'}}
     */
    addEdge(edge) {
        const { source, target, sourceHandle } = edge || {};
        if (!this.getNode(source) || !this.getNode(target)) return { ok: false, reason: 'missing' };
        if (source === target) return { ok: false, reason: 'self' };
        if (this.hasEdge(source, sourceHandle, target)) return { ok: false, reason: 'duplicate' };
        if (this.wouldCreateCycle(source, target)) return { ok: false, reason: 'cycle' };

        this.edges.push(edge);
        this._emit('edge:add', { edge });
        return { ok: true, edge };
    }

    removeEdge(edgeId) {
        const edge = this.edges.find((e) => e.id === edgeId);
        if (!edge) return null;
        this.edges = this.edges.filter((e) => e.id !== edgeId);
        this._emit('edge:remove', { edge });
        return edge;
    }

    /** 整份換掉（載入、匯入、undo/redo、切換 bot） */
    replace({ nodes = [], edges = [], flowId, flowName } = {}) {
        this.nodes = nodes;
        this.edges = edges;
        if (flowId !== undefined) this.flowId = flowId;
        if (flowName !== undefined) this.flowName = flowName || '未命名流程';
        this._emit('replace');
    }

    clear() {
        this.replace({ nodes: [], edges: [], flowId: null, flowName: '未命名流程' });
    }
}
