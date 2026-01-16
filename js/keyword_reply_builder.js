import { apiBase, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import {
  detectBuilder,
  getSupportedMsgTypes,
  getSavedMessages,
  formatMessagePreview,
  messageTypeLabels,
  fetchMessageListByType,
  generateReplyInputUI,
  getCurrentReplyInput,
  generateMessagePreviewHTML,
  getMessageTypeIcon,
  searchMessages,
  clearMessageCache,
  refreshMessageType
} from "../helper/message.helper.js";
import { toast, withButtonLoading } from "../helper/toast.js";
import { setInnerHTML } from "../helper/security.js";
import { LoadingManager } from './shared/loader.js';
import { showConfirm } from '../helper/modal.helper.js';

// 當前編輯的關鍵字（null 表示新增模式）
let currentEditKeyword = null;
let keywordModal = null;

class KeywordReply {
  constructor({ keyword = "", replies = [], quickReplyId = null, addTags = [], removeTags = [] }) {
    this.type = "keyword_reply";
    this.keyword = keyword;
    this.replies = replies;
    this.quickReplyId = quickReplyId;
    this.addTags = addTags;
    this.removeTags = removeTags;
  }

  addReply(reply) {
    this.replies.push(reply);
    this.isUpdated = true;
  }

  removeReply(index) {
    if (index >= 0 && index < this.replies.length) {
      this.replies.splice(index, 1);
      this.isUpdated = true;
    }
  }

  toJSON() {
    const json = {
      type: this.type,
      keyword: this.keyword,
      replies: this.replies,
      addTags: this.addTags,
      removeTags: this.removeTags
    };
    if (this.quickReplyId) {
      json.quickReplyId = this.quickReplyId;
    }
    return json;
  }

  isValid() {
    return this.keyword && Array.isArray(this.replies) && this.replies.length > 0;
  }
}

// 暫存使用者目前選擇的訊息
let latestSelectedReply = null;

/**
 * 頁面初始化
 */
export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();

  // 初始化全域變數
  window.currentReplies = [];
  window.currentReplyInput = null;

  // 初始化 Modal
  const modalEl = document.getElementById('keyword-modal');
  if (modalEl) {
    keywordModal = new bootstrap.Modal(modalEl);
  }

  // 綁定「新增關鍵字」按鈕
  document.getElementById('create-keyword-btn')?.addEventListener('click', () => {
    openKeywordModal(null);
  });

  // 綁定「加入回覆」按鈕
  document.getElementById('add-reply-btn')?.addEventListener('click', handleAddReply);

  // 綁定「儲存」按鈕
  document.getElementById('save-keyword-btn')?.addEventListener('click', handleKeywordSubmit);

  // 綁定刷新統計按鈕
  document.getElementById('refresh-stats-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    setInnerHTML(btn, '<i class="bi bi-arrow-clockwise spin"></i> 刷新中...');
    try {
      await renderReplyList(userId);
      toast.success('統計數據已更新');
    } catch (error) {
      console.error('❌ 刷新統計失敗:', error);
      toast.error('刷新統計失敗');
    } finally {
      btn.disabled = false;
      setInnerHTML(btn, '<i class="bi bi-arrow-clockwise"></i> 刷新統計');
    }
  });

  // 綁定全選 checkbox
  document.getElementById('select-all-checkbox')?.addEventListener('change', (e) => {
    document.querySelectorAll('.keyword-checkbox').forEach(cb => cb.checked = e.target.checked);
  });

  // 綁定刪除選取按鈕
  document.getElementById('delete-selected-btn')?.addEventListener('click', handleDeleteSelected);

  // 綁定搜尋功能
  document.getElementById('keyword-search')?.addEventListener('input', (e) => {
    filterKeywordList(e.target.value);
  });
  document.getElementById('clear-search')?.addEventListener('click', () => {
    const searchInput = document.getElementById('keyword-search');
    if (searchInput) {
      searchInput.value = '';
      filterKeywordList('');
    }
  });

  // 載入關鍵字列表
  await renderReplyList(userId);
}

/**
 * 開啟新增/編輯 Modal
 */
