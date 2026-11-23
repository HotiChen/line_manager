// js/flow/designer/properties.js
// Properties：側欄屬性面板與節點資料更新
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { setInnerHTML } from '../../../helper/security.js';
import { dataLoader } from '../../flow_designer_data_loader.js';
import { NodeTypes } from '../node_types.js';
import { bindActions } from './actions.js';

export class PropertiesMethods {
    /**
     * 顯示節點屬性面板
     */
    showNodeProperties(nodeId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;

        const sidebar = document.getElementById('sidebar');
        const properties = document.getElementById('node-properties');

        sidebar.classList.add('show');
        setInnerHTML(properties, `
                <h6><i class="bi ${node.config.icon}"></i> ${node.config.label}</h6>
            <p class="text-muted small">${node.config.description}</p>
            <hr>
            ${this.renderNodeProperties(node)}
            <button class="btn btn-sm btn-danger w-100 mt-3" data-on="click:deleteNode" data-node-id="${nodeId}">
                <i class="bi bi-trash"></i> 刪除節點
            </button>
        `);
        bindActions(properties, this);
    }

    /**
     * 切換側邊欄顯示/隱藏
     */
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('show');
    }

    /**
     * 隱藏側邊欄
     */
    hideSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.remove('show');
    }

    /**
     * 渲染節點屬性編輯器
     */
    renderNodeProperties(node) {
        switch (node.type) {
            case NodeTypes.RICHMENU:
                return this.renderRichmenuProperties(node);
            case NodeTypes.MESSAGE_FLEX:
                return this.renderFlexProperties(node);
            case NodeTypes.MESSAGE_IMAGEMAP:
                return this.renderImagemapProperties(node);
            case NodeTypes.MESSAGE_TEXT:
                return this.renderTextProperties(node);
            case NodeTypes.MESSAGE_SEQUENCE:
                return this.renderSequenceProperties(node);
            case NodeTypes.KEYWORD:
                return this.renderKeywordProperties(node);
            case NodeTypes.ACTION_DELAY:
                return this.renderDelayProperties(node);
            case NodeTypes.ACTION_TAG:
                return this.renderTagProperties(node);
            default:
                return this.renderGenericProperties(node);
        }
    }

    /**
     * Richmenu 屬性編輯器
     */
    renderRichmenuProperties(node) {
        // ✅ 判斷是否已載入（有 buttons 或者是自動創建的）
        const isLoaded = node.data.buttons && node.data.buttons.length > 0;
        const isAutoCreated = node.data.isAutoCreated; // 通過 menu switch 自動創建的
        const shouldDisableSelector = isLoaded || isAutoCreated;

        return `
            ${dataLoader.renderResourceSelector('richmenu', node.data.richmenuId, shouldDisableSelector)}
            
            ${!shouldDisableSelector ? `
                <button class="btn btn-sm btn-primary w-100 mt-2" 
                        data-on="click:selectRichmenu" data-node-id="${node.id}">
                    <i class="bi bi-arrow-right-circle"></i> 載入 Richmenu
                </button>
            ` : ''}
            
            ${node.data.buttons.length > 0 ? `
                <div class="mt-3">
                    <button class="btn btn-sm btn-success w-100" 
                            data-on="click:expandRichmenuButtons" data-node-id="${node.id}">
                        <i class="bi bi-diagram-3"></i> 展開所有按鈕
                    </button>
                </div>
                <div class="mt-3">
                    <label class="form-label">按鈕列表</label>
                    <div class="list-group list-group-flush">
                        ${node.data.buttons.map((btn, idx) => `
                            <div class="list-group-item small">
                                <strong>按鈕 ${idx + 1}:</strong> ${btn.label}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : '<p class="text-muted small mt-2">尚未選擇 Richmenu</p>'}
        `;
    }

    /**
     * Flex Message 屬性編輯器
     */
    renderFlexProperties(node) {
        return `
            ${dataLoader.renderResourceSelector('flex', node.data.flexId)}
            
            <button class="btn btn-sm btn-primary w-100 mt-2" 
                    data-on="click:selectFlex" data-node-id="${node.id}">
                <i class="bi bi-arrow-right-circle"></i> 載入 Flex Message
            </button>
            
            ${node.data.buttons && node.data.buttons.length > 0 ? `
                <div class="mt-3">
                    <button class="btn btn-sm btn-success w-100" 
                            data-on="click:expandFlexButtons" data-node-id="${node.id}">
                        <i class="bi bi-diagram-3"></i> 自動展開所有按鈕
                    </button>
                </div>
                <div class="mt-3">
                    <label class="form-label">Flex 按鈕（輸出點）</label>
                    <div class="list-group list-group-flush">
                        ${node.data.buttons.map((btn, idx) => `
                            <div class="list-group-item small">
                                ${btn.label}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        `;
    }

    /**
     * Imagemap 屬性編輯器
     */
    renderImagemapProperties(node) {

        // ✅ 判斷是否已載入（有 actions）
        const isLoaded = node.data.actions && node.data.actions.length > 0;
        const shouldDisableSelector = isLoaded;

        return `
            ${dataLoader.renderResourceSelector('imagemap', node.data.imagemapId, shouldDisableSelector)}
            
            ${!shouldDisableSelector ? `
                <button class="btn btn-sm btn-primary w-100 mt-2" 
                        data-on="click:selectImagemap" data-node-id="${node.id}">
                    <i class="bi bi-arrow-right-circle"></i> 載入 Imagemap
                </button>
            ` : ''}
            
            ${node.data.actions && node.data.actions.length > 0 ? `
                <div class="mt-3">
                    <button class="btn btn-sm btn-success w-100" 
                            data-on="click:expandImagemapButtons" data-node-id="${node.id}">
                        <i class="bi bi-diagram-3"></i> 展開所有區域
                    </button>
                </div>
                <div class="mt-3">
                    <label class="form-label">可點擊區域</label>
                    <div class="list-group list-group-flush">
                        ${node.data.actions.map((action, idx) => `
                            <div class="list-group-item small">
                                <strong>區域 ${idx + 1}:</strong> ${action.type === 'uri' ? '🔗 ' + (action.linkUri || 'URL') : action.type === 'message' ? '💬 ' + (action.text || 'Message') : '📦 ' + action.type}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : '<p class="text-muted small mt-2">尚未選擇 Imagemap</p>'}
        `;
    }

    /**
     * 文字訊息屬性編輯器
     */
    renderTextProperties(node) {
        return `
            <div class="mb-3">
                <label class="form-label">訊息內容</label>
                <textarea class="form-control" rows="4" id="text-content-${node.id}"
                          data-on="input:updateNodeText" data-node-id="${node.id}">${node.data.text || ''}</textarea>
                <div class="form-text">最多 2000 字</div>
            </div>
        `;
    }

    /**
     * 訊息序列屬性編輯器
     */
    renderSequenceProperties(node) {
        const messages = node.data.messages || [];
        const messagesHTML = messages.map((msg, index) => `
            <div class="message-item mb-2 p-2 border rounded" data-index="${index}">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="badge bg-primary">${index + 1}</span>
                    <button class="btn btn-sm btn-danger" data-on="click:removeSequenceMessage" data-node-id="${node.id}" data-index="${index}">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
                <div class="mb-1">
                    <select class="form-select form-select-sm" data-on="change:updateMessageType" data-node-id="${node.id}" data-index="${index}">
                        <option value="text" ${msg.type === 'text' ? 'selected' : ''}>文字訊息</option>
                        <option value="image" ${msg.type === 'image' ? 'selected' : ''}>圖片訊息 (暫未支援)</option>
                    </select>
                </div>
                ${msg.type === 'text' ? `
                    <textarea class="form-control form-control-sm" rows="2" 
                              data-on="change:updateMessageContent" data-node-id="${node.id}" data-index="${index}">${msg.text || ''}</textarea>
                ` : ''}
            </div>
        `).join('');

        return `
            <div class="mb-3">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <label class="form-label mb-0">訊息列表 (${messages.length}/5)</label>
                    <button class="btn btn-sm btn-success" 
                            data-on="click:addSequenceMessage" data-node-id="${node.id}"
                            ${messages.length >= 5 ? 'disabled' : ''}>
                        <i class="bi bi-plus-circle"></i> 新增
                    </button>
                </div>
                <div id="messages-container-${node.id}">
                    ${messagesHTML || '<div class="text-muted">尚無訊息</div>'}
                </div>
            </div>
            <div class="mb-3">
                <label class="form-label">訊息間延遲（毫秒）</label>
                <input type="number" class="form-control" min="0" max="5000" step="100"
                       value="${node.data.delay || 0}"
                       data-on="change:updateSequenceDelay" data-node-id="${node.id}">
                <div class="form-text">0-5000 毫秒</div>
            </div>
        `;
    }

    /**
     * 關鍵字屬性編輯器
     */
    renderKeywordProperties(node) {
        return `
            <div class="mb-3">
                ${dataLoader.renderResourceSelector('keyword', node.data.keyword)}
                <button class="btn btn-primary w-100 mt-2" data-on="click:selectKeyword" data-node-id="${node.id}">
                    <i class="bi bi-download"></i> 載入 Keyword
                </button>
            </div>
            <div class="mb-3">
                <label class="form-label">關鍵字</label>
                <input type="text" class="form-control" value="${node.data.keyword || ''}"
                       id="keyword-${node.id}"
                       data-on="change:updateNodeKeyword" data-node-id="${node.id}" readonly>
                <small class="text-muted">從上方選擇關鍵字後載入</small>
            </div>
            <div class="mb-3">
                <label class="form-label">比對方式</label>
                <select class="form-select" id="match-type-${node.id}"
                        data-on="change:updateNodeMatchType" data-node-id="${node.id}" disabled>
                    <option value="exact" ${node.data.matchType === 'exact' ? 'selected' : ''}>完全符合</option>
                    <option value="contains" ${node.data.matchType === 'contains' ? 'selected' : ''}>包含</option>
                    <option value="regex" ${node.data.matchType === 'regex' ? 'selected' : ''}>正則表達式</option>
                </select>
                <small class="text-muted">從 keyword 載入後自動設定</small>
            </div>
        `;
    }

    /**
     * 延遲屬性編輯器
     */
    renderDelayProperties(node) {
        return `
            <div class="mb-3">
                <label class="form-label">延遲時間（秒）</label>
                <input type="number" class="form-control" min="1" max="300"
                       value="${node.data.seconds}"
                       id="delay-${node.id}"
                       data-on="change:updateNodeDelay" data-node-id="${node.id}">
                <div class="form-text">1-300 秒</div>
            </div>
        `;
    }

    /**
     * 標籤屬性編輯器
     */
    renderTagProperties(node) {
        return `
            <div class="mb-3">
                <label class="form-label">操作類型</label>
                <select class="form-select" id="tag-operation-${node.id}"
                        data-on="change:updateNodeTagOperation" data-node-id="${node.id}">
                    <option value="add" ${node.data.operation === 'add' ? 'selected' : ''}>新增標籤</option>
                    <option value="remove" ${node.data.operation === 'remove' ? 'selected' : ''}>移除標籤</option>
                </select>
            </div>
            <div class="mb-3">
                <label class="form-label">標籤</label>
                <input type="text" class="form-control" 
                       placeholder="輸入標籤，用逗號分隔"
                       value="${(node.data.tags || []).join(', ')}"
                       id="tags-${node.id}"
                       data-on="change:updateNodeTags" data-node-id="${node.id}">
            </div>
        `;
    }

    /**
     * 通用屬性編輯器
     */
    renderGenericProperties(node) {
        return `
            <div class="mb-3">
                <label class="form-label">節點 ID</label>
                <input type="text" class="form-control form-control-sm" value="${node.id}" disabled>
            </div>
            <div class="mb-3">
                <label class="form-label">節點資料</label>
                <textarea class="form-control form-control-sm" rows="5">${JSON.stringify(node.data, null, 2)}</textarea>
            </div>
        `;
    }

    /**
     * 更新文字內容
     */
    updateNodeText(nodeId, text) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.text = text;

            // 更新節點的視覺顯示
            const nodeElement = document.getElementById(nodeId);
            if (nodeElement) {
                const previewElement = nodeElement.querySelector('.node-preview');
                if (previewElement) {
                    const preview = text.length > 30 ? text.substring(0, 30) + '...' : text;
                    previewElement.textContent = preview || '(空白訊息)';
                }
            }

            this.saveToLocalStorage();
        }
    }

    /**
     * 添加訊息到序列
     */
    addSequenceMessage(nodeId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node && node.data.messages) {
            if (node.data.messages.length >= 5) {
                toast.warning('最多只能添加 5 個訊息');
                return;
            }

            // 添加新的文字訊息
            node.data.messages.push({
                type: 'text',
                text: '請輸入訊息內容'
            });

            // 重新渲染屬性面板
            this.selectNode(nodeId);

            //更新節點預覽
            this.updateNodePreview(nodeId);

            this.saveToLocalStorage();
            toast.success('已添加訊息');
        }
    }

    /**
     * 刪除序列中的訊息
     */
    removeSequenceMessage(nodeId, index) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node && node.data.messages) {
            node.data.messages.splice(index, 1);

            // 重新渲染屬性面板
            this.selectNode(nodeId);

            // 更新節點預覽
            this.updateNodePreview(nodeId);

            this.saveToLocalStorage();
            toast.success('已刪除訊息');
        }
    }

    /**
     * 更新訊息內容
     */
    updateMessageContent(nodeId, index, content) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node && node.data.messages && node.data.messages[index]) {
            node.data.messages[index].text = content;
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新訊息類型
     */
    updateMessageType(nodeId, index, type) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node && node.data.messages && node.data.messages[index]) {
            node.data.messages[index].type = type;

            // 重新渲染屬性面板以顯示對應的編輯器
            this.selectNode(nodeId);
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新序列延遲時間
     */
    updateSequenceDelay(nodeId, delay) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.delay = parseInt(delay) || 0;
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新節點預覽
     */
    updateNodePreview(nodeId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;

        const nodeElement = document.getElementById(nodeId);
        if (nodeElement) {
            const previewElement = nodeElement.querySelector('.node-preview');
            if (previewElement) {
                previewElement.textContent = this.getNodeDataPreview(node);
            }
        }
    }

    /**
     * 更新關鍵字
     */
    updateNodeKeyword(nodeId, keyword) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.keyword = keyword;
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新比對方式
     */
    updateNodeMatchType(nodeId, matchType) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.matchType = matchType;
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新延遲時間
     */
    updateNodeDelay(nodeId, seconds) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.seconds = parseInt(seconds);
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新標籤操作
     */
    updateNodeTagOperation(nodeId, operation) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.operation = operation;
            this.saveToLocalStorage();
        }
    }

    /**
     * 更新標籤
     */
    updateNodeTags(nodeId, tagsString) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) {
            node.data.tags = tagsString.split(',').map(t => t.trim()).filter(t => t);
            this.saveToLocalStorage();
        }
    }
}
