// js/flow/designer/edge_view.js
// Edge view：連線的建立、拖拉、SVG 繪製、控制點
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { NodeTypes } from '../node_types.js';

export class EdgeViewMethods {
    /**
     * 開始連接
     */
    startConnection(sourceNodeId, outputHandle) {

        const sourceNode = this.nodes.find(n => n.id === sourceNodeId);
        if (!sourceNode) return;

        // 記錄連接起點
        this.connectionStart = {
            nodeId: sourceNodeId,
            output: outputHandle,
            node: sourceNode
        };

        this.isDraggingConnection = true;

        // 創建臨時連線路徑
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke', sourceNode.config.color);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-dasharray', '5,5');
        path.id = 'temp-connection';
        this.svgLayer.appendChild(path);
        this.tempConnection = path;

        // 改變游標
        document.body.style.cursor = 'crosshair';
    }

    /**
     * 更新臨時連線
     */
    updateTempConnection(mouseX, mouseY) {
        if (!this.tempConnection || !this.connectionStart) return;

        // 計算起點位置
        const sourceNode = this.connectionStart.node;
        const sourceElement = document.getElementById(this.connectionStart.nodeId);
        if (!sourceElement) return;

        const rect = sourceElement.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();

        // 起點：節點右側中央
        const startX = rect.right - containerRect.left;
        const startY = rect.top + rect.height / 2 - containerRect.top;

        // 終點：滑鼠位置
        const endX = mouseX - containerRect.left;
        const endY = mouseY - containerRect.top;

        // 繪製貝茲曲線
        const pathData = this.createCurvePath(startX, startY, endX, endY);
        this.tempConnection.setAttribute('d', pathData);
    }

    /**
     * 完成連接
     */
    finishConnection(event) {
        if (!this.connectionStart) return;

        // 判斷是否點擊在節點上
        const targetElement = event.target.closest('.flow-node');

        if (targetElement && targetElement.id !== this.connectionStart.nodeId) {
            const targetNodeId = targetElement.id;
            const targetNode = this.nodes.find(n => n.id === targetNodeId);

            if (targetNode) {
                // 創建連線
                this.createEdge(
                    this.connectionStart.nodeId,
                    this.connectionStart.output,
                    targetNodeId,
                    'input'
                );

                toast.success(`✅ 已連接: ${this.connectionStart.node.config.label} → ${targetNode.config.label} `);
            }
        } else {
        }

        this.cancelConnection();
    }

    /**
     * 取消連接
     */
    cancelConnection() {
        if (this.tempConnection) {
            this.tempConnection.remove();
            this.tempConnection = null;
        }

        this.connectionStart = null;
        this.isDraggingConnection = false;
        document.body.style.cursor = 'default';
    }

    /**
     * 創建連線
     */
    createEdge(sourceId, sourceHandle, targetId, targetHandle) {
        const edge = {
            id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            source: sourceId,
            sourceHandle: sourceHandle,
            target: targetId,
            targetHandle: targetHandle
        };

        const result = this.store.addEdge(edge);
        if (!result.ok) {
            const messages = {
                duplicate: ['warning', '該連線已存在'],
                cycle: ['error', '無法創建循環連線'],
                self: ['warning', '節點不能連到自己'],
                missing: ['error', '連線端點不存在'],
            };
            const [level, text] = messages[result.reason] || ['error', '無法建立連線'];
            toast[level](text);
            return;
        }

        this.renderEdge(edge);

        this.saveToLocalStorage();

    }

    /**
     * 渲染連線
     */
    renderEdge(edge) {

        const sourceNode = this.nodes.find(n => n.id === edge.source);
        const targetNode = this.nodes.find(n => n.id === edge.target);

        if (!sourceNode || !targetNode) {
            console.error(`[renderEdge] 找不到節點: source = ${!!sourceNode}, target = ${!!targetNode} `);
            return;
        }

        const sourceElement = document.getElementById(edge.source);
        const targetElement = document.getElementById(edge.target);

        if (!sourceElement || !targetElement) {
            console.error(`[renderEdge] 找不到節點元素: source = ${!!sourceElement}, target = ${!!targetElement} `);
            return;
        }

        // 檢查元素是否完全渲染（有尺寸）
        if (!sourceElement.offsetWidth || !targetElement.offsetWidth) {
            console.warn(`[renderEdge] 元素尺寸未就緒，延遲 50ms 重試`);
            setTimeout(() => this.renderEdge(edge), 50);
            return;
        }

        // 獲取節點尺寸
        const sourceWidth = sourceElement.offsetWidth;
        const sourceHeight = sourceElement.offsetHeight;
        const targetWidth = targetElement.offsetWidth;
        const targetHeight = targetElement.offsetHeight;

        // 直接使用節點的 position 屬性（最簡單可靠的方式）
        const startX = (sourceNode.position?.x ?? 0) + sourceWidth;  // 右側
        const startY = (sourceNode.position?.y ?? 0) + sourceHeight / 2;  // 中央
        const endX = targetNode.position?.x ?? 0;  // 左側
        const endY = (targetNode.position?.y ?? 0) + targetHeight / 2;  // 中央


        // 根據目標節點類型決定連接線顏色
        let strokeColor = sourceNode.config.color;
        switch (targetNode.type) {
            case NodeTypes.URL:
                strokeColor = '#2ecc71'; // 綠色
                break;
            case NodeTypes.RICHMENU:
                strokeColor = '#3498db'; // 藍色
                break;
            case NodeTypes.POSTBACK:
                strokeColor = '#9b59b6'; // 紫色
                break;
            case NodeTypes.MESSAGE_TEXT:
                strokeColor = '#e67e22'; // 橙色
                break;
            default:
                strokeColor = '#95a5a6'; // 灰色
        }

        // 創建路徑
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.id = edge.id;
        path.setAttribute('d', this.createCurvePath(startX, startY, endX, endY));
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('fill', 'none');
        path.setAttribute('class', 'edge-path');
        path.setAttribute('marker-end', 'url(#arrowhead)');  // ✨ 添加箭頭
        path.style.pointerEvents = 'stroke';
        path.style.cursor = 'pointer';
        path.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))';


        // 雙擊刪除連線（避免誤刪）
        path.ondblclick = () => {
            this.deleteEdge(edge.id);
        };

        // 單擊提示
        path.onclick = () => {
            toast.info('雙擊此連接線可刪除');
        };

        // Hover 效果
        path.onmouseenter = () => {
            path.setAttribute('stroke-width', '3');
            path.setAttribute('stroke', '#e74c3c');
        };
        path.onmouseleave = () => {
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke', sourceNode.config.color);
        };

        if (!this.svgLayer) {
            console.error(`[renderEdge] svgLayer 不存在！`);
            return;
        }

        // 添加可拖動的控制點（先插入，所以在底層）
        const controlPoint = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;

        // 如果 edge 已有保存的控制點，使用它
        if (edge.controlPoint) {
            controlPoint.setAttribute('cx', edge.controlPoint.x);
            controlPoint.setAttribute('cy', edge.controlPoint.y);
        } else {
            controlPoint.setAttribute('cx', midX);
            controlPoint.setAttribute('cy', midY);
            edge.controlPoint = { x: midX, y: midY };
        }

        controlPoint.setAttribute('r', '8');
        controlPoint.setAttribute('fill', sourceNode.config.color);
        controlPoint.setAttribute('stroke', 'white');
        controlPoint.setAttribute('stroke-width', '2');
        controlPoint.setAttribute('class', 'edge-control-point');
        controlPoint.setAttribute('data-edge-id', edge.id);
        controlPoint.style.cursor = 'move';
        controlPoint.style.opacity = '0';  // 預設隱藏

        // 控制點拖動
        this.makeControlPointDraggable(controlPoint, edge, path, sourceNode);

        // 先插入控制點（在底層）
        this.svgLayer.insertBefore(controlPoint, this.svgLayer.firstChild);

        // 再插入路徑（在上層）
        this.svgLayer.appendChild(path);

        // 滑鼠懸停時顯示控制點
        path.onmouseenter = () => {
            path.setAttribute('stroke-width', '3');
            path.setAttribute('stroke', '#e74c3c');
            controlPoint.style.opacity = '0.8';
        };
        path.onmouseleave = () => {
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke', sourceNode.config.color);
            if (!controlPoint.dataset.dragging) {
                controlPoint.style.opacity = '0';
            }
        };

    }

    /**
     * 使控制點可拖動
     */
    makeControlPointDraggable(controlPoint, edge, path, sourceNode) {
        let isDragging = false;
        let startX, startY;

        const controller = new AbortController();
        edge._abortController = controller; // 記在 edge 上以便刪除時清理

        controlPoint.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            controlPoint.dataset.dragging = 'true';
            controlPoint.style.opacity = '1';
            document.body.style.cursor = 'move';
        }, { signal: controller.signal });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const currentX = parseFloat(controlPoint.getAttribute('cx'));
            const currentY = parseFloat(controlPoint.getAttribute('cy'));

            const newX = currentX + dx;
            const newY = currentY + dy;

            controlPoint.setAttribute('cx', newX);
            controlPoint.setAttribute('cy', newY);

            // 更新連接線路徑
            edge.controlPoint = { x: newX, y: newY };
            const newPath = this.calculateEdgePath(edge);
            if (newPath) {
                path.setAttribute('d', newPath);
            }

            startX = e.clientX;
            startY = e.clientY;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                delete controlPoint.dataset.dragging;
                document.body.style.cursor = 'default';
                controlPoint.style.opacity = '0';
                this.saveToLocalStorage();
            }
        });
    }

    /**
     * 創建曲線路徑（支持自定義控制點）
     */
    createCurvePath(startX, startY, endX, endY, controlPoint = null) {
        if (controlPoint) {
            // 使用自定義控制點創建二次貝茲曲線
            return `M ${startX} ${startY} Q ${controlPoint.x} ${controlPoint.y} ${endX} ${endY} `;
        } else {
            // 使用默認的三次貝茲曲線
            const controlOffset = Math.abs(endX - startX) * 0.5;
            const cp1x = startX + controlOffset;
            const cp1y = startY;
            const cp2x = endX - controlOffset;
            const cp2y = endY;

            return `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY} `;
        }
    }

    /**
     * 刪除連線
     */
    deleteEdge(edgeId) {
        const edge = this.store.removeEdge(edgeId);
        if (edge && edge._abortController) {
            edge._abortController.abort();
        }

        const pathElement = document.getElementById(edgeId);
        if (pathElement) pathElement.remove();

        // 同時刪除控制點
        const controlPoint = this.svgLayer.querySelector(`circle[data-edge-id="${edgeId}"]`);
        if (controlPoint) controlPoint.remove();

        this.updateMinimap();
        this.saveToLocalStorage();
        toast.success('連線已刪除');
    }

    /**
     * 開始連接拖拉 (n8n 風格)
     */
    startConnectionDrag(nodeId, type, event, handleId = 'default') {

        this.connectionDragState.isDragging = true;
        this.connectionDragState.sourceNodeId = nodeId;
        this.connectionDragState.sourceType = type;
        this.connectionDragState.sourceHandle = handleId;

        // 獲取起點坐標
        const connector = event.target;
        const rect = connector.getBoundingClientRect();
        const svgRect = this.svgLayer.getBoundingClientRect();

        const startX = rect.left + rect.width / 2 - svgRect.left;
        const startY = rect.top + rect.height / 2 - svgRect.top;

        this.connectionDragState.mouseX = startX;
        this.connectionDragState.mouseY = startY;

        // 創建臨時連接線
        const tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempLine.setAttribute('stroke', '#2ecc71');
        tempLine.setAttribute('stroke-width', '2');
        tempLine.setAttribute('stroke-dasharray', '5,5');
        tempLine.setAttribute('fill', 'none');
        tempLine.setAttribute('class', 'temp-connection-line');

        this.svgLayer.insertBefore(tempLine, this.svgLayer.firstChild);
        this.connectionDragState.tempLine = tempLine;

        // 添加全局鼠標移動和釋放事件
        document.addEventListener('mousemove', this.boundUpdateConnectionDrag);
        document.addEventListener('mouseup', this.boundEndConnectionDrag);
    }

    /**
     * 更新連接拖拉
     */
    updateConnectionDrag(event) {
        if (!this.connectionDragState.isDragging) return;

        const svgRect = this.svgLayer.getBoundingClientRect();
        const endX = event.clientX - svgRect.left;
        const endY = event.clientY - svgRect.top;

        this.connectionDragState.mouseX = endX;
        this.connectionDragState.mouseY = endY;

        // 獲取起點坐標
        const sourceNode = this.nodes.find(n => n.id === this.connectionDragState.sourceNodeId);
        if (!sourceNode) return;

        const sourceElement = document.getElementById(sourceNode.id);
        if (!sourceElement) return;

        const sourceRect = sourceElement.getBoundingClientRect();
        const startX = sourceRect.right - svgRect.left;
        const startY = sourceRect.top + sourceRect.height / 2 - svgRect.top;

        // 移除之前的高亮
        document.querySelectorAll('.flow-node.connect-target').forEach(n => 
            n.classList.remove('connect-target'));

        // 更新臨時線的路徑
        const path = this.createCurvePath(startX, startY, endX, endY);
        this.connectionDragState.tempLine.setAttribute('d', path);

        // 高亮提示目標
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const targetNode = el?.closest('.flow-node');
        if (targetNode && targetNode.id !== this.connectionDragState.sourceNodeId) {
            targetNode.classList.add('connect-target');
        }
    }

    /**
     * 結束連接拖拉
     */
    endConnectionDrag(event) {
        if (!this.connectionDragState.isDragging) return;

        // 清理臨時線
        if (this.connectionDragState.tempLine) {
            this.connectionDragState.tempLine.remove();
        }

        // 移除高亮
        document.querySelectorAll('.flow-node.connect-target').forEach(n => 
            n.classList.remove('connect-target'));

        const el = document.elementFromPoint(event.clientX, event.clientY);
        const targetNode = el?.closest('.flow-node');

        if (targetNode && targetNode.id !== this.connectionDragState.sourceNodeId) {
            this.createEdge(
                this.connectionDragState.sourceNodeId,
                this.connectionDragState.sourceHandle || 'default',
                targetNode.id,
                'input'
            );
        }

        // 重置狀態
        this.connectionDragState.isDragging = false;
        this.connectionDragState.sourceNodeId = null;
        this.connectionDragState.sourceType = null;
        this.connectionDragState.sourceHandle = 'default';
        this.connectionDragState.tempLine = null;

        // 移除全局事件監聽
        document.removeEventListener('mousemove', this.boundUpdateConnectionDrag);
        document.removeEventListener('mouseup', this.boundEndConnectionDrag);
    }

    /**
     * 檢查是否會形成循環
     */
    wouldCreateCycle(sourceId, targetId) {
        return this.store.wouldCreateCycle(sourceId, targetId);
    }

    /**
     * 更新與節點相關的所有連線
     */
    updateConnectedEdges(nodeId) {

        // 找到所有與此節點相關的連線
        const relatedEdges = this.edges.filter(edge =>
            edge.source === nodeId || edge.target === nodeId
        );


        // 重新繪製每條連線
        relatedEdges.forEach(edge => {
            const pathElement = document.getElementById(edge.id);

            if (pathElement) {
                // 更新路徑（使用 calculateEdgePath 會自動使用正確的貝茲曲線）
                const newPath = this.calculateEdgePath(edge);
                if (newPath) {
                    pathElement.setAttribute('d', newPath);
                } else {
                    console.warn(`[updateConnectedEdges] 無法計算路徑:`, edge);
                }
            } else {
                console.warn(`[updateConnectedEdges] 找不到路徑元素:`, edge.id);
            }
        });
    }

    /**
     * 計算連線的路徑（用於拖動更新）
     */
    calculateEdgePath(edge) {
        const sourceNode = this.nodes.find(n => n.id === edge.source);
        const targetNode = this.nodes.find(n => n.id === edge.target);

        if (!sourceNode || !targetNode) {
            console.warn(`[calculateEdgePath] 找不到節點: ${edge.source} -> ${edge.target} `);
            return null;
        }

        const sourceElement = document.getElementById(edge.source);
        const targetElement = document.getElementById(edge.target);

        if (!sourceElement || !targetElement) {
            console.warn(`[calculateEdgePath] 找不到節點元素`);
            return null;
        }

        // 獲取節點尺寸
        const sourceWidth = sourceElement.offsetWidth;
        const sourceHeight = sourceElement.offsetHeight;
        const targetWidth = targetElement.offsetWidth;
        const targetHeight = targetElement.offsetHeight;

        // 直接使用節點的 position 屬性
        const startX = sourceNode.position.x + sourceWidth;
        const startY = sourceNode.position.y + sourceHeight / 2;
        const endX = targetNode.position.x;
        const endY = targetNode.position.y + targetHeight / 2;

        // 使用保存的控制點（如果有）
        return this.createCurvePath(startX, startY, endX, endY, edge.controlPoint);
    }
}
