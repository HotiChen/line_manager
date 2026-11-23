// js/flow/designer/node_view.js
// Node view：節點的建立、渲染、拖曳、選取、刪除
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { setInnerHTML } from '../../../helper/security.js';
import FlowNodeAdapter from '../../flow_node_adapter.js';
import { NodeTypes, NodeTypeConfig, getDefaultNodeData } from '../node_types.js';
import { bindActions } from './actions.js';

export class NodeViewMethods {
    findOpenPosition(baseX, baseY) {
        const SPACING = 40;
        let x = baseX, y = baseY;
        let attempts = 0;
        
        while (attempts < 50) {
            const overlap = this.nodes.some(n =>
                Math.abs(n.position.x - x) < 200 &&
                Math.abs(n.position.y - y) < 100
            );
            if (!overlap) break;
            x += SPACING;
            y += SPACING;
            attempts++;
        }
        return { x, y };
    }

    /**
     * 新增節點
     */
    addNode(type, position, silent = false) {
        // 改進的 ID 生成：時間戳 + 隨機數，避免快速創建時的衝突
        const nodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const config = NodeTypeConfig[type];

        // 碰撞避免
        const openPosition = this.findOpenPosition(position.x, position.y);

        // ✅ 防護：如果找不到配置，提供默認值
        if (!config) {
            console.error(`[addNode] 找不到節點類型配置: ${type}`);
            console.error(`[addNode] 可用的節點類型:`, Object.keys(NodeTypeConfig));
            toast.error(`無效的節點類型: ${type}`);
            return null;
        }

        const node = {
            id: nodeId,
            type: type,
            position: openPosition,
            data: this.getDefaultNodeData(type),
            config: config
        };

        this.store.addNode(node);
        this.renderNode(node);
        this.updateMinimap();
        this.saveToLocalStorage();

        if (!silent) {
            toast.success(`已新增 ${config.label} 節點`);
        }

        return node;
    }

    /**
     * 取得預設節點資料
     */
    getDefaultNodeData(type) {
        return getDefaultNodeData(type);
    }

