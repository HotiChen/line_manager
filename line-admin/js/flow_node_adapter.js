// js/flow_node_adapter.js
// Flow Designer 節點適配器 - 整合現有的 Builder 編輯功能

import { generateReplyInputUI, MessageFactory } from '../helper/message.helper.js';
import { getUserId, apiBase } from '../helper/state.js';
import { toast } from '../helper/toast.js';
import { setInnerHTML } from '../helper/security.js';
import { dataLoader } from './flow_designer_data_loader.js';

function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * FlowNodeAdapter - 橋接 Flow Designer 節點與現有 Builder 功能

 * 
 * 主要用途：
 * 1. 重用現有的 Richmenu、Imagemap、Flex 等編輯介面
 * 2. 提供統一的節點編輯方法
 * 3. 處理資料格式轉換
 */
export class FlowNodeAdapter {

    /**
     * 編輯節點 - 主要入口函數
     * 
     * Why: 
     * - 這是外部呼叫介面，身為 Adapter 必須將不同節點分流至對應的編輯器。將複雜度保留在此，維持外部介面簡潔。
     * 
     * Pre-conditions:
     * - `node` 必須帶有 `type` 與 `config`
     * - `onSave` 必須是 Function
     * 
     * @param {Object} node - Flow Designer 節點
     * @param {Function} onSave - 儲存回調函數
     */
    static async editNode(node, onSave) {

        // 根據節點類型選擇編輯方式
        switch (node.type) {
            // 簡單節點：側邊欄編輯
            case 'message_text':
            case 'url':
            case 'postback':
            case 'action_delay':
                this.openSidebarEditor(node, onSave);
                break;

            // 複雜節點：選擇器或列表
            case 'richmenu':
                this.openRichmenuSelector(node, onSave);
                break;

            case 'message_flex':
                this.openFlexSelector(node, onSave);
                break;

            case 'message_imagemap':
                this.openImagemapSelector(node, onSave);
                break;

            case 'keyword':
                this.openKeywordEditor(node, onSave);
                break;

            case 'action_condition':
            case 'action_api':
                this.openSidebarEditor(node, onSave);
                break;

            default:
                toast.warning(`節點類型 ${node.type} 尚未支援編輯`);
        }
    }

    /**
     * 側邊欄編輯器 - 用於簡單節點
     * 
     * Why:
     * - 針對純文字、URL、Postback、Delay 等不需要大畫面的節點，統一在右側邊欄解決，避免開啟過多 Modal 遮擋流程圖。
     * 
     * Pre-conditions:
     * - `node` 與 `onSave` 必須有效。
     * - 畫面上必須存在 `#flow-node-editor` 元素。
     * 
     * Post-conditions:
     * - 清空側邊欄並依據 node.type 插入新建的表單欄位元件。
     */
    static async openSidebarEditor(node, onSave) {
        const sidebar = document.getElementById('flow-node-editor');
        if (!sidebar) {
            console.error('[FlowNodeAdapter] 找不到側邊欄');
            return;
        }

        // 清空側邊欄
        setInnerHTML(sidebar, '');
        sidebar.classList.add('active');

        // 創建編輯表單
        const form = document.createElement('div');
        form.className = 'node-editor-form';

        // 標題
        const title = document.createElement('h5');
        title.className = 'mb-3';
        setInnerHTML(title, `<i class="bi ${node.config.icon}"></i> ${node.config.label}`);
        form.appendChild(title);

        // 根據節點類型創建不同的輸入欄位
        switch (node.type) {
            case 'message_text':
                this.createTextEditor(form, node, onSave);
                break;
            case 'url':
                this.createURLEditor(form, node, onSave);
                break;
            case 'postback':
                this.createPostbackEditor(form, node, onSave);
                break;
            case 'action_delay':
                this.createDelayEditor(form, node, onSave);
                break;
            case 'action_condition':
                this.createConditionEditor(form, node, onSave);
                break;
            case 'action_api':
                this.createAPIEditor(form, node, onSave);
                break;
        }

        // 關閉按鈕
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-outline-secondary w-100 mt-3';
        setInnerHTML(closeBtn, '<i class="bi bi-x"></i> 關閉');
        closeBtn.onclick = () => sidebar.classList.remove('active');
        form.appendChild(closeBtn);

        sidebar.appendChild(form);
    }

