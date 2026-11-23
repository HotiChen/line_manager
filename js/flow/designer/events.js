// js/flow/designer/events.js
// Events：節點面板、全域快捷鍵與事件、右鍵選單
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { NodeTypeConfig } from '../node_types.js';

export class EventsMethods {
    initNodePalette() {
        const palette = document.getElementById('node-palette');
        if (!palette) return;

        palette.querySelectorAll('.palette-item').forEach(item => {
            // Drag to canvas
            item.addEventListener('dragstart', (e) => {
                // 自訂 MIME：畫布只接受來自節點面板的拖放，不會把選取的文字當成節點類型
                e.dataTransfer.setData('application/x-flow-node', item.dataset.type);
                e.dataTransfer.effectAllowed = 'copy';
            });

            // Click to add at canvas center
            item.addEventListener('click', () => {
                const cx = (this.container.scrollLeft + this.container.offsetWidth / 2) / this.canvasZoom;
                const cy = (this.container.scrollTop + this.container.offsetHeight / 2) / this.canvasZoom;
                this.addNode(item.dataset.type, { x: cx - 100, y: cy - 50 });
            });
        });

        this.container.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-flow-node')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            this.container.classList.add('palette-drag-over');
        });

        this.container.addEventListener('dragleave', (e) => {
            if (!this.container.contains(e.relatedTarget)) {
                this.container.classList.remove('palette-drag-over');
            }
        });

        this.container.addEventListener('drop', (e) => {
            this.container.classList.remove('palette-drag-over');
            const type = e.dataTransfer.getData('application/x-flow-node');
            if (!type) return;
            e.preventDefault();
            const canvasRect = this.container.getBoundingClientRect();
            const canvasX = (e.clientX - canvasRect.left + this.container.scrollLeft) / this.canvasZoom;
            const canvasY = (e.clientY - canvasRect.top + this.container.scrollTop) / this.canvasZoom;
            this.addNode(type, { x: canvasX - 100, y: canvasY - 50 });
        });
    }

    /**
     * 設定事件監聽
     */
    setupEventListeners() {
        // 右鍵選單
        this.container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showContextMenu(e.clientX, e.clientY);
        });

        // 畫布點擊（點擊空白處隱藏側邊欄）
        this.container.addEventListener('click', (e) => {
            // 判斷是否點擊在節點上
            const clickedNode = e.target.closest('.flow-node');
            const clickedConnection = e.target.closest('.edge-path');

            // Z 鍵 focus 模式：點擊節點後聚焦並放大
            if (this.focusMode && clickedNode) {
                const nodeId = clickedNode.id;
                this.focusOnNode(nodeId);
                this.focusMode = false; // 退出 focus 模式
                document.body.style.cursor = 'default';
                toast.success('🎯 已聚焦到節點');
                return;
            }

            // 如果點擊的是空白處（不是節點也不是連線）
            if (!clickedNode && !clickedConnection) {
                this.hideSidebar();
                // 取消選中狀態
                this.selectedNode = null;
                // 移除所有節點的選中樣式
                document.querySelectorAll('.flow-node').forEach(el => {
                    el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
                });
            }
        });

        // 鍵盤快捷鍵
        document.addEventListener('keydown', (e) => {
            // Z 鍵：進入 focus 模式
            if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) {
                // 忽略在輸入框中的按鍵
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
                
                if (!this.focusMode) {
                    this.focusMode = true;
                    document.body.style.cursor = 'crosshair';
                    toast.info('🎯 Focus 模式：點擊節點以聚焦');
                }
            }
            // Escape：退出 focus 模式 / 取消連線拖曳
            if (e.key === 'Escape') {
                if (this.focusMode) {
                    this.focusMode = false;
                    document.body.style.cursor = 'default';
                    toast.info('已退出 Focus 模式');
                }
                if (this.connectionDragState.isDragging) {
                    if (this.connectionDragState.tempLine) this.connectionDragState.tempLine.remove();
                    document.querySelectorAll('.flow-node.connect-target').forEach(n => n.classList.remove('connect-target'));
                    this.connectionDragState.isDragging = false;
                    this.connectionDragState.sourceNodeId = null;
                    this.connectionDragState.sourceHandle = 'default';
                    this.connectionDragState.tempLine = null;
                    document.removeEventListener('mousemove', this.boundUpdateConnectionDrag);
                    document.removeEventListener('mouseup', this.boundEndConnectionDrag);
                }
            }
            // Ctrl+S 儲存
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                this.saveFlow();
            }
            // Delete 刪除選中節點
            if (e.key === 'Delete' && this.selectedNode) {
                // 忽略在輸入框中的按鍵
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
                
                this.deleteNode(this.selectedNode);
            }
            // Ctrl + + 放大
            if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
                e.preventDefault();
                this.zoomCanvas(0.1);
            }
            // Ctrl + - 縮小
            if (e.ctrlKey && e.key === '-') {
                e.preventDefault();
                this.zoomCanvas(-0.1);
            }
            // Ctrl + 0 重置縮放
            if (e.ctrlKey && e.key === '0') {
                e.preventDefault();
                this.resetZoom();
            }
            // Ctrl + F 適應螢幕
            if (e.ctrlKey && e.key === 'f') {
                e.preventDefault();
                this.fitScreen();
            }
            // Ctrl + D 調試流程結構
            if (e.ctrlKey && e.key === 'd') {
                e.preventDefault();
                this.debugFlowStructure();
            }
            // Ctrl+Z 還原
            if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            }
            // Ctrl+Y 或 Ctrl+Shift+Z 重做
            if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                this.redo();
            }
            // Ctrl+C 複製
            if (e.ctrlKey && e.key === 'c') {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                this.copySelected();
            }
            // Ctrl+V 貼上
            if (e.ctrlKey && e.key === 'v') {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                e.preventDefault();
                this.pasteNodes();
            }
            // Ctrl+P 搜尋節點
            if (e.ctrlKey && e.key === 'p') {
                e.preventDefault();
                this.showSearch();
            }
        });

    }

    /**
     * 顯示右鍵選單
     */
    showContextMenu(x, y) {
        // 移除舊選單
        const oldMenu = document.querySelector('.context-menu');
        if (oldMenu) oldMenu.remove();

        // 計算畫布相對位置（考慮捲動）
        const canvasRect = this.container.getBoundingClientRect();
        const canvasX = x - canvasRect.left + this.container.scrollLeft;
        const canvasY = y - canvasRect.top + this.container.scrollTop;

        // 創建選單
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = x + 'px';  // 選單位置使用螢幕座標
        menu.style.top = y + 'px';

        // 儲存畫布座標供節點創建使用
        menu.dataset.canvasX = canvasX;
        menu.dataset.canvasY = canvasY;

        // ✨ 添加視圖控制區塊
        const viewHeader = document.createElement('div');
        viewHeader.className = 'context-menu-header';
        viewHeader.style.cssText = 'padding: 8px 16px; font-weight: bold; color: #666; font-size: 11px;';
        viewHeader.textContent = '縮放';
        menu.appendChild(viewHeader);

        // 100%
        const zoom100Item = document.createElement('div');
        zoom100Item.className = 'context-menu-item';
        zoom100Item.innerHTML = `
        <i class="bi bi-1-square" style="color: #27ae60"></i>
        <span>100%</span>
        ${this.canvasZoom === 1.0 ? '<i class="bi bi-check-lg" style="color: #27ae60; margin-left: auto;"></i>' : ''}
    `; // safe: static icons; canvasZoom is a numeric JS float
        zoom100Item.onclick = () => {
            this.setZoom(1.0, x, y);
            menu.remove();
        };
        menu.appendChild(zoom100Item);

        // 75%
        const zoom75Item = document.createElement('div');
        zoom75Item.className = 'context-menu-item';
        zoom75Item.innerHTML = `
        <i class="bi bi-app" style="color: #16a085"></i>
        <span>75%</span>
        ${this.canvasZoom === 0.75 ? '<i class="bi bi-check-lg" style="color: #27ae60; margin-left: auto;"></i>' : ''}
    `; // safe: static icons; canvasZoom is a numeric JS float
        zoom75Item.onclick = () => {
            this.setZoom(0.75, x, y);
            menu.remove();
        };
        menu.appendChild(zoom75Item);

        // 50%
        const zoom50Item = document.createElement('div');
        zoom50Item.className = 'context-menu-item';
        zoom50Item.innerHTML = `
        <i class="bi bi-zoom-out" style="color: #3498db"></i>
        <span>50%</span>
        ${this.canvasZoom === 0.5 ? '<i class="bi bi-check-lg" style="color: #27ae60; margin-left: auto;"></i>' : ''}
    `; // safe: static icons; canvasZoom is a numeric JS float
        zoom50Item.onclick = () => {
            this.setZoom(0.5, x, y);
            menu.remove();
        };
        menu.appendChild(zoom50Item);

        // 25%
        const zoom25Item = document.createElement('div');
        zoom25Item.className = 'context-menu-item';
        zoom25Item.innerHTML = `
        <i class="bi bi-dash-square" style="color: #e67e22"></i>
        <span>25%</span>
        ${this.canvasZoom === 0.25 ? '<i class="bi bi-check-lg" style="color: #27ae60; margin-left: auto;"></i>' : ''}
    `; // safe: static icons; canvasZoom is a numeric JS float
        zoom25Item.onclick = () => {
            this.setZoom(0.25, x, y);
            menu.remove();
        };
        menu.appendChild(zoom25Item);

        // Fit Screen
        const fitScreenItem = document.createElement('div');
        fitScreenItem.className = 'context-menu-item';
        fitScreenItem.innerHTML = `
        <i class="bi bi-arrows-fullscreen" style="color: #9b59b6"></i>
        <span>適應畫布</span>
    `; // safe: static icon + hardcoded text
        fitScreenItem.onclick = () => {
            this.fitScreen();
            menu.remove();
        };
        menu.appendChild(fitScreenItem);

        // 分隔線
        const viewDivider = document.createElement('div');
        viewDivider.className = 'context-menu-divider';
        menu.appendChild(viewDivider);

        // 節點類別
        const categories = {
            trigger: '觸發器',
            message: '訊息',
            action: '動作',
            end: '其他'
        };

        // 按類別組織選單項目
        Object.entries(categories).forEach(([category, categoryLabel]) => {
            // 添加類別標題
            const header = document.createElement('div');
            header.className = 'context-menu-header';
            header.style.cssText = 'padding: 8px 16px; font-weight: bold; color: #666; font-size: 11px;';
            header.textContent = categoryLabel;
            menu.appendChild(header);

            // 添加該類別的節點類型
            Object.entries(NodeTypeConfig)
                .filter(([_, config]) => config.category === category)
                .forEach(([type, config]) => {
                    const item = document.createElement('div');
                    item.className = 'context-menu-item';
                    item.innerHTML = `
                        <i class="bi ${config.icon}" style="color: ${config.color}"></i>
                        <span>${config.label}</span>
                    `; // safe: config.icon, config.color, config.label are all from NodeTypeConfig constant
                    item.onclick = () => {
                        // ✅ 考慮縮放：將螢幕座標轉換為畫布座標
                        const actualCanvasX = canvasX / this.canvasZoom;
                        const actualCanvasY = canvasY / this.canvasZoom;

                        // 使用畫布座標創建節點（節點會出現在點擊位置）
                        this.addNode(type, {
                            x: actualCanvasX - 100,  // 減去節點寬度的一半，讓節點置中
                            y: actualCanvasY - 50
                        });
                        menu.remove();
                    };
                    menu.appendChild(item);
                });

            // 添加分隔線
            if (category !== 'end') {
                const divider = document.createElement('div');
                divider.className = 'context-menu-divider';
                menu.appendChild(divider);
            }
        });

        document.body.appendChild(menu);

        // 點擊其他地方關閉
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 0);
    }
}
