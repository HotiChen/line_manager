/**
 * Quick Reply Helper - Quick Reply 編輯器元件
 * 
 * 功能：
 * - 建立 Quick Reply 編輯器 UI
 * - 支援最多 13 個按鈕
 * - 支援 6 種 action 類型
 * - 輸出 LINE Messaging API 格式的 Quick Reply JSON
 */

import { messageTypeLabels, messageTypeActionSupport } from './message.helper.js';

// Quick Reply 支援的 Action 類型
export const QUICK_REPLY_ACTIONS = [
    { type: 'message', label: '文字訊息', icon: '💬', requiresIcon: false },
    { type: 'postback', label: 'Postback', icon: '📦', requiresIcon: false },
    { type: 'uri', label: '開啟網址', icon: '🔗', requiresIcon: false },
    { type: 'datetimepicker', label: '日期時間', icon: '📅', requiresIcon: false },
    { type: 'camera', label: '相機', icon: '📷', requiresIcon: true },
    { type: 'cameraRoll', label: '相簿', icon: '📸', requiresIcon: true },
    { type: 'location', label: '位置', icon: '📍', requiresIcon: true }
];

// 最大按鈕數量
const MAX_QUICK_REPLY_ITEMS = 13;

/**
 * 建立 Quick Reply 編輯器
 * @param {Object} options - 選項
 * @param {Array} options.initialItems - 初始 Quick Reply 項目
 * @param {Function} options.onChange - 當項目變更時的回調
 * @returns {HTMLElement} - Quick Reply 編輯器容器
 * 
 * Pre-conditions:
 * - 無特別限制，但需要在 DOM 渲染環境使用
 * Post-conditions:
 * - 回傳建構完成且綁定事件的編輯器 DOM 節點
 */
