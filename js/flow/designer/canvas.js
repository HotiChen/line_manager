// js/flow/designer/canvas.js
// Canvas：畫布平移、框選、觸控手勢、縮放
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';

export class CanvasMethods {
    /**
     * 創建 SVG 圖層用於繪製連線
     */
    createSvgLayer() {
        // 創建內容容器
        const content = document.createElement('div');
        content.id = 'canvas-content';
        content.style.position = 'relative';  // 讓 absolute 的選擇框相對於此定位
        this.container.appendChild(content);
        this.canvasContent = content;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'connections-layer';
        svg.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        `;
        content.insertBefore(svg, content.firstChild);
        this.svgLayer = svg;

        // ✨ 添加箭頭標記定義
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', 'arrowhead');
        marker.setAttribute('markerWidth', '10');
        marker.setAttribute('markerHeight', '10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        marker.setAttribute('markerUnits', 'strokeWidth');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M0,0 L0,6 L9,3 z');
        path.setAttribute('fill', '#94a3b8');  // 箭頭顏色（灰藍色）

        marker.appendChild(path);
        defs.appendChild(marker);
        svg.appendChild(defs);

        // 設置畫布平移
        this.setupCanvasPanning();

        // 設置框選功能
        this.setupBoxSelection();

        // 初始化畫布位置（置中）
        this.container.scrollLeft = (this.canvasContent.offsetWidth - this.container.offsetWidth) / 2;
        this.container.scrollTop = (this.canvasContent.offsetHeight - this.container.offsetHeight) / 2;
    }

    /**
     * 設置畫布平移（空白處拖曳）
     */
    setupCanvasPanning() {
        let isPanning = false;
        let startX, startY, scrollLeft, scrollTop;

        // 滑鼠按下
        this.container.addEventListener('mousedown', (e) => {
            // 只在點擊空白處且未按 Alt 時觸發（Alt 用於框選）
            if (!e.altKey && (e.target === this.container || e.target === this.canvasContent)) {
                isPanning = true;
                this.container.classList.add('panning');
                startX = e.clientX;
                startY = e.clientY;
                scrollLeft = this.container.scrollLeft;
                scrollTop = this.container.scrollTop;
                e.preventDefault();
            }
        });

        // 滑鼠移動
        document.addEventListener('mousemove', (e) => {
            if (!isPanning) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            this.container.scrollLeft = scrollLeft - dx;
            this.container.scrollTop = scrollTop - dy;
        });

        // 滑鼠放開
        document.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                this.container.classList.remove('panning');
            }
        });

        // ✨ 滾輪縮放（Ctrl + 滾輪）
        this.container.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();

                // 根據滾輪方向縮放
                const delta = e.deltaY > 0 ? -0.1 : 0.1;

                // 計算滑鼠位置（用於縮放中心點）
                const rect = this.container.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                this.zoomAtPoint(delta, mouseX, mouseY);
            }
        }, { passive: false });

        // ✨ 觸控板/觸控螢幕手勢支援
        this.setupTouchGestures();
    }

    /**
     * 設置框選功能 (Alt + 拖拉)
     */
    setupBoxSelection() {
        let isBoxSelecting = false;
        let startX, startY;
        let selectionBox = null;

        // 創建選擇框元素
        const createSelectionBox = () => {
            if (!selectionBox) {
                selectionBox = document.createElement('div');
                selectionBox.id = 'selection-box';
                selectionBox.style.cssText = `
                    position: absolute;
                    border: 3px dashed #3498db;
                    background: rgba(52, 152, 219, 0.2);
                    pointer-events: none;
                    z-index: 10000;
                    display: none;
                    box-shadow: 0 0 10px rgba(52, 152, 219, 0.5);
                `;
                this.canvasContent.appendChild(selectionBox);
            }
            return selectionBox;
        };

        // 更新選擇框位置和大小
        const updateSelectionBox = (currentX, currentY) => {
            const box = createSelectionBox();
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);

            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${width}px`;
            box.style.height = `${height}px`;
            box.style.display = 'block';
        };

        // 檢查節點是否在選擇框內
        const isNodeInBox = (node, boxRect) => {
            const nodeElement = document.getElementById(node.id);
            if (!nodeElement) return false;

            const nodeRect = nodeElement.getBoundingClientRect();
            const canvasRect = this.canvasContent.getBoundingClientRect();

            // 座標轉換 - 考慮 zoom
            const nodeLeft = (nodeRect.left - canvasRect.left) / this.canvasZoom;
            const nodeTop = (nodeRect.top - canvasRect.top) / this.canvasZoom;
            const nodeRight = nodeLeft + (nodeRect.width / this.canvasZoom);
            const nodeBottom = nodeTop + (nodeRect.height / this.canvasZoom);

            // 檢查是否重疊
            return !(boxRect.right < nodeLeft ||
                boxRect.left > nodeRight ||
                boxRect.bottom < nodeTop ||
                boxRect.top > nodeBottom);
        };

