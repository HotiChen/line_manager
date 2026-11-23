// js/flow/designer/tools.js
// Tools：undo/redo、複製貼上、搜尋、小地圖
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { NodeTypeConfig } from '../node_types.js';
import { bindActions } from './actions.js';

export class ToolsMethods {
    // ─────────────────────────────────────────────
    // Undo / Redo
    // ─────────────────────────────────────────────

    undo() {
        const snap = this.history.undo();
        if (!snap) { toast.info('已是最早的操作'); return; }
        this._applyHistorySnapshot(snap);
        toast.success('↩ 已還原');
    }

    redo() {
        const snap = this.history.redo();
        if (!snap) { toast.info('沒有可重做的操作'); return; }
        this._applyHistorySnapshot(snap);
        toast.success('↪ 已重做');
    }

    _applyHistorySnapshot(snapshot) {
        this._replaceFlow({ nodes: snapshot.nodes, edges: snapshot.edges });
        this.commit({ record: false });
    }

    // ─────────────────────────────────────────────
    // Copy / Paste
    // ─────────────────────────────────────────────

    copySelected() {
        const ids = this.selectedNodes.length > 0
            ? this.selectedNodes.map(n => n.id)
            : (this.selectedNode ? [this.selectedNode] : []);

        if (ids.length === 0) { toast.warning('請先選取節點再複製'); return; }

        const nodes = this.nodes.filter(n => ids.includes(n.id));
        const edges = this.edges.filter(e => ids.includes(e.source) && ids.includes(e.target));

        this.clipboard = {
            nodes: JSON.parse(JSON.stringify(nodes)),
            edges: JSON.parse(JSON.stringify(edges))
        };
        toast.success(`已複製 ${nodes.length} 個節點`);
    }

    pasteNodes() {
        if (!this.clipboard) { toast.warning('剪貼簿為空'); return; }

        const idMap = {};
        const newNodes = this.clipboard.nodes.map(node => {
            const newId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            idMap[node.id] = newId;
            return { ...JSON.parse(JSON.stringify(node)), id: newId, position: { x: node.position.x + 60, y: node.position.y + 60 } };
        });

        const newEdges = this.clipboard.edges.map(edge => ({
            ...JSON.parse(JSON.stringify(edge)),
            id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            source: idMap[edge.source],
            target: idMap[edge.target]
        }));

        newNodes.forEach(node => { this.store.addNode(node); this.renderNode(node); });
        newEdges.forEach(edge => { if (this.store.addEdge(edge).ok) this.renderEdge(edge); });

        this.updateMinimap();
        this.saveToLocalStorage();
        toast.success(`已貼上 ${newNodes.length} 個節點`);
    }

    // ─────────────────────────────────────────────
    // Search  (Ctrl+P)
    // ─────────────────────────────────────────────

