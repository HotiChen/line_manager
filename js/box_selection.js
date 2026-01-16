/**
 * 框選多個節點功能
 * 按住 Shift + 拖拉畫出選擇框，框內的節點都被選取
 */

/**
 * 設置框選功能（添加到 FlowDesigner.prototype）
 */
export function setupBoxSelection() {
    let isBoxSelecting = false;
    let startX, startY;
    let selectionBox = null;

    // 建立選擇框元素
    const createSelectionBox = () => {
        if (!selectionBox) {
            selectionBox = document.createElement('div');
            selectionBox.style.cssText = `
                position: absolute;
                border: 2px dashed #3498db;
                background: rgba(52, 152, 219, 0.1);
                pointer-events: none;
                z-index: 999;
                display: none;
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

        // 轉換為相對於畫布的坐標
        const nodeLeft = nodeRect.left - canvasRect.left + this.container.scrollLeft;
        const nodeTop = nodeRect.top - canvasRect.top + this.container.scrollTop;
        const nodeRight = nodeLeft + nodeRect.width;
        const nodeBottom = nodeTop + nodeRect.height;

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

    // 滑鼠按下 - 開始框選
    this.container.addEventListener('mousedown', (e) => {
        // 只在按住 Shift 且點擊空白處時觸發框選
        if (e.shiftKey && (e.target === this.container || e.target === this.canvasContent)) {
            isBoxSelecting = true;

            // 計算相對於畫布的坐標
            const canvasRect = this.canvasContent.getBoundingClientRect();
            startX = e.clientX - canvasRect.left + this.container.scrollLeft;
            startY = e.clientY - canvasRect.top + this.container.scrollTop;

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

        const canvasRect = this.canvasContent.getBoundingClientRect();
        const currentX = e.clientX - canvasRect.left + this.container.scrollLeft;
        const currentY = e.clientY - canvasRect.top + this.container.scrollTop;

        updateSelectionBox(currentX, currentY);

        // 實時更新選取的節點
        const boxRect = {
            left: Math.min(startX, currentX),
            top: Math.min(startY, currentY),
            right: Math.max(startX, currentX),
            bottom: Math.max(startY, currentY)
        };

        selectNodesInBox(boxRect);
    });

    // 滑鼠放開 - 結束框選
    document.addEventListener('mouseup', () => {
        if (isBoxSelecting) {
            isBoxSelecting = false;

            // 隱藏選擇框
            if (selectionBox) {
                selectionBox.style.display = 'none';
            }

            if (this.selectedNodes.length > 0) {
                toast.success(`已選取 ${this.selectedNodes.length} 個節點`);
            }
        }
    });
}