    /**
     * 文字訊息編輯器
     * 
     * Why:
     * - 需限制文字長度不高過 5000 字（LINE 官方限制），即時回饋長度與提示。
     */
    static createTextEditor(form, node, onSave) {
        const group = document.createElement('div');
        group.className = 'mb-3';

        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = '訊息內容';

        const textarea = document.createElement('textarea');
        textarea.className = 'form-control';
        textarea.rows = 5;
        textarea.placeholder = '請輸入訊息內容...';
        textarea.value = node.data.text || '';

        const charCount = document.createElement('small');
        charCount.className = 'text-muted';
        charCount.textContent = `${textarea.value.length} / 5000 字`;

        textarea.addEventListener('input', () => {
            charCount.textContent = `${textarea.value.length} / 5000 字`;
            if (textarea.value.length > 5000) {
                charCount.classList.add('text-danger');
            } else {
                charCount.classList.remove('text-danger');
            }
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary w-100 mt-2';
        setInnerHTML(saveBtn, '<i class="bi bi-check"></i> 儲存');
        saveBtn.onclick = () => {
            const val = textarea.value.trim();
            if (!val) {
                toast.warning('⚠️ 訊息內容不能為空（Early Return）');
                return;
            }
            if (val.length > 5000) {
                toast.error('❌ 文字長度超過 5000 字限制');
                return;
            }
            node.data.text = val;
            onSave(node);
            toast.success('訊息內容已更新');
        };

        group.appendChild(label);
        group.appendChild(textarea);
        group.appendChild(charCount);
        group.appendChild(saveBtn);
        form.appendChild(group);
    }

    /**
     * URL 編輯器
     * 
     * Why:
     * - 提供兩個欄位（實際連結與顯示文字），必須驗證 URL 不能為空。
     */
    static createURLEditor(form, node, onSave) {
        const group = document.createElement('div');
        group.className = 'mb-3';

        // URL 輸入
        const urlLabel = document.createElement('label');
        urlLabel.className = 'form-label';
        urlLabel.textContent = 'URL 網址';

        const urlInput = document.createElement('input');
        urlInput.type = 'url';
        urlInput.className = 'form-control mb-2';
        urlInput.placeholder = 'https://example.com';
        urlInput.value = node.data.url || '';

        // Label 輸入
        const labelLabel = document.createElement('label');
        labelLabel.className = 'form-label mt-2';
        labelLabel.textContent = '顯示文字';

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'form-control mb-2';
        labelInput.placeholder = '連結';
        labelInput.value = node.data.label || '';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary w-100 mt-2';
        setInnerHTML(saveBtn, '<i class="bi bi-check"></i> 儲存');
        saveBtn.onclick = () => {
            if (!urlInput.value) {
                toast.error('請輸入 URL');
                return;
            }
            node.data.url = urlInput.value;
            node.data.label = labelInput.value || urlInput.value;
            onSave(node);
            toast.success('URL 已更新');
        };

        group.appendChild(urlLabel);
        group.appendChild(urlInput);
        group.appendChild(labelLabel);
        group.appendChild(labelInput);
        group.appendChild(saveBtn);
        form.appendChild(group);
    }

    /**
     * Postback 編輯器
     * 
     * Why:
     * - 提供給開發者自訂 data string，是隱藏且最強大的串接手段。顯示文字是按鈕外觀。必須阻止空 data。
     */
    static createPostbackEditor(form, node, onSave) {
        const group = document.createElement('div');
        group.className = 'mb-3';

        const dataLabel = document.createElement('label');
        dataLabel.className = 'form-label';
        dataLabel.textContent = 'Postback 資料';

        const dataInput = document.createElement('input');
        dataInput.type = 'text';
        dataInput.className = 'form-control mb-2';
        dataInput.placeholder = 'action=buy&item=123';
        dataInput.value = node.data.data || '';

        const labelLabel = document.createElement('label');
        labelLabel.className = 'form-label mt-2';
        labelLabel.textContent = '顯示文字';

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'form-control mb-2';
        labelInput.placeholder = 'Postback';
        labelInput.value = node.data.label || '';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary w-100 mt-2';
        setInnerHTML(saveBtn, '<i class="bi bi-check"></i> 儲存');
        saveBtn.onclick = () => {
            if (!dataInput.value) {
                toast.error('請輸入 Postback 資料');
                return;
            }
            node.data.data = dataInput.value;
            node.data.label = labelInput.value || 'Postback';
            onSave(node);
            toast.success('Postback 已更新');
        };

        group.appendChild(dataLabel);
        group.appendChild(dataInput);
        group.appendChild(labelLabel);
        group.appendChild(labelInput);
        group.appendChild(saveBtn);
        form.appendChild(group);
    }

    /**
     * 延遲編輯器
     * 
     * Why:
     * - 客服與行銷常需要時間差營造真實感，限制最高 86400 (24h) 防呆。
     */
    static createDelayEditor(form, node, onSave) {
        const group = document.createElement('div');
        group.className = 'mb-3';

        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = '延遲秒數';

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'form-control';
        input.min = 0;
        input.max = 86400; // 24 hours
        input.value = node.data.seconds || 1;

        const hint = document.createElement('small');
        hint.className = 'text-muted';
        hint.textContent = '範圍：0 - 86400 秒（24 小時）';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary w-100 mt-2';
        setInnerHTML(saveBtn, '<i class="bi bi-check"></i> 儲存');
        saveBtn.onclick = () => {
            const secondsStr = input.value;
            if (secondsStr === '') {
                toast.error('請輸入延遲秒數');
                return;
            }
            const seconds = parseInt(secondsStr);
            if (isNaN(seconds) || seconds < 0 || seconds > 86400) {
                toast.error('延遲秒數必須在 0-86400 之間');
                return;
            }
            node.data.seconds = seconds;
            onSave(node);
            toast.success(`延遲已設定為 ${seconds} 秒`);
        };

        group.appendChild(label);
        group.appendChild(input);
        group.appendChild(hint);
        group.appendChild(saveBtn);
        form.appendChild(group);
    }

    /**
     * Richmenu 選擇器
     */
    static async openRichmenuSelector(node, onSave) {
        const list = await dataLoader.loadRichmenus();
        if (list.length === 0) {
            toast.warning('尚未建立任何 Richmenu，請先前往 Richmenu 管理新增');
            return;
        }

        this.showResourceModal('選擇 Richmenu', list, 'richMenuId', 'name', async (selectedId) => {
            const details = await dataLoader.loadRichmenuDetails(selectedId);
            if (details) {
                node.data.richmenuId = details.richMenuId;
                node.data.name = details.name;
                node.data.imageUrl = details.imageUrl;
                node.data.buttons = details.buttons;
                onSave(node);
                toast.success('Richmenu 已選取');
            }
        });
    }

    /**
     * Flex Message 選擇器
     */
    static async openFlexSelector(node, onSave) {
        const list = await dataLoader.loadFlexMessages();
        if (list.length === 0) {
            toast.warning('尚未建立任何 Flex Message，請先前往 Flex Message 管理新增');
            return;
        }

        this.showResourceModal('選擇 Flex Message', list, 'id', 'title', async (selectedId) => {
            const details = await dataLoader.loadFlexMessageDetails(selectedId);
            if (details) {
                node.data.flexId = details.flexId;
                node.data.title = details.title;
                node.data.altText = details.altText;
                node.data.contents = details.contents;
                onSave(node);
                toast.success('Flex Message 已選取');
            }
        });
    }

    /**
     * Imagemap 選擇器
     */
    static async openImagemapSelector(node, onSave) {
        const list = await dataLoader.loadImagemaps();
        if (list.length === 0) {
            toast.warning('尚未建立任何 Imagemap，請先前往 Imagemap 管理新增');
            return;
        }

        this.showResourceModal('選擇 Imagemap', list, 'baseUrl', 'altText', async (selectedId) => {
            const item = list.find(i => i.baseUrl === selectedId);
            if (item) {
                node.data.imagemapId = item.id;
                node.data.baseUrl = item.baseUrl;
                node.data.imageUrl = item.baseUrl; // 通常是一樣的
                node.data.altText = item.altText;
                node.data.actions = item.actions;
                onSave(node);
                toast.success('Imagemap 已選取');
            }
        });
    }

    /**
     * Keyword 編輯器
     */
    static async openKeywordEditor(node, onSave) {
        const list = await dataLoader.loadKeywords();
        if (list.length === 0) {
            toast.warning('尚未建立任何關鍵字回覆，請先前往關鍵字管理新增');
            return;
        }

        this.showResourceModal('選擇關鍵字回覆', list, 'keyword', 'keyword', (selectedId) => {
            const item = list.find(i => i.keyword === selectedId);
            if (item) {
                node.data.keyword = item.keyword;
                node.data.matchType = item.matchType || 'exact';
                onSave(node);
                toast.success('關鍵字已連結');
            }
        });
    }

    /**
     * 通用資源選擇 Modal
     */
    static showResourceModal(title, list, idField, nameField, onSelect) {
        const modalId = `modal-${Date.now()}`;
        const modalHtml = `
            <div class="modal fade" id="${modalId}" tabindex="-1">
                <div class="modal-dialog modal-lg modal-dialog-scrollable">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">${title}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="list-group">
                                ${list.map(item => `
                                    <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                                            data-id="${item[idField]}">
                                        <div>
                                            <div class="fw-bold">${escapeHtml(item[nameField] || '未命名')}</div>
                                            <small class="text-muted">${item[idField]}</small>
                                        </div>
                                        <i class="bi bi-chevron-right text-muted"></i>
                                    </button>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        const modalEl = document.getElementById(modalId);
        const bsModal = new bootstrap.Modal(modalEl);

        modalEl.querySelectorAll('.list-group-item').forEach(btn => {
            btn.onclick = () => {
                onSelect(btn.dataset.id);
                bsModal.hide();
            };
        });

        modalEl.addEventListener('hidden.bs.modal', () => {
            modalEl.remove();
        });

        bsModal.show();
    }

    /**
     * 條件編輯器
     */
    static createConditionEditor(form, node, onSave) {
        const container = document.createElement('div');
        container.className = 'mb-3';

        if (!node.data.conditions) node.data.conditions = [{ field: 'text', operator: 'equals', value: '' }];

        const renderConditions = () => {
            container.innerHTML = '<label class="form-label">判斷條件</label>';
            node.data.conditions.forEach((cond, index) => {
                const row = document.createElement('div');
                row.className = 'card p-2 mb-2 bg-light';
                row.innerHTML = `
                    <div class="mb-2">
                        <select class="form-select form-select-sm cond-field" data-index="${index}">
                            <option value="text" ${cond.field === 'text' ? 'selected' : ''}>文字內容</option>
                            <option value="userId" ${cond.field === 'userId' ? 'selected' : ''}>使用者 ID</option>
                            <option value="tag" ${cond.field === 'tag' ? 'selected' : ''}>標籤</option>
                        </select>
                    </div>
                    <div class="mb-2">
                        <select class="form-select form-select-sm cond-op" data-index="${index}">
                            <option value="equals" ${cond.operator === 'equals' ? 'selected' : ''}>等於</option>
                            <option value="contains" ${cond.operator === 'contains' ? 'selected' : ''}>包含</option>
                            <option value="regex" ${cond.operator === 'regex' ? 'selected' : ''}>正則匹配</option>
                        </select>
                    </div>
                    <div class="mb-2">
                        <input type="text" class="form-control form-control-sm cond-val" 
                               placeholder="值..." value="${cond.value}" data-index="${index}">
                    </div>
                    <button class="btn btn-sm btn-outline-danger w-100 btn-del-cond" data-index="${index}">
                        <i class="bi bi-trash"></i> 刪除
                    </button>
                `;
                container.appendChild(row);
            });

            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-sm btn-outline-primary w-100 mb-3';
            addBtn.innerHTML = '<i class="bi bi-plus"></i> 新增條件';
            addBtn.onclick = () => {
                node.data.conditions.push({ field: 'text', operator: 'equals', value: '' });
                renderConditions();
            };
            container.appendChild(addBtn);

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn btn-primary w-100';
            saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> 儲存條件';
            saveBtn.onclick = () => {
                // 收集資料
                container.querySelectorAll('.cond-field').forEach(el => {
                    const idx = el.dataset.index;
                    node.data.conditions[idx].field = el.value;
                });
                container.querySelectorAll('.cond-op').forEach(el => {
                    const idx = el.dataset.index;
                    node.data.conditions[idx].operator = el.value;
                });
                container.querySelectorAll('.cond-val').forEach(el => {
                    const idx = el.dataset.index;
                    node.data.conditions[idx].value = el.value;
                });
                onSave(node);
                toast.success('過濾條件已更新');
            };
            container.appendChild(saveBtn);

            // 綁定刪除事件
            container.querySelectorAll('.btn-del-cond').forEach(btn => {
                btn.onclick = () => {
                    node.data.conditions.splice(btn.dataset.index, 1);
                    renderConditions();
                };
            });
        };

        renderConditions();
        form.appendChild(container);
    }

    /**
     * API 節點編輯器
     */
    static createAPIEditor(form, node, onSave) {
        const group = document.createElement('div');
        group.className = 'mb-3';

        if (!node.data.url) node.data.url = '';
        if (!node.data.method) node.data.method = 'GET';
        if (!node.data.headers) node.data.headers = '{}';
        if (!node.data.body) node.data.body = '{}';

        group.innerHTML = `
            <div class="mb-3">
                <label class="form-label">API URL</label>
                <input type="text" id="api-url" class="form-control" placeholder="https://..." value="${node.data.url}">
            </div>
            <div class="mb-3">
                <label class="form-label">Method</label>
                <select id="api-method" class="form-select">
                    <option value="GET" ${node.data.method === 'GET' ? 'selected' : ''}>GET</option>
                    <option value="POST" ${node.data.method === 'POST' ? 'selected' : ''}>POST</option>
                    <option value="PUT" ${node.data.method === 'PUT' ? 'selected' : ''}>PUT</option>
                </select>
            </div>
            <div class="mb-3">
                <label class="form-label">Headers (JSON)</label>
                <textarea id="api-headers" class="form-control" rows="3">${node.data.headers}</textarea>
            </div>
            <div class="mb-3">
                <label class="form-label">Body (JSON)</label>
                <textarea id="api-body" class="form-control" rows="5">${node.data.body}</textarea>
            </div>
            <button class="btn btn-primary w-100" id="btn-save-api">
                <i class="bi bi-check-lg"></i> 儲存 API 配置
            </button>
        `;

        form.appendChild(group);

        form.querySelector('#btn-save-api').onclick = () => {
            const url = form.querySelector('#api-url').value;
            if (!url) {
                toast.error('請輸入 API URL');
                return;
            }
            node.data.url = url;
            node.data.method = form.querySelector('#api-method').value;
            node.data.headers = form.querySelector('#api-headers').value;
            node.data.body = form.querySelector('#api-body').value;
            onSave(node);
            toast.success('API 配置已更新');
        };
    }
}

// 匯出供全域使用
export default FlowNodeAdapter;
