// js/flow/designer/debug.js
// Debug：開發用的流程結構檢視
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { setInnerHTML } from '../../../helper/security.js';
import { NodeTypes } from '../node_types.js';

export class DebugMethods {
    /**
     * 調試：輸出流程結構
     */
    debugFlowStructure() {

        // 準備 HTML 輸出
        let htmlOutput = '<div style="font-family: monospace; font-size: 12px; line-height: 1.6;">';
        htmlOutput += '<h3 style="margin-top: 0;">📊 流程結構調試信息</h3>';

        // 1. 節點信息
        htmlOutput += `<h4>📦 節點列表 (共 ${this.nodes.length} 個):</h4>`;
        htmlOutput += '<div style="margin-left: 20px;">';

        this.nodes.forEach((node, index) => {
            const label = node.data.label || node.config.label;

            htmlOutput += `<div style="margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-left: 3px solid ${node.config.color};">`;
            htmlOutput += `<strong>${index + 1}. ${label}</strong><br>`;
            htmlOutput += `ID: <code>${node.id}</code><br>`;
            htmlOutput += `類型: ${node.type}<br>`;
            htmlOutput += `位置: (${node.position.x}, ${node.position.y})<br>`;

            // 顯示節點數據摘要
            if (node.type === NodeTypes.URL) {
                const url = node.data.url || '(空)';
                htmlOutput += `URL: <a href="${url}" target="_blank">${url}</a><br>`;
            } else if (node.type === NodeTypes.MESSAGE_TEXT) {
                const text = (node.data.text || '(空)').substring(0, 50);
                htmlOutput += `文字: ${text}...<br>`;
            } else if (node.type === NodeTypes.POSTBACK) {
                const data = node.data.data || '(空)';
                htmlOutput += `Data: ${data}<br>`;
            } else if (node.type === NodeTypes.RICHMENU) {
                const name = node.data.name || '(未命名)';
                htmlOutput += `<span style="color: #0066cc; font-weight: bold;">名稱: ${name}</span><br>`;
                htmlOutput += `Richmenu ID: ${node.data.richmenuId}<br>`;
                htmlOutput += `按鈕數: ${node.data.buttons?.length || 0}<br>`;
            }
            htmlOutput += '</div>';
        });
        htmlOutput += '</div>';

        // 2. 連接信息
        htmlOutput += `<h4>🔗 連接列表 (共 ${this.edges.length} 條):</h4>`;
        htmlOutput += '<div style="margin-left: 20px;">';

        this.edges.forEach((edge, index) => {
            const sourceNode = this.nodes.find(n => n.id === edge.source);
            const targetNode = this.nodes.find(n => n.id === edge.target);

            const sourceLabel = sourceNode?.data.label || sourceNode?.config.label || edge.source;
            const targetLabel = targetNode?.data.label || targetNode?.config.label || edge.target;


            htmlOutput += `<div style="margin-bottom: 10px; padding: 8px; background: #e7f3ff; border-radius: 4px;">`;
            htmlOutput += `<strong>${index + 1}.</strong> ${sourceLabel} → ${targetLabel}<br>`;
            htmlOutput += `<small>起點: ${edge.source}</small><br>`;
            htmlOutput += `<small>終點: ${edge.target}</small><br>`;

            if (edge.sourceHandle) {
                htmlOutput += `<small>Handle: ${edge.sourceHandle}</small><br>`;
            }

            // 計算路徑坐標
            if (sourceNode && targetNode) {
                const sourceEl = document.getElementById(edge.source);
                const targetEl = document.getElementById(edge.target);
                if (sourceEl && targetEl) {
                    const startX = sourceNode.position.x + sourceEl.offsetWidth;
                    const startY = sourceNode.position.y + sourceEl.offsetHeight / 2;
                    const endX = targetNode.position.x;
                    const endY = targetNode.position.y + targetEl.offsetHeight / 2;
                    htmlOutput += `<small style="color: #666;">路徑: (${startX.toFixed(1)}, ${startY.toFixed(1)}) → (${endX.toFixed(1)}, ${endY.toFixed(1)})</small>`;
                }
            }
            htmlOutput += '</div>';
        });
        htmlOutput += '</div>';

        // 3. 連接關係圖
        htmlOutput += '<h4>🌳 連接關係樹:</h4>';
        htmlOutput += '<div style="margin-left: 20px;">';

        const nodeConnections = new Map();

        // 建立連接關係
        this.nodes.forEach(node => {
            nodeConnections.set(node.id, {
                node: node,
                outgoing: [],
                incoming: []
            });
        });

        this.edges.forEach(edge => {
            const sourceConn = nodeConnections.get(edge.source);
            const targetConn = nodeConnections.get(edge.target);
            if (sourceConn) sourceConn.outgoing.push(edge);
            if (targetConn) targetConn.incoming.push(edge);
        });

        // 輸出關係樹
        nodeConnections.forEach((conn, nodeId) => {
            if (conn.outgoing.length > 0) {
                const nodeLabel = conn.node.data.label || conn.node.config.label;
                htmlOutput += `<div style="margin-bottom: 10px;"><strong>${nodeLabel}:</strong><br>`;

                conn.outgoing.forEach(edge => {
                    const target = this.nodes.find(n => n.id === edge.target);
                    const targetLabel = target?.data.label || target?.config.label || edge.target;
                    htmlOutput += `<div style="margin-left: 20px;">└─→ ${targetLabel}</div>`;
                });
                htmlOutput += '</div>';
            }
        });
        htmlOutput += '</div>';

        htmlOutput += '</div>';

        // 顯示在畫面上的 Modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            max-width: 80%;
            max-height: 80%;
            overflow: auto;
            z-index: 10000;
        `;
        setInnerHTML(modal, htmlOutput);

        // 添加關閉按鈕
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        closeBtn.style.cssText = `
            position: sticky;
            top: 0;
            float: right;
            margin-bottom: 10px;
            padding: 8px 16px;
            background: #e74c3c;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        `;
        closeBtn.onclick = () => {
            document.body.removeChild(overlay);
        };
        modal.insertBefore(closeBtn, modal.firstChild);

        // 添加遮罩
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 9999;
        `;
        overlay.onclick = () => {
            document.body.removeChild(overlay);
        };
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        toast.success('調試信息已顯示（同時已輸出到 Console）');

        return {
            nodes: this.nodes.length,
            edges: this.edges.length,
            summary: `${this.nodes.length} 個節點, ${this.edges.length} 條連接`
        };
    }
}