export function createQuickReplyEditor(options = {}) {
    const { initialItems = [], onChange } = options;

    // 建立主容器
    const container = document.createElement('div');
    container.className = 'quick-reply-editor';
    container.innerHTML = `
    <div class="quick-reply-header d-flex justify-content-between align-items-center mb-2">
      <label class="form-label mb-0">
        <i class="bi bi-lightning-charge text-warning"></i> Quick Reply 快速回覆
        <small class="text-muted ms-2">(<span class="item-count">0</span>/13)</small>
      </label>
      <button type="button" class="btn btn-sm btn-outline-primary add-quick-reply-btn">
        <i class="bi bi-plus-lg"></i> 新增按鈕
      </button>
    </div>
    <div class="quick-reply-items-container"></div>
    <div class="quick-reply-empty text-muted text-center py-3" style="display: none;">
      <i class="bi bi-hand-index"></i> 尚未新增快速回覆按鈕
    </div>
  `;

    const itemsContainer = container.querySelector('.quick-reply-items-container');
    const emptyMessage = container.querySelector('.quick-reply-empty');
    const itemCountSpan = container.querySelector('.item-count');
    const addBtn = container.querySelector('.add-quick-reply-btn');

    // 儲存項目資料
    let items = [...initialItems];

    // 更新計數和空狀態顯示
    function updateUI() {
        itemCountSpan.textContent = items.length;
        emptyMessage.style.display = items.length === 0 ? 'block' : 'none';
        addBtn.disabled = items.length >= MAX_QUICK_REPLY_ITEMS;

        if (typeof onChange === 'function') {
            onChange(items);
        }
    }

    // 渲染單一項目
    function renderItem(item, index) {
        const actionConfig = QUICK_REPLY_ACTIONS.find(a => a.type === item.action?.type) || QUICK_REPLY_ACTIONS[0];

        const itemEl = document.createElement('div');
        itemEl.className = 'quick-reply-item card mb-2';
        itemEl.dataset.index = index;
        itemEl.innerHTML = `
      <div class="card-body p-2">
        <div class="d-flex align-items-center gap-2">
          <span class="drag-handle text-muted" style="cursor: grab;"><i class="bi bi-grip-vertical"></i></span>
          <span class="action-icon">${actionConfig.icon}</span>
          <select class="form-select form-select-sm action-type-select" style="width: 120px;">
            ${QUICK_REPLY_ACTIONS.map(a => `
              <option value="${a.type}" ${a.type === item.action?.type ? 'selected' : ''}>${a.icon} ${a.label}</option>
            `).join('')}
          </select>
          <div class="action-fields flex-grow-1"></div>
          <button type="button" class="btn btn-sm btn-outline-danger remove-item-btn">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>
    `;

        // 渲染 action 欄位
        const fieldsContainer = itemEl.querySelector('.action-fields');
        renderActionFields(fieldsContainer, item.action || { type: 'message' }, index);

        // Action 類型變更事件
        const typeSelect = itemEl.querySelector('.action-type-select');
        typeSelect.addEventListener('change', (e) => {
            const newType = e.target.value;
            items[index].action = { type: newType };
            renderActionFields(fieldsContainer, items[index].action, index);
            updateUI();
        });

        // 刪除按鈕事件
        itemEl.querySelector('.remove-item-btn').addEventListener('click', () => {
            items.splice(index, 1);
            renderAllItems();
            updateUI();
        });

        return itemEl;
    }

    // 渲染 action 欄位
    function renderActionFields(container, action, index) {
        container.innerHTML = '';

        switch (action.type) {
            case 'message':
                container.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="按鈕文字 / 發送內容" 
                 value="${action.text || ''}" data-field="text">
        `;
                break;

            case 'postback':
                container.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="按鈕文字" 
                 value="${action.label || ''}" data-field="label" style="width: 40%;">
          <input type="text" class="form-control form-control-sm ms-1" placeholder="Postback data" 
                 value="${action.data || ''}" data-field="data" style="width: 55%;">
        `;
                break;

            case 'uri':
                container.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="按鈕文字" 
                 value="${action.label || ''}" data-field="label" style="width: 30%;">
          <input type="url" class="form-control form-control-sm ms-1" placeholder="https://..." 
                 value="${action.uri || ''}" data-field="uri" style="width: 65%;">
        `;
                break;

            case 'datetimepicker':
                container.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="按鈕文字" 
                 value="${action.label || ''}" data-field="label" style="width: 40%;">
          <select class="form-select form-select-sm ms-1" data-field="mode" style="width: 30%;">
            <option value="datetime" ${action.mode === 'datetime' ? 'selected' : ''}>日期+時間</option>
            <option value="date" ${action.mode === 'date' ? 'selected' : ''}>僅日期</option>
            <option value="time" ${action.mode === 'time' ? 'selected' : ''}>僅時間</option>
          </select>
          <input type="text" class="form-control form-control-sm ms-1" placeholder="data" 
                 value="${action.data || ''}" data-field="data" style="width: 25%;">
        `;
                break;

            case 'camera':
            case 'cameraRoll':
            case 'location':
                container.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="按鈕文字" 
                 value="${action.label || ''}" data-field="label">
        `;
                break;
        }

        // 監聽欄位變更
        container.querySelectorAll('input, select').forEach(input => {
            input.addEventListener('input', (e) => {
                const field = e.target.dataset.field;
                if (field) {
                    items[index].action[field] = e.target.value;
                    updateUI();
                }
            });
        });
    }

    // 渲染所有項目
    function renderAllItems() {
        itemsContainer.innerHTML = '';
        items.forEach((item, index) => {
            itemsContainer.appendChild(renderItem(item, index));
        });
    }

    // 新增按鈕事件
    addBtn.addEventListener('click', () => {
        if (items.length >= MAX_QUICK_REPLY_ITEMS) return;

        items.push({
            type: 'action',
            action: { type: 'message', text: '' }
        });
        renderAllItems();
        updateUI();
    });

    // 初始化
    if (initialItems.length > 0) {
        renderAllItems();
    }
    updateUI();

    // 將取得資料的方法附加到元素上
    container.getQuickReplyData = () => getQuickReplyData(items);
    container.setQuickReplyData = (newItems) => {
        items = [...newItems];
        renderAllItems();
        updateUI();
    };

    return container;
}

/**
 * 取得 Quick Reply JSON 格式
 * @param {Array} items - Quick Reply 項目陣列
 * @returns {Object|null} - LINE API 格式的 quickReply 物件，或 null（無項目時）
 * 
 * Pre-conditions:
 * - 無特別限制
 * Post-conditions:
 * - 將 UI state 轉換符合 Messaging API 的格式回傳，無資料時回傳 null
 */
export function getQuickReplyData(items) {
    if (!items || items.length === 0) return null;

    const validItems = items.filter(item => {
        const action = item.action;
        if (!action) return false;

        switch (action.type) {
            case 'message':
                return action.text && action.text.trim().length > 0;
            case 'postback':
                return action.data && action.data.trim().length > 0;
            case 'uri':
                return action.uri && action.uri.trim().length > 0;
            case 'datetimepicker':
                return action.label && action.data;
            case 'camera':
            case 'cameraRoll':
            case 'location':
                return action.label && action.label.trim().length > 0;
            default:
                return false;
        }
    });

    if (validItems.length === 0) return null;

    return {
        items: validItems.map(item => {
            const action = { ...item.action };

            // message 類型需要設定 label = text
            if (action.type === 'message' && !action.label) {
                action.label = action.text;
            }

            return {
                type: 'action',
                action
            };
        })
    };
}

/**
 * 從 LINE API 格式轉換為編輯器格式
 * @param {Object} quickReply - LINE API 格式的 quickReply 物件
 * @returns {Array} - 編輯器項目陣列
 * 
 * Pre-conditions:
 * - 無特別限制
 * Post-conditions:
 * - 回傳轉換為供 UI render 所需的 state 陣列
 */
export function parseQuickReplyData(quickReply) {
    if (!quickReply || !quickReply.items) return [];

    return quickReply.items.map(item => ({
        type: 'action',
        action: { ...item.action }
    }));
}