async function openKeywordModal(item) {
  currentEditKeyword = item?.keyword || null;
  window.currentReplies = item?.replies ? [...item.replies] : [];
  latestSelectedReply = null;

  // 更新 Modal 標題
  const titleEl = document.getElementById('keyword-modal-title');
  if (titleEl) {
    setInnerHTML(titleEl, item
      ? '<i class="bi bi-pencil text-primary"></i> 編輯關鍵字'
      : '<i class="bi bi-chat-dots text-primary"></i> 新增關鍵字');
  }

  // 設定關鍵字輸入
  const keywordInput = document.getElementById('keyword-input');
  if (keywordInput) {
    keywordInput.value = item?.keyword || '';
    keywordInput.readOnly = !!item; // 編輯模式時不可修改關鍵字
  }

  // 設定自動標籤
  const addTagsInput = document.getElementById('keyword-add-tags');
  const removeTagsInput = document.getElementById('keyword-remove-tags');
  if (addTagsInput) addTagsInput.value = item?.addTags ? item.addTags.join(', ') : '';
  if (removeTagsInput) removeTagsInput.value = item?.removeTags ? item.removeTags.join(', ') : '';

  // 生成回覆選擇器 UI
  const replyFieldsContainer = document.getElementById('reply-dynamic-fields');
  if (replyFieldsContainer) {
    setInnerHTML(replyFieldsContainer, '');
    try {
      const ui = await generateReplyInputUI({
        builder: 'keywords',
        userId: getUserId(),
        onSelect: (type, selectedItem) => {
          window.currentReplyInput = { type, item: selectedItem };
          latestSelectedReply = { type, ...selectedItem };
        }
      });
      replyFieldsContainer.appendChild(ui);
    } catch (error) {
      console.error('❌ 生成回覆輸入 UI 失敗:', error);
      setInnerHTML(replyFieldsContainer, '<div class="alert alert-warning">載入回覆選項失敗</div>');
    }
  }

  // 渲染已加入的回覆
  renderSelectedReplies();

  // 載入 QR 模板列表
  // 優先使用 keyword 層級的 quickReplyId，若沒有則找 replies 中的（向下相容舊資料）
  let selectedQRId = item?.quickReplyId || null;
  if (!selectedQRId && item?.replies) {
    const replyWithQR = item.replies.find(r => r.quickReplyId);
    if (replyWithQR) {
      selectedQRId = replyWithQR.quickReplyId;
    }
  }
  await loadQRTemplates(selectedQRId);

  // 顯示 Modal
  keywordModal?.show();
}

/**
 * 加入回覆
 */
function handleAddReply() {
  if (!latestSelectedReply) {
    toast.warning('請先選擇一個回覆項目');
    return;
  }

  const current = { type: latestSelectedReply.type, item: latestSelectedReply };
  const reply = { type: current.type };

  if (current.type === 'text' && current.item?.text) {
    reply.text = current.item.text;
  } else if (current.type === 'flex' && current.item?.id) {
    reply.id = current.item.id;
    reply.title = current.item.title;
    reply.altText = current.item.title || 'Flex Message';
  } else if (current.item) {
    Object.assign(reply, current.item);
  }

  window.currentReplies.push(reply);
  renderSelectedReplies();
  toast.success('已加入回覆');
}

/**
 * 渲染已選擇的回覆
 */
function renderSelectedReplies() {
  const container = document.getElementById('selected-reply-display');
  if (!container) return;

  if (!window.currentReplies || window.currentReplies.length === 0) {
    setInnerHTML(container, `
      <div class="text-muted text-center">
        <i class="bi bi-inbox"></i> 尚未加入回覆
      </div>
    `);
    return;
  }

  const repliesHTML = window.currentReplies.map((reply, index) => `
    <div class="reply-item">
      <span class="badge bg-secondary">${getMessageTypeIcon(reply.type)}</span>
      <span class="flex-grow-1">${formatMessagePreview(reply.type, reply)}</span>
      <button type="button" class="btn btn-sm btn-outline-danger remove-btn" onclick="window.removeReply(${index})">
        <i class="bi bi-x"></i>
      </button>
    </div>
  `).join('');

  setInnerHTML(container, `
    <div class="mb-2 text-muted small">已加入 ${window.currentReplies.length} 個回覆</div>
    ${repliesHTML}
  `);
}