    showSearch() {
        if (this.searchPanel) {
            this.searchPanel.style.display = 'flex';
            this.searchPanel.querySelector('#flow-search-input').focus();
            return;
        }
        const panel = document.createElement('div');
        panel.id = 'flow-search-panel';
        panel.style.cssText = `
            position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
            background: white; border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2); padding: 12px 16px;
            z-index: 9999; width: 380px; display: flex; flex-direction: column; gap: 8px;
        `;
        panel.innerHTML = `
            <div style="display:flex; gap:8px; align-items:center; border-bottom:1px solid #eee; padding-bottom:8px;">
                <i class="bi bi-search" style="color:#666;"></i>
                <input type="text" id="flow-search-input" placeholder="搜尋節點名稱、類型…"
                    style="flex:1; border:none; outline:none; font-size:15px;">
                <button data-on="click:hideSearch"
                    style="border:none; background:none; cursor:pointer; color:#aaa; font-size:16px;">✕</button>
            </div>
            <div id="flow-search-results" style="max-height:280px; overflow-y:auto;"></div>
        `; // safe: static search panel skeleton, no user input
        document.body.appendChild(panel);
        this.searchPanel = panel;

        bindActions(panel, this);
        const input = panel.querySelector('#flow-search-input');
        input.focus();
        input.addEventListener('input', () => this._performSearch(input.value));
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hideSearch(); });

        // 點擊面板外關閉
        document.addEventListener('mousedown', (e) => {
            if (this.searchPanel && !this.searchPanel.contains(e.target)) this.hideSearch();
        }, { once: true });
    }

    hideSearch() {
        if (this.searchPanel) { this.searchPanel.remove(); this.searchPanel = null; }
    }

    _performSearch(query) {
        const resultsEl = document.getElementById('flow-search-results');
        if (!resultsEl) return;
        if (!query.trim()) { resultsEl.innerHTML = ''; return; } // safe: clear

        const lq = query.toLowerCase();
        const matches = this.nodes.filter(n => {
            const label = (n.data.label || n.data.name || n.config.label || '').toLowerCase();
            const type  = (n.config.label || '').toLowerCase();
            const text  = (n.data.text || n.data.keyword || '').toLowerCase();
            return label.includes(lq) || type.includes(lq) || text.includes(lq);
        });

        if (matches.length === 0) {
            resultsEl.innerHTML = '<div style="padding:10px; color:#999; text-align:center;">找不到節點</div>'; // safe: static message, no user input
            return;
        }
        resultsEl.innerHTML = ''; // safe: clear
        matches.forEach(n => {
            const itemDiv = document.createElement('div');
            itemDiv.style.cssText = 'padding:10px 12px; cursor:pointer; border-radius:6px; display:flex; gap:10px; align-items:center;';
            itemDiv.onclick = () => { this.focusOnNode(n.id); this.hideSearch(); };
            itemDiv.onmouseenter = () => { itemDiv.style.background = '#f0f4ff'; };
            itemDiv.onmouseleave = () => { itemDiv.style.background = 'white'; };

            const icon = document.createElement('i');
            icon.className = `bi ${n.config.icon}`; // safe: from NodeTypeConfig constant
            icon.style.cssText = `color:${n.config.color}; font-size:18px;`; // safe: NodeTypeConfig constant

            const textDiv = document.createElement('div');
            const nameDiv = document.createElement('div');
            nameDiv.style.fontWeight = '500';
            nameDiv.textContent = n.data.label || n.data.name || n.config.label;
            const typeDiv = document.createElement('div');
            typeDiv.style.cssText = 'font-size:11px; color:#999;';
            typeDiv.textContent = n.config.label; // safe: from NodeTypeConfig constant

            textDiv.appendChild(nameDiv);
            textDiv.appendChild(typeDiv);
            itemDiv.appendChild(icon);
            itemDiv.appendChild(textDiv);
            resultsEl.appendChild(itemDiv);
        });
    }

    // ─────────────────────────────────────────────
    // Minimap
    // ─────────────────────────────────────────────

    createMinimap() {
        if (this.minimapEl) return;
        const wrap = document.createElement('div');
        wrap.id = 'flow-minimap';
        wrap.title = '點擊導覽到該位置';
        wrap.style.cssText = `
            position: fixed; bottom: 20px; right: 20px;
            width: 180px; height: 110px;
            background: rgba(255,255,255,0.96);
            border: 1px solid #dee2e6; border-radius: 8px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.12);
            overflow: hidden; cursor: pointer; z-index: 1500;
        `;
        const canvas = document.createElement('canvas');
        canvas.width = 180; canvas.height = 110;
        wrap.appendChild(canvas);
        document.body.appendChild(wrap);
        this.minimapEl = wrap;
        this.minimapCanvas = canvas;

        wrap.addEventListener('click', (e) => {
            const ratio = this._minimapRatio();
            if (!ratio) return;
            const rect = wrap.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / wrap.offsetWidth;
            const my = (e.clientY - rect.top) / wrap.offsetHeight;
            const tx = ratio.minX + mx * ratio.rX;
            const ty = ratio.minY + my * ratio.rY;
            this.container.scrollLeft = tx * this.canvasZoom - this.container.offsetWidth / 2;
            this.container.scrollTop  = ty * this.canvasZoom - this.container.offsetHeight / 2;
        });

        // 捲動也更新 minimap viewport 框
        this.container.addEventListener('scroll', () => this.updateMinimap());
    }

    _minimapRatio() {
        if (this.nodes.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.nodes.forEach(n => {
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxX = Math.max(maxX, n.position.x + 220);
            maxY = Math.max(maxY, n.position.y + 120);
        });
        const pad = 60;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        return { minX, minY, rX: maxX - minX, rY: maxY - minY };
    }

    updateMinimap() {
        if (!this.minimapCanvas) return;
        const canvas = this.minimapCanvas;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // 背景
        ctx.fillStyle = '#f8f9fa';
        ctx.fillRect(0, 0, W, H);

        const r = this._minimapRatio();
        if (!r) {
            ctx.fillStyle = '#dee2e6';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('尚無節點', W / 2, H / 2);
            return;
        }
        const { minX, minY, rX, rY } = r;
        const sx = W / rX, sy = H / rY;

        // 畫連線
        ctx.strokeStyle = '#bdc3c7';
        ctx.lineWidth = 1;
        this.edges.forEach(edge => {
            const src = this.nodes.find(n => n.id === edge.source);
            const tgt = this.nodes.find(n => n.id === edge.target);
            if (!src || !tgt) return;
            ctx.beginPath();
            ctx.moveTo((src.position.x + 110 - minX) * sx, (src.position.y + 60 - minY) * sy);
            ctx.lineTo((tgt.position.x - minX) * sx, (tgt.position.y + 60 - minY) * sy);
            ctx.stroke();
        });

        // 畫節點
        this.nodes.forEach(n => {
            const x = (n.position.x - minX) * sx;
            const y = (n.position.y - minY) * sy;
            const nw = Math.max(220 * sx, 4);
            const nh = Math.max(80 * sy, 3);
            ctx.fillStyle = n.config.color + 'aa';
            ctx.strokeStyle = n.config.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, nw, nh, 2);
            else ctx.rect(x, y, nw, nh);
            ctx.fill(); ctx.stroke();
        });

        // 畫 viewport 框
        const vpX = (this.container.scrollLeft / this.canvasZoom - minX) * sx;
        const vpY = (this.container.scrollTop  / this.canvasZoom - minY) * sy;
        const vpW = (this.container.offsetWidth  / this.canvasZoom) * sx;
        const vpH = (this.container.offsetHeight / this.canvasZoom) * sy;
        ctx.strokeStyle = '#3498db';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(vpX, vpY, vpW, vpH);
        ctx.setLineDash([]);
    }
}
