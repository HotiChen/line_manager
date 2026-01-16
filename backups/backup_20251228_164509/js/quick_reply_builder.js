/**
 * Quick Reply Builder - 快速回覆編輯器頁面
 */

import { apiBase, getUserId } from '../helper/state.js';
import { api } from '../helper/api.client.js';
import { toast } from '../helper/toast.js';
import { LoadingManager } from './shared/loader.js';
import { showConfirm } from '../helper/modal.helper.js';
import { createQuickReplyEditor, getQuickReplyData, parseQuickReplyData } from '../helper/quick-reply.helper.js';

// 當前編輯的 Quick Reply
let currentEditId = null;
let quickReplyEditor = null;
let quickReplyList = [];

/**
 * 頁面初始化
 */
export async function pageInit(pageData) {
    console.log('[Quick Reply Builder] pageInit', pageData);

    LoadingManager.show('quick-reply', '載入 Quick Reply...');

    try {
        // 載入已儲存的 Quick Reply 列表
        await loadQuickReplyList();

        // 初始化事件監聽
        initEventListeners();

        toast.success('Quick Reply 載入完成');
    } catch (error) {
        console.error('❌ Quick Reply 載入失敗:', error);
        toast.error('載入失敗: ' + error.message);
    } finally {
        LoadingManager.hide('quick-reply');
    }
}

/**
 * 載入 Quick Reply 列表
 */
async function loadQuickReplyList() {
    try {
        const data = await api.get('/quickreply/list');
        quickReplyList = data.data || [];
        renderQuickReplyList();
    } catch (error) {
        console.warn('後端載入失敗，嘗試使用 localStorage 儲存 Quick Reply', error);
        const stored = localStorage.getItem('quick_reply_list');
        quickReplyList = stored ? JSON.parse(stored) : [];
        renderQuickReplyList();
    }
}

/**
 * 渲染 Quick Reply 列表
 */
function renderQuickReplyList() {
    const container = document.getElementById('quick-reply-list');

    if (quickReplyList.length === 0) {
        container.innerHTML = `
      <div class="text-center text-muted py-5">
        <i class="bi bi-lightning-charge" style="font-size: 3rem;"></i>
        <p class="mt-2">尚無快速回覆，點擊上方按鈕新增</p>
      </div>
    `;
        return;
    }

    container.innerHTML = quickReplyList.map((item, index) => `
    <div class="quick-reply-list-item" data-id="${item.id}">
      <div>
        <strong>${item.name}</strong>
        <div class="text-muted small">
          ${item.items?.length || 0} 個按鈕
          <span class="ms-2">${formatDate(item.updatedAt || item.createdAt)}</span>
        </div>
      </div>
      <div>
        <button class="btn btn-sm btn-outline-primary edit-btn me-1" data-index="${index}">
          <i class="bi bi-pencil"></i>
        </button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-index="${index}">
          <i class="bi bi-trash"></i>
        </button>
      </div>
    </div>
  `).join('');

    // 綁定編輯和刪除事件
    container.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index);
            openEditModal(quickReplyList[index]);
        });
    });

    container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const index = parseInt(btn.dataset.index);
            const item = quickReplyList[index];

            const confirmed = await showConfirm({
                title: '確認刪除',
                message: `確定要刪除「${item.name}」嗎？`,
                type: 'danger'
            });

            if (confirmed) {
                await deleteQuickReply(index);
            }
        });
    });
}

/**
 * 初始化事件監聽
 */
function initEventListeners() {
    // 新增按鈕
    document.getElementById('create-quick-reply-btn').addEventListener('click', () => {
        openEditModal(null);
    });

    // 儲存按鈕
    document.getElementById('save-quick-reply-btn').addEventListener('click', saveQuickReply);

    // 搜尋
    document.getElementById('search-quick-reply').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.quick-reply-list-item').forEach(item => {
            const name = item.querySelector('strong').textContent.toLowerCase();
            item.style.display = name.includes(term) ? '' : 'none';
        });
    });
}

/**
 * 開啟編輯 Modal
 */
function openEditModal(item) {
    currentEditId = item?.id || null;

    // 設定名稱
    document.getElementById('quick-reply-name').value = item?.name || '';

    // 建立編輯器
    const editorContainer = document.getElementById('quick-reply-editor-container');
    editorContainer.innerHTML = '';

    quickReplyEditor = createQuickReplyEditor({
        initialItems: item?.items ? parseQuickReplyData({ items: item.items }) : [],
        onChange: updatePreview
    });

    editorContainer.appendChild(quickReplyEditor);

    // 更新預覽
    updatePreview(item?.items || []);

    // 顯示 Modal
    const modal = new bootstrap.Modal(document.getElementById('quick-reply-modal'));
    modal.show();
}

/**
 * 更新預覽
 */
function updatePreview(items) {
    const preview = document.getElementById('quick-reply-preview');

    if (!items || items.length === 0) {
        preview.innerHTML = '<div class="text-muted text-center">新增按鈕後這裡會顯示預覽</div>';
        return;
    }

    const buttons = items.map(item => {
        const action = item.action || item;
        const label = action.label || action.text || action.type;
        return `<span class="quick-reply-preview-btn">${label}</span>`;
    }).join('');

    preview.innerHTML = `
    <div class="text-center">
      <div class="text-muted small mb-2">Quick Reply 預覽</div>
      <div>${buttons}</div>
    </div>
  `;
}

/**
 * 儲存 Quick Reply
 */
async function saveQuickReply() {
    const name = document.getElementById('quick-reply-name').value.trim();

    if (!name) {
        toast.warning('請輸入名稱');
        return;
    }

    const quickReplyData = quickReplyEditor.getQuickReplyData();

    if (!quickReplyData || quickReplyData.items.length === 0) {
        toast.warning('請至少新增一個按鈕');
        return;
    }

    const item = {
        id: currentEditId || `qr_${Date.now()}`,
        name,
        items: quickReplyData.items,
        createdAt: currentEditId ? undefined : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // 更新列表
    if (currentEditId) {
        const index = quickReplyList.findIndex(i => i.id === currentEditId);
        if (index >= 0) {
            item.createdAt = quickReplyList[index].createdAt;
            quickReplyList[index] = item;
        }
    } else {
        quickReplyList.push(item);
    }

    // 儲存到 localStorage（暫時）
    localStorage.setItem('quick_reply_list', JSON.stringify(quickReplyList));

    // 嘗試儲存到後端
    try {
        await api.post('/quickreply/save', {
            id: item.id,
            name: item.name,
            items: item.items
        });
    } catch (error) {
        console.warn('後端儲存失敗，已儲存到本地');
    }

    // 關閉 Modal
    bootstrap.Modal.getInstance(document.getElementById('quick-reply-modal')).hide();

    // 重新渲染列表
    renderQuickReplyList();

    toast.success('儲存成功');
}

/**
 * 刪除 Quick Reply
 */
async function deleteQuickReply(index) {
    const item = quickReplyList[index];
    quickReplyList.splice(index, 1);

    // 儲存到 localStorage
    localStorage.setItem('quick_reply_list', JSON.stringify(quickReplyList));

    // 嘗試從後端刪除
    try {
        await api.delete(`/quickreply/delete/${item.id}`);
    } catch (error) {
        console.warn('後端刪除失敗');
    }

    renderQuickReplyList();
    toast.success('已刪除');
}

/**
 * 格式化日期
 */
function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-TW', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