        // 選取框內的所有節點
        const selectNodesInBox = (boxRect) => {
            this.selectedNodes = this.nodes.filter(node => isNodeInBox(node, boxRect));

            // 更新視覺狀態
            this.nodes.forEach(node => {
                const element = document.getElementById(node.id);
                if (element) {
                    if (this.selectedNodes.includes(node)) {
                        element.classList.add('multi-selected');
                    } else {
                        element.classList.remove('multi-selected');
                    }
                }
            });

            if (this.selectedNodes.length > 0) {
            }
        };

        // Alt + 滑鼠按下 - 開始框選
        this.container.addEventListener('mousedown', (e) => {
            if (e.altKey && (e.target === this.container || e.target === this.canvasContent)) {
                isBoxSelecting = true;

                // 計算起點座標 - 考慮 zoom
                const canvasRect = this.canvasContent.getBoundingClientRect();
                startX = (e.clientX - canvasRect.left) / this.canvasZoom;
                startY = (e.clientY - canvasRect.top) / this.canvasZoom;

                // 清除之前的選取
                if (!e.ctrlKey && !e.metaKey) {
                    this.selectedNodes = [];
                    this.nodes.forEach(node => {
                        const element = document.getElementById(node.id);
                        if (element) element.classList.remove('multi-selected');
                    });
                }

                e.preventDefault();
            }
        });

        // 滑鼠移動 - 更新框選框
        document.addEventListener('mousemove', (e) => {
            if (!isBoxSelecting) return;

            // 計算當前座標 - 考慮 zoom
            const canvasRect = this.canvasContent.getBoundingClientRect();
            const currentX = (e.clientX - canvasRect.left) / this.canvasZoom;
            const currentY = (e.clientY - canvasRect.top) / this.canvasZoom;

            updateSelectionBox(currentX, currentY);

            // 實時更新選取的節點
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const right = Math.max(startX, currentX);
            const bottom = Math.max(startY, currentY);

            selectNodesInBox({ left, top, right, bottom });
        });

        // 滑鼠放開 - 結束框選
        document.addEventListener('mouseup', () => {
            if (isBoxSelecting) {
                isBoxSelecting = false;
                // 隱藏選擇框
                if (selectionBox) {
                    selectionBox.style.display = 'none';
                }
            }
        });

