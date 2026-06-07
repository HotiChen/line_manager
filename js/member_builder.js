// js/member_builder.js - 完整會員管理系統
import { getUserId, setUserId } from "../helper/state.js";
import { setInnerHTML } from '../helper/security.js';
import { api } from '../helper/api.client.js';
import { toast } from '../helper/toast.js';
import { LoadingManager } from './shared/loader.js';
import { confirmDanger } from '../helper/modal.helper.js';

let members = [];
let tags = [];
let currentEditingMember = null;

/**
 * 頁面初始化
 * 
 * Pre-conditions:
 * - 有 pageData 包含 userId
 * 
 * Post-conditions:
 * - 載入 members 與 tags 資料，渲染表格並綁定 UI 事件
 */
export async function pageInit(pageData) {
  setUserId(pageData.userId);

  LoadingManager.show('member-init', '載入會員資料...');

  try {
    await Promise.all([
      loadMembers(),
      loadTags()
    ]);

    renderMemberTable();
    setupEventListeners();

    LoadingManager.hide('member-init');
  } catch (error) {
    console.error("❌ 初始化失敗:", error);
    toast.error('載入失敗');
    LoadingManager.hide('member-init');
  }
}

/**
 * 載入所有會員
 * 
 * Pre-conditions:
 * - 後端 API `/member/list-full` 可連線
 * 
 * Post-conditions:
 * - 更新 members 陣列
 */
async function loadMembers() {
  try {
    const result = await api.get('/member/list-full');

    if (result.success) {
      members = result.data || [];
    }
  } catch (error) {
    console.error("❌ 載入會員失敗:", error);
    toast.error('載入會員失敗');
  }
}

/**
 * 載入所有標籤
 */
async function loadTags() {
  try {
    const result = await api.get('/tag/list');

    if (result.success) {
      // 後端現在回傳 [{name, total, stats}, ...]
      tags = result.data || [];
    }
  } catch (error) {
    console.error("❌ 載入標籤失敗:", error);
  }
}

/**
 * 渲染會員表格
 */