/**
 * 移除回覆
 */
function removeReply(index) {
  if (index >= 0 && index < window.currentReplies.length) {
    const removed = window.currentReplies.splice(index, 1)[0];
    renderSelectedReplies();
    toast.info(`已移除：${removed.type}`);
  }
}
window.removeReply = removeReply;

/**
 * 儲存關鍵字
 */
async function handleKeywordSubmit() {
  const saveBtn = document.getElementById('save-keyword-btn');

  await withButtonLoading(saveBtn, async () => {
    const keywordInput = document.getElementById('keyword-input');
    const keyword = keywordInput?.value?.trim();

    if (!keyword) {
      toast.warning('請輸入關鍵字');
      return;
    }

    if (!window.currentReplies || window.currentReplies.length === 0) {
      toast.warning('請至少加入一個回覆');
      return;
    }

    // 檢查重複（僅新增模式）
    if (!currentEditKeyword) {
      const isDuplicate = window.existingKeywords?.some(k => k.toLowerCase() === keyword.toLowerCase());
      if (isDuplicate) {
        toast.warning(`關鍵字「${keyword}」已存在`);
        return;
      }
    }

    // 取得選擇的 QR 模板 ID（keyword 層級）
    const qrSelect = document.getElementById('qr-template-select');
    const quickReplyId = qrSelect?.value || null;

    // Debug: 確認 QR 選取狀態

    // 取得自動標籤
    const addTagsRaw = document.getElementById('keyword-add-tags')?.value || '';
    const removeTagsRaw = document.getElementById('keyword-remove-tags')?.value || '';
    const addTags = addTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);
    const removeTags = removeTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);

    const newItem = new KeywordReply({
      keyword,
      replies: window.currentReplies,
      quickReplyId,
      addTags,
      removeTags,
      createdAt: new Date().toISOString()
    });

    // Debug: 查看準備發送的完整資料
    const dataToSend = newItem.toJSON();

    try {
      const result = await api.post('/keyword/save', dataToSend);

      // Debug: 查看實際回應

      // ApiClient 已經返回解析後的 JSON，直接檢查
      // 可能是 { success: true, data: ... } 或直接是 API 回應
      const isSuccess = result?.success !== false; // 假設沒有 success 或 success=true 都視為成功

      if (isSuccess) {
        const newTags = result.newTagsRegistered;
        if (newTags && newTags.length > 0) {
          toast.success(`已儲存關鍵字並註冊 ${newTags.length} 個標籤：${newTags.join(', ')}`);
        } else {
          toast.success(currentEditKeyword ? '已更新關鍵字' : '已新增關鍵字');
        }

        keywordModal?.hide();
        await renderReplyList(getUserId());
        clearMessageCache();
      } else {
        toast.error('儲存失敗：' + (result.error || result.message || '未知錯誤'));
      }
    } catch (err) {
      console.error('❌ 儲存失敗', err);
      // err 可能是 Response 物件（ApiClient throw 的）
      if (err instanceof Response) {
        toast.error(`儲存失敗 (${err.status})`);
      } else {
        toast.error('儲存過程中發生錯誤: ' + (err.message || err));
      }
    }
  }, '儲存中...');
}

/**
 * 刪除選取的關鍵字
 */
async function handleDeleteSelected() {
  const checkboxes = document.querySelectorAll('.keyword-checkbox:checked');
  if (checkboxes.length === 0) {
    toast.warning('請先選取要刪除的項目');
    return;
  }

  const keywords = Array.from(checkboxes).map(cb => cb.dataset.keyword);
  const message = checkboxes.length === 1
    ? `確定要刪除關鍵字「${keywords[0]}」嗎？`
    : `確定要刪除 ${checkboxes.length} 個關鍵字嗎？`;

  const confirmed = await showConfirm({
    title: '確認刪除',
    message,
    type: 'danger'
  });

  if (!confirmed) return;

  const deleteBtn = document.getElementById('delete-selected-btn');
  await withButtonLoading(deleteBtn, async () => {
    for (const keyword of keywords) {
      try {
        await api.post('/keyword/delete', { keyword });
      } catch (err) {
        console.error('❌ 刪除失敗', keyword, err);
        toast.error(`刪除失敗: ${keyword}`);
      }
    }
    await renderReplyList(getUserId());
    toast.success(`已刪除 ${keywords.length} 個關鍵字`);
  }, '刪除中...');
}

