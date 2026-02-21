// js/flow_node_adapter.js
// Flow Designer 節點適配器 - 整合現有的 Builder 編輯功能

import { generateReplyInputUI, MessageFactory } from '../helper/message.helper.js';
import { getUserId, apiBase } from '../helper/state.js';
import { toast } from '../helper/toast.js';
import { setInnerHTML } from '../helper/security.js';

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
     * Richmenu 选择器 - 占位符
     */
    static async openRichmenuSelector(node, onSave) {
        toast.info('请从主选单的 "Richmenu 管理" 编辑 Richmenu');
    }

    /**
     * Flex Message 選擇器
     */
    static async openFlexSelector(node, onSave) {
        toast.info('Flex 選擇器開發中...');
    }

    /**
     * Imagemap 選擇器
     */
    static async openImagemapSelector(node, onSave) {
        toast.info('Imagemap 選擇器開發中...');
    }

    /**
     * Keyword 編輯器
     */
    static async openKeywordEditor(node, onSave) {
        toast.info('Keyword 編輯器開發中...');
    }
}

// 匯出供全域使用
export default FlowNodeAdapter;