function renderMemberTable() {
  const tbody = document.getElementById('member-table-body');
  if (!tbody) return;

  if (members.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted py-4">
          尚無會員資料
        </td>
      </tr>
    `; // safe: no user input
    return;
  }

  tbody.innerHTML = ''; // safe: clear
  members.forEach(m => {
    const tr = document.createElement('tr');

    // Checkbox cell
    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'member-checkbox';
    cb.value = m.memberId;
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    // Avatar + name cell
    const tdName = document.createElement('td');
    const nameWrapper = document.createElement('div');
    nameWrapper.className = 'd-flex align-items-center';
    if (m.pictureUrl) {
      const img = document.createElement('img');
      img.src = m.pictureUrl;
      img.className = 'rounded-circle me-2';
      img.width = 32;
      img.height = 32;
      nameWrapper.appendChild(img);
    }
    const nameInner = document.createElement('div');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'fw-bold';
    nameDiv.textContent = m.name || m.lineName || '未設定';
    nameInner.appendChild(nameDiv);
    if (m.email) {
      const small = document.createElement('small');
      small.className = 'text-muted';
      small.textContent = m.email;
      nameInner.appendChild(small);
    }
    nameWrapper.appendChild(nameInner);
    tdName.appendChild(nameWrapper);
    tr.appendChild(tdName);

    // Tier cell
    const tdTier = document.createElement('td');
    const tierBadge = document.createElement('span');
    tierBadge.className = 'badge';
    tierBadge.style.backgroundColor = getTierColor(m.tier);
    tierBadge.textContent = `${getTierIcon(m.tier)} ${getTierName(m.tier)}`;
    tdTier.appendChild(tierBadge);
    tr.appendChild(tdTier);

    // Phone cell
    const tdPhone = document.createElement('td');
    tdPhone.textContent = m.phone || '-';
    tr.appendChild(tdPhone);

    // Tags cell
    const tdTags = document.createElement('td');
    const tagsArr = m.tags || [];
    if (tagsArr.length > 0) {
      tagsArr.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'badge bg-secondary me-1';
        span.textContent = tag;
        tdTags.appendChild(span);
      });
    } else {
      tdTags.textContent = '-';
    }
    tr.appendChild(tdTags);

    // Temperature cell
    const tdTemp = document.createElement('td');
    const tempBadge = document.createElement('span');
    tempBadge.className = `badge bg-${getTempColor(m.temperature)}`;
    tempBadge.textContent = `${getTempIcon(m.temperature)} ${m.temperature || 'warm'}`;
    tdTemp.appendChild(tempBadge);
    tr.appendChild(tdTemp);

    // Status cell
    const tdStatus = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `badge bg-${m.status === 'active' ? 'success' : 'secondary'}`;
    statusBadge.textContent = m.status || 'active';
    tdStatus.appendChild(statusBadge);
    tr.appendChild(tdStatus);

    // Actions cell
    const tdActions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-primary';
    editBtn.textContent = '編輯';
    editBtn.onclick = () => window.editMember(m.memberId);
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.textContent = '刪除';
    delBtn.onclick = () => window.deleteMember(m.memberId);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

/**
 * 設定事件監聽器
 */
function setupEventListeners() {
  // 新增會員
  const addBtn = document.getElementById('add-member-btn');
  if (addBtn) {
    addBtn.addEventListener('click', openAddMemberModal);
  }

  // 批次刪除
  const batchDeleteBtn = document.getElementById('batch-delete-btn');
  if (batchDeleteBtn) {
    batchDeleteBtn.addEventListener('click', batchDeleteMembers);
  }

  // 標籤管理
  const manageTagsBtn = document.getElementById('manage-tags-btn');
  if (manageTagsBtn) {
    manageTagsBtn.addEventListener('click', openTagManagementModal);
  }

  // 新增標籤按鈕監聽 (取代 onclick)
  const addTagBtn = document.getElementById('add-tag-confirm-btn');
  if (addTagBtn) {
    addTagBtn.addEventListener('click', window.addTag);
  }

  // 搜尋
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', filterMembers);
  }

  // Tag 篩選
  const tagFilter = document.getElementById('tag-filter');
  if (tagFilter) {
    renderTagFilterSelector();
    tagFilter.addEventListener('change', filterMembers);
  }

  // 溫度篩選
  const tempFilter = document.getElementById('temp-filter');
  if (tempFilter) {
    tempFilter.addEventListener('change', filterMembers);
  }

  // 狀態篩選
  const statusFilter = document.getElementById('status-filter');
  if (statusFilter) {
    statusFilter.addEventListener('change', filterMembers);
  }

  // 等級篩選
  const tierFilter = document.getElementById('tier-filter');
  if (tierFilter) {
    tierFilter.addEventListener('change', filterMembers);
  }

  // 儲存會員按鈕
  document.getElementById('save-member-btn')?.addEventListener('click', () => {
    window.saveMember();
  });
}

/**
 * 開啟新增會員 Modal
 */
function openAddMemberModal() {
  currentEditingMember = null;

  // 清空表單
  document.getElementById('edit-member-id').value = '';
  document.getElementById('edit-name').value = '';
  document.getElementById('edit-email').value = '';
  document.getElementById('edit-line-name').value = '';
  document.getElementById('edit-phone').value = '';
  document.getElementById('edit-gender').value = '';
  document.getElementById('edit-birthday').value = '';
  document.getElementById('edit-note').value = '';
  document.getElementById('edit-temperature').value = 'warm';
  document.getElementById('edit-status').value = 'active';
  document.getElementById('edit-tier').value = '0';

  // 渲染 Tag 選擇器
  renderTagCheckboxes([]);

  // 開啟 Modal
  const modal = new bootstrap.Modal(document.getElementById('editMemberModal'));
  modal.show();
}

/**
 * 編輯會員
 */
window.editMember = function (memberId) {
  const member = members.find(m => m.memberId === memberId);
  if (!member) return;

  currentEditingMember = member;

  // 填充表單
  document.getElementById('edit-member-id').value = member.memberId;
  document.getElementById('edit-name').value = member.name || '';
  document.getElementById('edit-email').value = member.email || '';
  document.getElementById('edit-line-name').value = member.lineName || '';
  document.getElementById('edit-phone').value = member.phone || '';
  document.getElementById('edit-gender').value = member.gender || '';
  document.getElementById('edit-birthday').value = member.birthday || '';
  document.getElementById('edit-note').value = member.note || '';
  document.getElementById('edit-temperature').value = member.temperature || 'warm';
  document.getElementById('edit-status').value = member.status || 'active';
  document.getElementById('edit-tier').value = member.tier !== undefined ? member.tier : '0';

  // 渲染 Tag 選擇器
  renderTagCheckboxes(member.tags || []);

  // 開啟 Modal
  const modal = new bootstrap.Modal(document.getElementById('editMemberModal'));
  modal.show();
};

/**
 * 儲存會員
 * 
 * Pre-conditions:
 * - 編輯表單已填寫包含 memberId
 * 
 * Post-conditions:
 * - 會員資料更新至後端，並刷新前端列表
 */
window.saveMember = async function () {
  const memberId = document.getElementById('edit-member-id').value.trim();

  if (!memberId) {
    toast.error('請輸入 Member ID');
    return;
  }

  // 收集選中的 tags
  const selectedTags = Array.from(
    document.querySelectorAll('.tag-checkbox:checked')
  ).map(cb => cb.value);

  const memberData = {
    memberId,
    name: document.getElementById('edit-name').value.trim(),
    email: document.getElementById('edit-email').value.trim(),
    lineName: document.getElementById('edit-line-name').value.trim(),
    phone: document.getElementById('edit-phone').value.trim(),
    gender: document.getElementById('edit-gender').value,
    birthday: document.getElementById('edit-birthday').value,
    note: document.getElementById('edit-note').value.trim(),
    temperature: document.getElementById('edit-temperature').value,
    status: document.getElementById('edit-status').value, // 🆕 新增狀態欄位
    tier: parseInt(document.getElementById('edit-tier').value),
    tags: selectedTags
  };


  try {
    LoadingManager.show('save-member', '儲存中...');

    const result = await api.post('/member/save', memberData);

    if (result.success) {
      toast.success('儲存成功');
      await loadMembers();
      renderMemberTable();

      // 關閉 Modal
      bootstrap.Modal.getInstance(document.getElementById('editMemberModal')).hide();
    } else {
      toast.error('儲存失敗：' + (result.error || '未知錯誤'));
    }
  } catch (error) {
    console.error('儲存失敗:', error);
    toast.error('儲存失敗');
  } finally {
    LoadingManager.hide('save-member');
  }
};

/**
 * 刪除會員
 */
window.deleteMember = async function (memberId) {
  const member = members.find(m => m.memberId === memberId);
  if (!member) return;

  const confirmed = await confirmDanger(
    `確定要刪除會員「${member.name || member.lineName}」嗎？`,
    '刪除會員'
  );

  if (!confirmed) return;

  try {
    const result = await api.post('/member/delete', { memberId });

    if (result.success) {
      toast.success('刪除成功');
      await loadMembers();
      renderMemberTable();
    } else {
      toast.error('刪除失敗');
    }
  } catch (error) {
    console.error('刪除失敗:', error);
    toast.error('刪除失敗');
  }
};

/**
 * 批次刪除會員
 * 
 * Pre-conditions:
 * - 列表至少勾選一個 checkbox
 * 
 * Post-conditions:
 * - 逐一呼叫 API 刪除會員清單，並統整刪除成功與失敗的數量提示此用戶
 */
async function batchDeleteMembers() {
  // 取得所有勾選的 checkbox
  const checkedBoxes = document.querySelectorAll('.member-checkbox:checked');

  if (checkedBoxes.length === 0) {
    toast.error('請先選擇要刪除的會員');
    return;
  }

  const memberIds = Array.from(checkedBoxes).map(cb => cb.value);
  const memberNames = memberIds.map(id => {
    const m = members.find(member => member.memberId === id);
    return m ? (m.name || m.lineName) : id;
  });

  // 確認刪除（使用 Modal）
  const message = `確定要刪除 ${memberIds.length} 位會員嗎？\n\n${memberNames.slice(0, 5).join('\n')}${memberIds.length > 5 ? '\n...' : ''}`;
  const confirmed = await confirmDanger(message, '批次刪除會員');

  if (!confirmed) return;

  try {
    LoadingManager.show('batch-delete', '批次刪除中...');

    let successCount = 0;
    let failCount = 0;

    // 逐一刪除
    for (const memberId of memberIds) {
      try {
        const result = await api.post('/member/delete', { memberId });
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        failCount++;
      }
    }

    LoadingManager.hide('batch-delete');

    if (successCount > 0) {
      toast.success(`成功刪除 ${successCount} 位會員${failCount > 0 ? `，${failCount} 位失敗` : ''}`);
      await loadMembers();
      renderMemberTable();
    } else {
      toast.error('批次刪除失敗');
    }
  } catch (error) {
    console.error('批次刪除失敗:', error);
    toast.error('批次刪除失敗');
    LoadingManager.hide('batch-delete');
  }
}

/**
 * 渲染 Tag 選擇器
 */
function renderTagCheckboxes(selectedTags = []) {
  const container = document.getElementById('tag-checkboxes');
  if (!container) return;

  if (tags.length === 0) {
    setInnerHTML(container, '<p class="text-muted">尚無標籤</p>');
    return;
  }

  setInnerHTML(container, tags.map(tagObj => {
    const tagName = tagObj.name || tagObj;
    return `
      <div class="form-check">
        <input class="form-check-input tag-checkbox" type="checkbox" 
          value="${tagName}" id="tag-${tagName}" 
          ${selectedTags.includes(tagName) ? 'checked' : ''}>
        <label class="form-check-label" for="tag-${tagName}">
          ${tagName}
        </label>
      </div>
    `;
  }).join(''));
}

/**
 * 渲染 Tag 篩選選擇器
 */
function renderTagFilterSelector() {
  const select = document.getElementById('tag-filter');
  if (!select) return;

  setInnerHTML(select, `
    <option value="">所有標籤</option>
    ${tags.map(t => {
    const name = t.name || t;
    return `<option value="${name}">${name}</option>`;
  }).join('')}
  `);
}

/**
 * 開啟標籤管理 Modal
 */
function openTagManagementModal() {
  renderTagManagementList();
  const modal = new bootstrap.Modal(document.getElementById('tagManagementModal'));
  modal.show();
}

/**
 * 渲染標籤管理列表
 */
function renderTagManagementList() {
  const container = document.getElementById('tag-list-container');
  if (!container) return;

  if (tags.length === 0) {
    container.innerHTML = '<p class="text-center text-muted py-3">目前尚無標籤</p>'; // safe: no user input
    return;
  }

  container.innerHTML = ''; // safe: clear
  tags.forEach(tagObj => {
    const name = tagObj.name || tagObj;
    const count = tagObj.total || 0;

    const item = document.createElement('div');
    item.className = 'list-group-item d-flex justify-content-between align-items-center';

    const left = document.createElement('div');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'fw-bold';
    nameSpan.textContent = name;
    const countBadge = document.createElement('span');
    countBadge.className = 'badge bg-light text-dark ms-2';
    countBadge.textContent = `${count} bits`;
    left.appendChild(nameSpan);
    left.appendChild(countBadge);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.textContent = '🗑️';
    delBtn.onclick = () => window.removeTag(name);

    item.appendChild(left);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

/**
 * 新增標籤
 */
window.addTag = async function () {
  const input = document.getElementById('new-tag-input');
  const name = input.value.trim();

  if (!name) {
    toast.error('請輸入標籤名稱');
    return;
  }

  // 修正：tags 現在是物件陣列 [{name, ...}, ...]
  const exists = tags.some(t => (t.name || t) === name);
  if (exists) {
    toast.error('標籤已存在');
    return;
  }

  try {
    const result = await api.post('/tag/save', { name });
    if (result.success) {
      toast.success('標籤新增成功');
      input.value = '';
      await loadTags();
      renderTagManagementList();
      renderTagFilterSelector();
      // 如果正在編輯會員，也要更新 checkbox
      if (currentEditingMember) {
        renderTagCheckboxes(currentEditingMember.tags || []);
      }
    } else {
      toast.error('新增失敗：' + (result.error || '未知錯誤'));
    }
  } catch (error) {
    console.error('新增標籤失敗:', error);
    toast.error('新增標籤失敗');
  }
};

/**
 * 刪除標籤 (單筆)
 */
window.removeTag = async function (tagName) {
  const confirmed = await confirmDanger(`確定要刪除標籤「${tagName}」嗎？\n這不會移除會員已有的標籤資料，但標籤清單將不再顯示此選項。`, '刪除標籤');
  if (!confirmed) return;

  try {
    const result = await api.post('/tag/delete', { name: tagName });
    if (result.success) {
      toast.success('標籤已刪除');
      await loadTags();
      renderTagManagementList();
      renderTagFilterSelector();
      // 如果正在編輯會員，也要更新 checkbox
      if (currentEditingMember) {
        renderTagCheckboxes(currentEditingMember.tags || []);
      }
    } else {
      toast.error('刪除失敗');
    }
  } catch (error) {
    console.error('刪除標籤失敗:', error);
    toast.error('刪除標籤失敗');
  }
};

/**
 * 篩選會員
 */
function filterMembers() {
  const searchText = document.getElementById('search-input')?.value.toLowerCase() || '';
  const selectedTag = document.getElementById('tag-filter')?.value || '';
  const selectedTemp = document.getElementById('temp-filter')?.value || '';
  const selectedStatus = document.getElementById('status-filter')?.value || '';
  const selectedTier = document.getElementById('tier-filter')?.value || '';

  const filtered = members.filter(member => {
    // 文字搜尋
    const matchText = !searchText ||
      member.name?.toLowerCase().includes(searchText) ||
      member.email?.toLowerCase().includes(searchText) ||
      member.lineName?.toLowerCase().includes(searchText) ||
      member.phone?.includes(searchText);

    // Tag 篩選
    const matchTag = !selectedTag ||
      (member.tags || []).includes(selectedTag);

    // 溫度篩選
    const matchTemp = !selectedTemp ||
      member.temperature === selectedTemp;

    // 狀態篩選
    const matchStatus = !selectedStatus ||
      member.status === selectedStatus;

    // 等級篩選
    const matchTier = !selectedTier ||
      String(member.tier || 0) === selectedTier;

    return matchText && matchTag && matchTemp && matchStatus && matchTier;
  });

  // 暫時更新顯示
  const tbody = document.getElementById('member-table-body');
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted py-4">
          沒有符合條件的會員
        </td>
      </tr>
    `; // safe: no user input
    return;
  }

  tbody.innerHTML = ''; // safe: clear
  filtered.forEach(m => {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'member-checkbox';
    cb.value = m.memberId;
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdName = document.createElement('td');
    const nameWrapper = document.createElement('div');
    nameWrapper.className = 'd-flex align-items-center';
    if (m.pictureUrl) {
      const img = document.createElement('img');
      img.src = m.pictureUrl;
      img.className = 'rounded-circle me-2';
      img.width = 32;
      img.height = 32;
      nameWrapper.appendChild(img);
    }
    const nameInner = document.createElement('div');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'fw-bold';
    nameDiv.textContent = m.name || m.lineName || '未設定';
    nameInner.appendChild(nameDiv);
    if (m.email) {
      const small = document.createElement('small');
      small.className = 'text-muted';
      small.textContent = m.email;
      nameInner.appendChild(small);
    }
    nameWrapper.appendChild(nameInner);
    tdName.appendChild(nameWrapper);
    tr.appendChild(tdName);

    const tdTier = document.createElement('td');
    const tierBadge = document.createElement('span');
    tierBadge.className = 'badge';
    tierBadge.style.backgroundColor = getTierColor(m.tier);
    tierBadge.textContent = `${getTierIcon(m.tier)} ${getTierName(m.tier)}`;
    tdTier.appendChild(tierBadge);
    tr.appendChild(tdTier);

    const tdPhone = document.createElement('td');
    tdPhone.textContent = m.phone || '-';
    tr.appendChild(tdPhone);

    const tdTags = document.createElement('td');
    const tagsArr = m.tags || [];
    if (tagsArr.length > 0) {
      tagsArr.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'badge bg-secondary me-1';
        span.textContent = tag;
        tdTags.appendChild(span);
      });
    } else {
      tdTags.textContent = '-';
    }
    tr.appendChild(tdTags);

    const tdTemp = document.createElement('td');
    const tempBadge = document.createElement('span');
    tempBadge.className = `badge bg-${getTempColor(m.temperature)}`;
    tempBadge.textContent = `${getTempIcon(m.temperature)} ${m.temperature || 'warm'}`;
    tdTemp.appendChild(tempBadge);
    tr.appendChild(tdTemp);

    const tdStatus = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `badge bg-${m.status === 'active' ? 'success' : 'secondary'}`;
    statusBadge.textContent = m.status;
    tdStatus.appendChild(statusBadge);
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-primary';
    editBtn.textContent = '編輯';
    editBtn.onclick = () => window.editMember(m.memberId);
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.textContent = '刪除';
    delBtn.onclick = () => window.deleteMember(m.memberId);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

/**
 * 輔助函數
 */
function getTempColor(temp) {
  if (temp === 'hot') return 'danger';
  if (temp === 'warm') return 'warning';
  if (temp === 'cold') return 'info';
  return 'secondary';
}

function getTempIcon(temp) {
  if (temp === 'hot') return '🔥';
  if (temp === 'warm') return '🌤️';
  if (temp === 'cold') return '❄️';
  return '';
}

function getTierName(tier) {
  const tiers = ["新手", "一般", "VIP", "SVIP"];
  return tiers[tier] || tiers[0];
}

function getTierIcon(tier) {
  const icons = ["🌱", "⭐", "💎", "👑"];
  return icons[tier] || icons[0];
}

function getTierColor(tier) {
  const colors = ["#4caf50", "#2196f3", "#ff9800", "#f44336"];
  return colors[tier] || colors[0];
}