/**
 * 搜尋篩選
 */
function filterKeywordList(searchTerm) {
  const rows = document.querySelectorAll('#reply-list tr');
  const term = searchTerm.toLowerCase().trim();
  let visibleCount = 0;

  rows.forEach(row => {
    const keyword = row.querySelector('button')?.textContent.toLowerCase() || '';
    const replyTypes = row.querySelector('.d-flex')?.textContent.toLowerCase() || '';

    if (!term || keyword.includes(term) || replyTypes.includes(term)) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });

  const resultCount = document.getElementById('search-result-count');
  if (resultCount) {
    resultCount.textContent = term ? `找到 ${visibleCount} 個符合的關鍵字` : '';
  }
}

/**
 * 渲染關鍵字列表
 */
export async function renderReplyList(userId) {
  const replyListContainer = document.getElementById('reply-list');
  const savedKeywordReplies = await fetchKeywordReplyList(userId);
  setInnerHTML(replyListContainer, '');

  window.existingKeywords = savedKeywordReplies.map(item => item.keyword);

  LoadingManager.show('keyword-stats-load', '載入關鍵字統計中...');

  try {
    const fragment = document.createDocumentFragment();
    const rows = await Promise.all(savedKeywordReplies.map((item, index) => createKeywordRow(item, index)));
    rows.forEach(row => fragment.appendChild(row));

    setInnerHTML(replyListContainer, '');
    replyListContainer.appendChild(fragment);
    LoadingManager.hide('keyword-stats-load');
  } catch (error) {
    console.error('❌ 載入關鍵字清單失敗:', error);
    LoadingManager.hide('keyword-stats-load');
    setInnerHTML(replyListContainer, `
      <tr><td colspan="6" class="text-center text-danger">❌ 載入失敗，請重新整理頁面</td></tr>
    `);
  }
}

/**
 * 建立關鍵字表格行
 */
async function createKeywordRow(item, index) {
  const tr = document.createElement('tr');

  // Checkbox
  const tdCheckbox = document.createElement('td');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'keyword-checkbox';
  checkbox.dataset.keyword = item.keyword;
  tdCheckbox.appendChild(checkbox);
  tr.appendChild(tdCheckbox);

  // 關鍵字按鈕
  const tdKeyword = document.createElement('td');
  const keywordBtn = document.createElement('button');
  keywordBtn.className = 'btn btn-outline-primary btn-sm';
  keywordBtn.textContent = item.keyword;
  keywordBtn.addEventListener('click', () => openKeywordModal(item));
  tdKeyword.appendChild(keywordBtn);
  tr.appendChild(tdKeyword);

  // 回覆類型
  const tdTypes = document.createElement('td');
  const replySummary = document.createElement('div');
  replySummary.className = 'd-flex flex-wrap gap-1';

  // 檢查 keyword 層級是否有 QR
  const hasQR = !!item.quickReplyId;

  item.replies.forEach(reply => {
    const badge = document.createElement('span');
    badge.className = 'badge bg-secondary';
    setInnerHTML(badge, `${getMessageTypeIcon(reply.type)} ${formatMessagePreview(reply.type, reply)}`);
    replySummary.appendChild(badge);
  });

  // 🆕 如果有 QR，加入 QR 標記
  if (hasQR) {
    const qrBadge = document.createElement('span');
    qrBadge.className = 'badge bg-warning text-dark';
    qrBadge.title = '此關鍵字包含 Quick Reply';
    setInnerHTML(qrBadge, '<i class="bi bi-lightning-charge"></i> QR');
    replySummary.appendChild(qrBadge);
  }

  tdTypes.appendChild(replySummary);
  tr.appendChild(tdTypes);

  // 統計數據
  try {
    const stats = await getKeywordStats(item.keyword);
    tr.appendChild(createStatCell(stats.total || 0, 'primary'));
    tr.appendChild(createStatCell(stats.thisMonth || 0, 'success'));
    tr.appendChild(createStatCell(stats.lastMonth || 0, 'info'));
  } catch (error) {
    tr.appendChild(createStatCell('-', 'secondary'));
    tr.appendChild(createStatCell('-', 'secondary'));
    tr.appendChild(createStatCell('-', 'secondary'));
  }

  return tr;
}