    /**
     * 渲染節點（簡化版，實際使用 React Flow）
     */
    renderNode(node) {
        const nodeElement = document.createElement('div');
        nodeElement.className = `flow-node node-${node.config.category}`;
        nodeElement.id = node.id;

        // 節點縮放比例（預設 1.0）
        if (!node.scale) node.scale = 1.0;

        // 根據節點類型調整寬度
        let baseWidth = 180;
        let maxWidth = 220;

        if (node.type === NodeTypes.RICHMENU && node.data.imageUrl) {
            baseWidth = 250;
            maxWidth = 300;
        } else if (node.type === NodeTypes.MESSAGE_FLEX && node.data.contents) {
            // Flex Message 需要更大的寬度
            if (node.data.contents.type === 'carousel') {
                baseWidth = 300;
                maxWidth = 800; // Carousel 可以更寬
            } else {
                baseWidth = 250;
                maxWidth = 300;
            }
        }

        const scaledWidth = baseWidth * node.scale;

        nodeElement.style.cssText = `
            position: absolute;
            left: ${node.position.x}px;
            top: ${node.position.y}px;
            background: white;
            border: 2px solid ${node.config.color};
            border-radius: 8px;
            padding: 12px;
            min-width: ${scaledWidth}px;
            max-width: ${maxWidth}px;
            cursor: move;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            transform: scale(${node.scale});
            transform-origin: top left;
            transition: transform 0.2s ease;
        `;

        // 基本標題 + 縮放控制
        let innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="bi ${node.config.icon}" style="color: ${node.config.color}"></i>
                    <span style="font-weight: bold;">${node.data.label || node.data.name || node.config.label}</span>
                </div>
                <div class="node-zoom-controls" style="display: flex; gap: 4px;">
                    <button data-on="click:zoomNode" data-node-id="${node.id}" data-delta="0.1" data-stop 
                            style="width: 20px; height: 20px; border: none; background: #ecf0f1; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;"
                            title="放大">+</button>
                    <button data-on="click:zoomNode" data-node-id="${node.id}" data-delta="-0.1" data-stop 
                            style="width: 20px; height: 20px; border: none; background: #ecf0f1; border-radius: 3px; cursor: pointer; font-size: 12px; line-height: 1;"
                            title="縮小">-</button>
                </div>
            </div>
        `;

        // 特殊處理：Richmenu 節點顯示圖片和按鈕區域
        if (node.type === NodeTypes.RICHMENU && node.data.imageUrl) {
            const imageContainerId = `richmenu-img-${node.id}`;
            innerHTML += `
                <div style="margin-bottom: 8px; position: relative;" id="${imageContainerId}">
                    <img src="${node.data.imageUrl}" 
                         style="width: 100%; height: auto; border-radius: 4px; border: 1px solid #ddd; display: block;"
                         alt="${node.data.name}"
                         data-on="load:drawRichmenuButtons" data-node-id="${node.id}" data-container-id="${imageContainerId}">
                </div>
                <div style="font-size: 11px; color: #666; margin-bottom: 4px;">
                    <strong>${node.data.name}</strong>
                </div>
                <div style="font-size: 10px; color: #999;">
                    ${node.data.buttons.length} 個按鈕
                </div>
            `;
        } else if (node.type === NodeTypes.MESSAGE_FLEX && node.data.contents) {
            // 特殊處理：Flex Message 節點直接渲染完整內容
            const flexContainerId = `flex-container-${node.id}`;

            innerHTML += `
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 11px; font-weight: bold; color: #495057; margin-bottom: 6px;">
                        ${node.data.title || '未命名'}
                    </div>
                    <div id="${flexContainerId}" class="flex-preview-wrapper" style="overflow-x: auto; max-width: 100%;"></div>
                </div>
            `;

            // 添加輸出點
            innerHTML += `
                <div class="node-output-point"
                     data-node-id="${node.id}"
                     data-output="default"
                     data-on="mousedown:startConnectionDrag" data-handle="default" data-stop
                     style="position: absolute; right: -8px; top: 50%; transform: translateY(-50%);
                            width: 16px; height: 16px; background: ${node.config.color};
                            border: 2px solid white; border-radius: 50%; cursor: crosshair;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);"
                     title="拖曳以連接到下一個節點">
                </div>
            `;
        } else if (node.type === NodeTypes.MESSAGE_IMAGEMAP && (node.data.imageUrl || node.data.baseUrl)) {
            // 特殊處理：Imagemap 節點顯示圖片和可點擊區域
            const imagemapImageUrl = node.data.imageUrl || node.data.baseUrl;
            const imageContainerId = `imagemap-img-${node.id}`;

            innerHTML += `
                <div style="margin-bottom: 8px; position: relative;" id="${imageContainerId}">
                    <img src="${imagemapImageUrl}" 
                         style="width: 100%; height: auto; border-radius: 4px; border: 1px solid #ddd; display: block; max-width: 280px;"
                         alt="${node.data.altText || node.data.title || 'Imagemap'}"
                         data-on="load:drawImagemapAreas error:showImageFallback" data-node-id="${node.id}" data-container-id="${imageContainerId}">
                    <div style="display: none; padding: 20px; background: #f8f9fa; border-radius: 4px; text-align: center; color: #6c757d;">
                        <i class="bi bi-image" style="font-size: 24px;"></i>
                        <div style="font-size: 11px; margin-top: 8px;">圖片載入失敗</div>
                    </div>
                </div>
                <div style="font-size: 11px; color: #666; margin-bottom: 4px;">
                    <strong>${node.data.altText || node.data.title || 'Imagemap'}</strong>
                </div>
                ${node.data.actions && node.data.actions.length > 0 ? `
                    <div style="font-size: 10px; color: #999;">
                        ${node.data.actions.length} 個可點擊區域
                    </div>
                ` : ''}
            `;

            // 添加輸出點
            innerHTML += `
                <div class="node-output-point"
                     data-node-id="${node.id}"
                     data-output="default"
                     data-on="mousedown:startConnectionDrag" data-handle="default" data-stop
                     style="position: absolute; right: -8px; top: 50%; transform: translateY(-50%);
                            width: 16px; height: 16px; background: ${node.config.color};
                            border: 2px solid white; border-radius: 50%; cursor: crosshair;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);"
                     title="拖曳以連接到下一個節點">
                </div>
            `;
        } else {
            // 其他節點類型的預覽
            innerHTML += `
                <div class="node-preview" style="font-size: 12px; color: #666;">
                    ${this.getNodeDataPreview(node)}
                </div>
            `;

            // 條件判斷：「是」「否」兩個輸出口
            if (node.type === NodeTypes.ACTION_CONDITION) {
                const dot = (handle, top, color, label) => `
                    <div class="node-output-point"
                         data-node-id="${node.id}"
                         data-output="${handle}"
                         data-on="mousedown:startConnectionDrag" data-handle="${handle}" data-stop
                         style="position: absolute; right: -8px; top: ${top}; transform: translateY(-50%);
                                width: 16px; height: 16px; background: ${color};
                                border: 2px solid white; border-radius: 50%; cursor: crosshair;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.2);"
                         title="${label}時走這條">
                    </div>
                    <span style="position: absolute; right: 14px; top: ${top}; transform: translateY(-50%); font-size: 10px; font-weight: bold; color: ${color}; pointer-events: none;">${label}</span>`;
                innerHTML += dot('true', '30%', '#27ae60', '是') + dot('false', '70%', '#e74c3c', '否');
            } else if (node.type !== NodeTypes.END) {
                // 添加單一輸出點
                innerHTML += `
                    <div class="node-output-point"
                         data-node-id="${node.id}"
                         data-output="default"
                         data-on="mousedown:startConnectionDrag" data-handle="default" data-stop
                         style="position: absolute; right: -8px; top: 50%; transform: translateY(-50%);
                                width: 16px; height: 16px; background: ${node.config.color};
                                border: 2px solid white; border-radius: 50%; cursor: crosshair;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.2);"
                         title="拖曳以連接到下一個節點">
                    </div>
                `;
            }
        }

        setInnerHTML(nodeElement, innerHTML);
        bindActions(nodeElement, this);

        // 點擊選中
        nodeElement.onclick = (e) => {
            e.stopPropagation();
            this.selectNode(node.id);
        };

        // 雙擊編輯節點
        nodeElement.ondblclick = (e) => {
            e.stopPropagation();

            // 使用 FlowNodeAdapter 開啟編輯器
            FlowNodeAdapter.editNode(node, (updatedNode) => {
                // 更新節點資料

                // 重新渲染節點
                const oldElement = document.getElementById(node.id);
                if (oldElement) {
                    oldElement.remove();
                }
                this.renderNode(node);

                // 更新連線
                this.updateConnectedEdges(node.id);

                // 儲存
                this.saveToLocalStorage();
            });
        };

        // 添加連接端點（左側輸入和右側輸出）
        const leftConnector = document.createElement('div');
        leftConnector.className = 'node-connector node-input';
        leftConnector.dataset.nodeId = node.id;
        leftConnector.dataset.type = 'input';
        leftConnector.style.cssText = `
            position: absolute;
            left: -6px;
            top: 50%;
            transform: translateY(-50%);
            width: 12px;
            height: 12px;
            background: white;
            border: 2px solid #3498db;
            border-radius: 50%;
            cursor: pointer;
            z-index: 10;
            transition: all 0.2s;
        `;

        const rightConnector = document.createElement('div');
        rightConnector.className = 'node-connector node-output';
        rightConnector.dataset.nodeId = node.id;
        rightConnector.dataset.type = 'output';
        rightConnector.style.cssText = `
            position: absolute;
            right: -6px;
            top: 50%;
            transform: translateY(-50%);
            width: 12px;
            height: 12px;
            background: white;
            border: 2px solid #2ecc71;
            border-radius: 50%;
            cursor: pointer;
            z-index: 10;
            transition: all 0.2s;
        `;

        // 輸出點：開始拖拉創建連接
        rightConnector.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            this.startConnectionDrag(node.id, 'output', e);
        });

        // 輸入點：懸停提示
        leftConnector.addEventListener('mouseenter', () => {
            if (this.connectionDragState?.isDragging) {
                leftConnector.style.transform = 'translateY(-50%) scale(1.5)';
                leftConnector.style.borderColor = '#2ecc71';
                leftConnector.style.background = '#2ecc71';
            }
        });

        leftConnector.addEventListener('mouseleave', () => {
            leftConnector.style.transform = 'translateY(-50%) scale(1)';
            leftConnector.style.borderColor = '#3498db';
            leftConnector.style.background = 'white';
        });

        nodeElement.appendChild(leftConnector);
        // 條件節點只能從「是 / 否」兩個輸出口連出，不要通用的中間輸出點（那條連線執行時不會被選中）
        if (node.type !== NodeTypes.ACTION_CONDITION) nodeElement.appendChild(rightConnector);

        // 拖曳功能
        this.makeDraggable(nodeElement, node);

        this.canvasContent.appendChild(nodeElement);

        // 特殊處理：Flex Message 渲染
        if (node.type === NodeTypes.MESSAGE_FLEX && node.data.contents) {
            const flexContainerId = `flex-container-${node.id}`;

            // 延遲一下確保 DOM 已經插入
            setTimeout(async () => {
                try {

                    // 使用全域的 createNameCardComponent
                    if (typeof window.createNameCardComponent !== 'function') {
                        console.error('[Flex Render] createNameCardComponent 尚未載入');
                        const container = document.getElementById(flexContainerId);
                        if (container) {
                            container.innerHTML = '<div style="color: orange; font-size: 10px;">等待模組載入...</div>'; // safe: static message, no user input
                        }
                        // 重試一次
                        setTimeout(() => {
                            if (typeof window.createNameCardComponent === 'function') {
                                this.renderNode(node);
                            }
                        }, 1000);
                        return;
                    }

                    const createNameCardComponent = window.createNameCardComponent;

                    const container = document.getElementById(flexContainerId);
                    if (!container) {
                        console.error('[Flex Render] 容器不存在:', flexContainerId);
                        return;
                    }

                    // 清空容器
                    container.innerHTML = ''; // safe: clear before appending flex rendered components

                    // 如果是 carousel，使用正確的 Carousel 結構
                    if (node.data.contents.type === 'carousel' && Array.isArray(node.data.contents.contents)) {

                        // 創建 chatbox wrapper
                        const chatbox = document.createElement('div');
                        chatbox.className = 'chatbox';

                        // 創建 Carousel 結構
                        const lySlider = document.createElement('div');
                        lySlider.className = 'LySlider';

                        const lyInner = document.createElement('div');
                        lyInner.className = 'lyInner';

                        node.data.contents.contents.forEach((bubble, index) => {
                            try {

                                const component = createNameCardComponent(bubble, false, false, null);
                                if (component) {
                                    lyInner.appendChild(component);
                                } else {
                                    console.warn(`[Flex Render] Bubble ${index} 返回 null`);
                                }
                            } catch (err) {
                                console.error(`[Flex Render] 渲染 carousel bubble ${index} 失敗: `, err);
                            }
                        });

                        lySlider.appendChild(lyInner);
                        chatbox.appendChild(lySlider);
                        container.appendChild(chatbox);
                    }
                    // 如果是 bubble
                    else if (node.data.contents.type === 'bubble') {

                        // 創建 chatbox wrapper
                        const chatbox = document.createElement('div');
                        chatbox.className = 'chatbox';

                        const component = createNameCardComponent(node.data.contents, false, false, null);
                        if (component) {
                            chatbox.appendChild(component);
                            container.appendChild(chatbox);
                        } else {
                            console.warn('[Flex Render] createNameCardComponent 返回 null');
                        }
                    }

                } catch (error) {
                    console.error('[Flex Render] Flex Message 渲染錯誤:', error);
                    console.error('[Flex Render] Error stack:', error.stack);
                    const container = document.getElementById(flexContainerId);
                    if (container) {
                        const errDiv = document.createElement('div');
                        errDiv.style.color = 'red';
                        errDiv.style.fontSize = '10px';
                        errDiv.textContent = '渲染失敗: ' + error.message;
                        container.appendChild(errDiv);
                    }
                }
            }, 10);
        }
    }

    /**
     * 取得節點資料預覽
     */
    getNodeDataPreview(node) {
        switch (node.type) {
            case NodeTypes.MESSAGE_TEXT:
                return node.data.text ? node.data.text.substring(0, 30) + (node.data.text.length > 30 ? '...' : '') : '未設定';
            case NodeTypes.MESSAGE_SEQUENCE:
                const count = node.data.messages?.length || 0;
                return `📬 ${count}/5 個訊息`;
            case NodeTypes.MESSAGE_FLEX:
                return node.data.title || '未設定';
            case NodeTypes.MESSAGE_IMAGEMAP:
                return node.data.altText || node.data.title || '未設定';
            case NodeTypes.RICHMENU:
                return node.data.name || '未設定';
            case NodeTypes.ACTION_DELAY:
                return `等待 ${node.data.seconds} 秒`;
            case NodeTypes.MESSAGE_IMAGE:
                return node.data.url ? `🖼 ${node.data.url.substring(0, 28)}${node.data.url.length > 28 ? '...' : ''}` : '未設定圖片網址';
            case NodeTypes.ACTION_CONDITION: {
                const n = (node.data.conditions || []).length;
                return n ? `${n} 個條件` : '未設定條件';
            }
            case NodeTypes.ACTION_API: {
                let host = '';
                try { host = new URL(node.data.url).hostname; } catch { /* 還沒填 */ }
                return host ? `${node.data.method || 'GET'} ${host}` : '未設定網址';
            }
            case NodeTypes.URL:
                return node.data.url || '未設定 URL';
            case NodeTypes.POSTBACK:
                return node.data.data || '未設定 Data';
            default:
                return node.config.description;
        }
    }

    /**
     * 縮放節點
     */
    zoomNode(nodeId, delta) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // 更新縮放比例（限制在 0.5 到 2.0 之間）
        node.scale = Math.max(0.5, Math.min(2.0, (node.scale || 1.0) + delta));

        // 重新渲染節點
        const nodeElement = document.getElementById(nodeId);
        if (nodeElement) {
            nodeElement.remove();
            this.renderNode(node);
        }

        this.saveToLocalStorage();
    }

    /**
     * 使節點可拖曳
     */
    makeDraggable(element, node) {
        let isDragging = false;
        let startX, startY;
        let isMultiDragging = false;
        let multiDragData = [];

        element.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('bi')) return; // 忽略圖示點擊
            if (e.target.tagName === 'BUTTON') return; // 忽略按鈕點擊

            // ✨ 檢查是否是批量拖動
            const isSelected = this.selectedNodes.includes(node);

            if (isSelected && this.selectedNodes.length > 1) {
                // 批量拖動模式
                isMultiDragging = true;
                isDragging = true;

                const mouseStartX = e.clientX / this.canvasZoom;
                const mouseStartY = e.clientY / this.canvasZoom;

                multiDragData = this.selectedNodes.map(n => ({
                    node: n,
                    offsetX: mouseStartX - n.position.x,
                    offsetY: mouseStartY - n.position.y
                }));

                element.style.zIndex = 1000;
            } else {
                // 單節點拖動模式
                isDragging = true;
                startX = (e.clientX / this.canvasZoom) - node.position.x;
                startY = (e.clientY / this.canvasZoom) - node.position.y;
                element.style.zIndex = 1000;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            if (isMultiDragging) {
                // ✨ 批量拖動
                const mouseX = e.clientX / this.canvasZoom;
                const mouseY = e.clientY / this.canvasZoom;

                multiDragData.forEach(({ node, offsetX, offsetY }) => {
                    node.position.x = mouseX - offsetX;
                    node.position.y = mouseY - offsetY;

                    const nodeElement = document.getElementById(node.id);
                    if (nodeElement) {
                        nodeElement.style.left = node.position.x + 'px';
                        nodeElement.style.top = node.position.y + 'px';
                    }
                });

                // ✅ 更新所有相關連接線（會重新計算路徑）
                multiDragData.forEach(({ node }) => {
                    this.updateConnectedEdges(node.id);
                });
            } else {
                // 單節點拖動
                node.position.x = (e.clientX / this.canvasZoom) - startX;
                node.position.y = (e.clientY / this.canvasZoom) - startY;
                element.style.left = node.position.x + 'px';
                element.style.top = node.position.y + 'px';

                if (!this._dragUpdateScheduled) {
                    this._dragUpdateScheduled = true;
                    requestAnimationFrame(() => {
                        this.updateConnectedEdges(node.id);
                        this._dragUpdateScheduled = false;
                    });
                }
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                isMultiDragging = false;
                multiDragData = [];
                element.style.zIndex = 1;
                this.updateMinimap();
                this.saveToLocalStorage();
            }
        });
    }

    /**
     * 選中節點
     */
    selectNode(nodeId) {
        // 移除之前的選中狀態
        document.querySelectorAll('.flow-node').forEach(el => {
            el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
        });

        // 選中新節點
        const element = document.getElementById(nodeId);
        if (element) {
            element.style.boxShadow = '0 0 0 3px rgba(52, 152, 219, 0.3)';
        }

        this.selectedNode = nodeId;
        this.showNodeProperties(nodeId);
    }

    /**
     * 刪除節點（包含級聯刪除展開的子節點）
     */
    deleteNode(nodeId) {
        // 收集所有要刪除的節點（包含子節點）
        const nodesToDelete = this.collectChildNodes(nodeId);
        nodesToDelete.push(nodeId);  // 加入自己

        const message = nodesToDelete.length > 1
            ? `⚠️ 確定要刪除此節點嗎？\n\n將同時刪除 ${nodesToDelete.length} 個節點（包含展開的子節點）及相關連線。`
            : '⚠️ 確定要刪除此節點嗎？\n\n相關連線也會一併刪除。';

        // 使用 Modal 確認
        this.showConfirm(
            '刪除節點',
            message.replace(/\n/g, '<br>'),
            () => this._executeDeleteNode(nodesToDelete)
        );
    }

    /**
     * 執行刪除節點（內部方法）
     */
    _executeDeleteNode(nodesToDelete) {
        const { edges: edgesToRemove } = this.store.removeNodes(nodesToDelete);

        // 移除相關連線的 DOM（SVG path 與控制點）
        edgesToRemove.forEach(edge => {
            if (edge._abortController) edge._abortController.abort();
            const pathElement = document.getElementById(edge.id);
            if (pathElement) pathElement.remove();
            const controlPoint = document.querySelector(`[data-edge-id="${edge.id}"]`);
            if (controlPoint) controlPoint.remove();
        });

        // 從 DOM 移除所有節點元素
        nodesToDelete.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.remove();
        });

        this.selectedNode = null;
        document.getElementById('sidebar').classList.remove('show');
        this.updateMinimap();
        this.saveToLocalStorage();

        const message = nodesToDelete.length > 1
            ? `已刪除 ${nodesToDelete.length} 個節點（包含展開的子節點）`
            : '節點已刪除';
        toast.success(message);
    }

    /**
     * 遞歸收集所有子節點（從指定節點展開出來的節點）
     */
    collectChildNodes(nodeId) {
        return this.store.collectDescendants(nodeId);
    }

    /**
     * 重新渲染所有節點
     */
    renderAll() {
        // 清空畫布內容
        if (this.canvasContent) {
            this.canvasContent.remove();
        }

        // 重新創建 SVG 圖層和內容容器
        this.createSvgLayer();

        // 渲染所有節點
        this.nodes.forEach(node => this.renderNode(node));

        // 渲染所有連線
        this.edges.forEach(edge => this.renderEdge(edge));

        this.updateMinimap();
    }
}