        // 點擊空白處或未選中節點時取消選擇
        document.addEventListener('mousedown', (e) => {
            if (isBoxSelecting) return;  // 正在框選時不處理
            if (e.altKey) return;  // 準備框選時不處理

            // 檢查是否點擊了已選中的節點
            const clickedNode = e.target.closest('.flow-node');
            if (clickedNode && this.selectedNodes.some(n => n.id === clickedNode.id)) {
                return;  // 點擊已選中節點，不取消（準備拖動）
            }

            // 其他情況：取消所有選擇
            if (this.selectedNodes.length > 0) {
                this.selectedNodes = [];
                this.nodes.forEach(node => {
                    const element = document.getElementById(node.id);
                    if (element) element.classList.remove('multi-selected');
                });
            }
        });
    }

    /**
     * 設置觸控手勢
     */
    setupTouchGestures() {
        let initialDistance = 0;
        let initialZoom = 1.0;
        let touches = [];

        // 觸控開始
        this.container.addEventListener('touchstart', (e) => {
            touches = Array.from(e.touches);

            if (touches.length === 2) {
                // 雙指操作，記錄初始距離
                e.preventDefault();
                const dx = touches[0].clientX - touches[1].clientX;
                const dy = touches[0].clientY - touches[1].clientY;
                initialDistance = Math.sqrt(dx * dx + dy * dy);
                initialZoom = this.canvasZoom;
            }
        }, { passive: false });

        // 觸控移動
        this.container.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                // 雙指縮放
                e.preventDefault();

                const touches = Array.from(e.touches);
                const dx = touches[0].clientX - touches[1].clientX;
                const dy = touches[0].clientY - touches[1].clientY;
                const currentDistance = Math.sqrt(dx * dx + dy * dy);

                // 計算縮放比例變化
                const scale = currentDistance / initialDistance;
                const newZoom = initialZoom * scale;

                // 應用縮放
                this.canvasZoom = Math.max(0.25, Math.min(3.0, newZoom));
                this.applyCanvasZoom();
            }
        }, { passive: false });

        // 觸控結束
        this.container.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) {
                initialDistance = 0;

                // 顯示最終縮放比例
                if (initialZoom !== this.canvasZoom) {
                    const percentage = Math.round(this.canvasZoom * 100);
                    toast.success(`縮放: ${percentage}%`);
                }
            }
        });
    }

    /**
     * 縮放畫布
     */
    zoomCanvas(delta) {
        const oldZoom = this.canvasZoom;
        this.canvasZoom = Math.max(0.25, Math.min(3.0, this.canvasZoom + delta));

        if (oldZoom === this.canvasZoom) {
            if (this.canvasZoom >= 3.0) {
                toast.info('已達最大縮放 (300%)');
            } else {
                toast.info('已達最小縮放 (25%)');
            }
            return;
        }

        // 應用縮放
        this.applyCanvasZoom();

        const percentage = Math.round(this.canvasZoom * 100);
        // toast.success(`縮放: ${percentage}%`); // 移除：縮放時不顯示 toast
    }

    /**
     * 在指定點縮放（用於滾輪縮放）
     */
    zoomAtPoint(delta, mouseX, mouseY) {
        const oldZoom = this.canvasZoom;
        this.canvasZoom = Math.max(0.25, Math.min(3.0, this.canvasZoom + delta));

        if (oldZoom === this.canvasZoom) return;

        // 計算縮放前的滾動位置
        const oldScrollX = this.container.scrollLeft;
        const oldScrollY = this.container.scrollTop;

        // 應用縮放
        this.applyCanvasZoom();

        // 調整滾動位置，使滑鼠位置保持不變
        const zoomRatio = this.canvasZoom / oldZoom;
        const newScrollX = (oldScrollX + mouseX) * zoomRatio - mouseX;
        const newScrollY = (oldScrollY + mouseY) * zoomRatio - mouseY;

        this.container.scrollLeft = newScrollX;
        this.container.scrollTop = newScrollY;

        const percentage = Math.round(this.canvasZoom * 100);
        // toast.success(`縮放: ${percentage}%`); // 移除：滾輪縮放時不顯示 toast
    }

    /**
     * 設定固定縮放級別（以滑鼠位置為中心）
     */
    setZoom(zoom, mouseX = null, mouseY = null) {
        const oldZoom = this.canvasZoom;
        this.canvasZoom = zoom;

        // 如果有滑鼠位置，以滑鼠為中心縮放
        if (mouseX !== null && mouseY !== null) {
            const containerRect = this.container.getBoundingClientRect();
            const relativeX = mouseX - containerRect.left;
            const relativeY = mouseY - containerRect.top;

            // 計算縮放前的滾動位置
            const oldScrollX = this.container.scrollLeft;
            const oldScrollY = this.container.scrollTop;

            // 應用縮放
            this.applyCanvasZoom();

            // 調整滾動位置，使滑鼠位置保持不變
            const zoomRatio = this.canvasZoom / oldZoom;
            const newScrollX = (oldScrollX + relativeX) * zoomRatio - relativeX;
            const newScrollY = (oldScrollY + relativeY) * zoomRatio - relativeY;

            this.container.scrollLeft = newScrollX;
            this.container.scrollTop = newScrollY;
        } else {
            // 沒有滑鼠位置，直接縮放
            this.applyCanvasZoom();
        }

        const percentage = Math.round(zoom * 100);
        toast.success(`縮放: ${percentage}%`);
    }

    /**
     * 重置縮放
     */
    resetZoom() {
        this.canvasZoom = 1.0;
        this.applyCanvasZoom();
        toast.success('縮放已重置 (100%)');
    }

    /**
     * 適應螢幕（顯示所有節點）
     */
    fitScreen() {
        if (this.nodes.length === 0) {
            toast.warning('沒有節點可顯示');
            return;
        }

        // 計算所有節點的邊界
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        this.nodes.forEach(node => {
            const x = node.position.x;
            const y = node.position.y;
            const width = 250; // 節點平均寬度
            const height = 200; // 節點平均高度

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
        });

        // 計算需要的縮放比例
        const contentWidth = maxX - minX + 100; // 添加邊距
        const contentHeight = maxY - minY + 100;
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        const scaleX = containerWidth / contentWidth;
        const scaleY = containerHeight / contentHeight;
        const targetZoom = Math.min(scaleX, scaleY, 1.0); // 最大不超過 100%

        this.canvasZoom = Math.max(0.25, targetZoom);
        this.applyCanvasZoom();

        // 置中顯示
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        this.container.scrollLeft = centerX * this.canvasZoom - containerWidth / 2;
        this.container.scrollTop = centerY * this.canvasZoom - containerHeight / 2;

        const percentage = Math.round(this.canvasZoom * 100);
        toast.success(`已適應螢幕 (${percentage}%)`);
    }

    /**
     * 聚焦到指定節點（居中並放大）
     */
    focusOnNode(nodeId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // 設置縮放為 1.5x
        this.canvasZoom = 1.5;
        this.applyCanvasZoom();

        // 獲取容器尺寸
        const containerW = this.container.clientWidth;
        const containerH = this.container.clientHeight;

        // 直接調整容器的滾動位置 (考慮縮放後的座標)
        this.container.scrollLeft = node.position.x * this.canvasZoom - containerW / 2 + (100 * this.canvasZoom);
        this.container.scrollTop = node.position.y * this.canvasZoom - containerH / 2 + (50 * this.canvasZoom);

        // 選中該節點
        this.selectNode(nodeId);
        this.showNodeProperties(nodeId);
    }

    /**
     * 應用畫布縮放
     */
    applyCanvasZoom() {
        if (!this.canvasContent) return;

        this.canvasContent.style.transform = `scale(${this.canvasZoom})`;
        this.canvasContent.style.transformOrigin = 'top left';

        // 調整內容容器大小以配合縮放
        const baseSize = 5000;
        this.canvasContent.style.width = `${baseSize}px`;
        this.canvasContent.style.height = `${baseSize}px`;
    }
}