function createStatCell(value, color) {
  const td = document.createElement('td');
  td.className = 'stats-cell text-center';
  const badge = document.createElement('span');
  badge.className = `badge bg-${color} stats-badge`;
  badge.textContent = value;
  td.appendChild(badge);
  return td;
}

async function fetchKeywordReplyList(userId) {
  const json = await api.get('/keyword/list');
  const list = json.data || [];

  // Debug: 查看載入的資料
  list.forEach((item, index) => {
    if (item.quickReplyId) {
    }
  });

  return list;
}

async function getKeywordStats(keyword) {
  try {
    const json = await api.post('/keyword/stats', { keyword });
    return json.data || { total: 0, thisMonth: 0, lastMonth: 0 };
  } catch {
    return { total: 0, thisMonth: 0, lastMonth: 0 };
  }
}

// 儲存載入的 QR 模板（用於預覽）
let cachedQRTemplates = [];

/**
 * 載入 QR 模板列表到下拉選單
 */
async function loadQRTemplates(selectedId = null) {
  const select = document.getElementById('qr-template-select');
  const previewArea = document.getElementById('qr-preview-area');

  if (!select) return;

  // 重設下拉選單
  select.innerHTML = '<option value="">-- 不附加 Quick Reply --</option>';
  if (previewArea) previewArea.style.display = 'none';

  try {
    const json = await api.get('/quickreply/list');

    // 🆕 去除重複的 QR 模板（以 id 為準）
    const rawList = json.data || [];
    const uniqueMap = new Map();
    rawList.forEach(qr => {
      if (!uniqueMap.has(qr.id)) {
        uniqueMap.set(qr.id, qr);
      }
    });
    cachedQRTemplates = Array.from(uniqueMap.values());

    cachedQRTemplates.forEach(qr => {
      const option = document.createElement('option');
      option.value = qr.id;
      option.textContent = `${qr.name} (${qr.items?.length || 0} 個按鈕)`;
      if (selectedId && qr.id === selectedId) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    // 如果有預選的 QR，顯示預覽
    if (selectedId) {
      showQRPreview(selectedId);
    }
  } catch (err) {
    console.error('❌ 載入 QR 模板失敗:', err);
  }

  // 綁定預覽按鈕事件
  const previewBtn = document.getElementById('preview-qr-btn');
  if (previewBtn) {
    previewBtn.onclick = () => {
      const qrId = select.value;
      if (qrId) {
        showQRPreview(qrId);
      } else {
        if (previewArea) previewArea.style.display = 'none';
        toast.info('請先選擇 Quick Reply 模板');
      }
    };
  }

  // 下拉選單變更時自動更新預覽
  select.onchange = () => {
    const qrId = select.value;
    if (qrId) {
      showQRPreview(qrId);
    } else {
      if (previewArea) previewArea.style.display = 'none';
    }
  };
}

/**
 * 顯示 QR 按鈕預覽
 */
function showQRPreview(qrId) {
  const previewArea = document.getElementById('qr-preview-area');
  const buttonsContainer = document.getElementById('qr-buttons-preview');

  if (!previewArea || !buttonsContainer) return;

  const qr = cachedQRTemplates.find(q => q.id === qrId);
  if (!qr || !qr.items) {
    previewArea.style.display = 'none';
    return;
  }

  // 清空並渲染按鈕預覽
  buttonsContainer.innerHTML = '';
  qr.items.forEach(item => {
    const btn = document.createElement('span');
    btn.className = 'badge bg-primary';
    btn.style.fontSize = '0.85rem';
    btn.style.padding = '6px 12px';

    const action = item.action || {};
    let label = action.label || action.text || action.type || '按鈕';
    btn.textContent = label;
    buttonsContainer.appendChild(btn);
  });

  previewArea.style.display = 'block';
}