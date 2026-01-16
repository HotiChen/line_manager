// js/message_push.js
import { getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { toast } from "../helper/toast.js";
import { LoadingManager } from "./shared/loader.js";
import { getTagList } from "./tag.js";
import { confirmWarning } from "../helper/modal.helper.js";
import {
    generateReplyInputUI,
    getCurrentReplyInput,
    getMessageTypeIcon,
    formatMessagePreview
} from "../helper/message.helper.js";

let allMembers = [];
let allTags = [];
let allFlexs = [];
let allImagemaps = [];
let currentPushMessages = []; // 儲存已加入的訊息列表
let selectedMemberIds = new Set();
let currentUserId = null;


/**
 * 頁面初始化
 */
export async function pageInit(pageData) {
    currentUserId = pageData.userId || getUserId();
    setUserId(currentUserId);

    setupUI();
    await loadInitialData();
}

/**
 * 設置 UI 事件
 */
function setupUI() {
    // 篩選功能：關鍵字搜尋
    const searchInput = document.getElementById('member-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderMemberList());
    }

    // 監聽所有篩選器 Checkbox
    document.addEventListener('change', (e) => {
        if (e.target.classList.contains('gender-checkbox') ||
            e.target.classList.contains('age-checkbox') ||
            e.target.classList.contains('location-checkbox') ||
            e.target.classList.contains('tag-filter-checkbox')) {

            renderMemberList();
            updateFilterButtonText();
        }
    });

    // 防止點擊下拉選單內容時自動關閉
    document.querySelectorAll('.dropdown-menu').forEach(menu => {
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    });

    // 處理下拉選單內的「全選」與「清除」按鈕
    document.querySelectorAll('.select-all-btn, .clear-all-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetClass = e.target.dataset.target;
            const isSelectAll = e.target.classList.contains('select-all-btn');
            const checkboxes = document.querySelectorAll(`.${targetClass}`);

            checkboxes.forEach(cb => {
                cb.checked = isSelectAll;
            });

            renderMemberList();
            updateFilterButtonText();
        });
    });

    // 全域篩選器「全選所有」與「全部清除」
    const globalSelectAll = document.querySelector('.global-select-all');
    const globalClearAll = document.querySelector('.global-clear-all');

    if (globalSelectAll) {
        globalSelectAll.addEventListener('click', () => {
            const allFilterCbs = document.querySelectorAll('.tag-filter-checkbox, .gender-checkbox, .age-checkbox, .location-checkbox');
            allFilterCbs.forEach(cb => cb.checked = true);
            renderMemberList();
            updateFilterButtonText();
        });
    }

    if (globalClearAll) {
        globalClearAll.addEventListener('click', () => {
            const allFilterCbs = document.querySelectorAll('.tag-filter-checkbox, .gender-checkbox, .age-checkbox, .location-checkbox');
            allFilterCbs.forEach(cb => cb.checked = false);
            renderMemberList();
            updateFilterButtonText();
        });
    }

    // 全選顯示的會員
    const selectAllBtn = document.getElementById('select-all-members');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('change', (e) => {
            const visibleCheckboxes = document.querySelectorAll('.member-item-checkbox');
            visibleCheckboxes.forEach(cb => {
                cb.checked = e.target.checked;
                if (e.target.checked) {
                    selectedMemberIds.add(cb.value);
                } else {
                    selectedMemberIds.delete(cb.value);
                }
            });
            updateSelectedCount();
        });
    }

    // 加入訊息按鈕
    const addBtn = document.getElementById('btn-add-push-message');
    if (addBtn) {
        addBtn.addEventListener('click', handleAddMessage);
    }

    // 發送按鈕
    const sendBtn = document.getElementById('btn-send-message');
    if (sendBtn) {
        sendBtn.addEventListener('click', startSendingProcess);
    }

    // 重設按鈕 (全區域清除)
    const clearBtn = document.getElementById('btn-clear-message');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            currentPushMessages = [];
            renderPushMessageDisplay();
            selectedMemberIds.clear();
            const checkboxes = document.querySelectorAll('.member-item-checkbox');
            checkboxes.forEach(cb => cb.checked = false);
            updateSelectedCount();
        });
    }
}

/**
 * 載入初始資料
 */
async function loadInitialData() {
    try {
        LoadingManager.show('msg-push-init', '載入會員與標籤...');

        // 載入會員詳細資料
        const memberResult = await api.get('/member/list-full');
        if (memberResult.success) {
            allMembers = memberResult.data || [];
        }

        // 載入標籤
        allTags = await getTagList(currentUserId);

        // 載入 Flex Messages (用於後續尋找 altText 等資料)
        const flexResult = await api.get('/flex/list');
        if (flexResult.success || flexResult.flexs) {
            allFlexs = flexResult.flexs || flexResult.data || [];
        }

        // 載入 Imagemaps
        const imagemapResult = await api.get('/imagemap/list');
        if (imagemapResult.success || imagemapResult.imagemaps) {
            allImagemaps = imagemapResult.imagemaps || imagemapResult.data || [];
        }

        renderTagFilter();
        await initMessageEditorUI();
        renderMemberList();
        renderPushMessageDisplay();

        LoadingManager.hide('msg-push-init');
    } catch (err) {
        console.error("❌ 載入資料失敗:", err);
        toast.error('無法載入部分資料');
        LoadingManager.hide('msg-push-init');
    }
}

/**
 * 初始化訊息編輯器 (使用 message.helper.js)
 */
async function initMessageEditorUI() {
    const container = document.getElementById('reply-dynamic-fields');
    if (!container) return;

    try {
        const ui = await generateReplyInputUI({
            builder: 'welcome', // Welcome 模式支援 Text, Flex, Imagemap
            userId: currentUserId,
            onSelect: (type, selectedItem) => {
                // 選取時的 callback，我們主要靠 handleAddMessage 裡的 getCurrentReplyInput
            }
        });
        container.innerHTML = '';
        container.appendChild(ui);
    } catch (error) {
        console.error('❌ 初始化訊息編輯器失敗:', error);
    }
}

/**
 * 處理「加入訊息」按鈕點擊
 */
function handleAddMessage() {
    const input = getCurrentReplyInput();
    if (!input || !input.item) {
        toast.warning('請先選擇或輸入訊息內容');
        return;
    }

    if (currentPushMessages.length >= 5) {
        toast.error('LINE 限制單次發送最多 5 則訊息');
        return;
    }

    const lineMsg = convertToLineFormat(input.type, input.item);
    if (!lineMsg) {
        toast.error('訊息格式轉換失敗');
        return;
    }

    currentPushMessages.push(lineMsg);
    renderPushMessageDisplay();
    toast.success('已加入發送列表');
}

/**
 * 將內部 item 格式轉換為 LINE API 格式
 */
function convertToLineFormat(type, item) {
    if (type === 'text' || type === 'message') {
        const text = item.text?.trim();
        if (!text) return null;
        return { type: 'text', text: text };
    }

    if (type === 'flex') {
        // 從全域暫存中找尋完整 flex 資料
        const flexId = item.id || item.flexId;
        const flex = allFlexs.find(f => f.id === flexId);
        if (!flex) return { type: 'flex', altText: item.title || 'Flex Message', contents: item.contents }; // 若找不到則嘗試使用 item 原本的 contents
        return {
            type: 'flex',
            altText: flex.altText || flex.name || '您收到了一則 Flex 訊息',
            contents: flex.contents
        };
    }

    if (type === 'imagemap') {
        const mapId = item.id || item.name;
        const map = allImagemaps.find(m => (m.id || m.name) === mapId);
        if (!map) return null;
        return {
            type: 'imagemap',
            baseUrl: map.baseUrl,
            altText: map.altText || map.name || '您收到了一則圖卡訊息',
            baseSize: map.baseSize,
            actions: map.actions
        };
    }

    return null;
}

/**
 * 渲染已加入的訊息預覽
 */
function renderPushMessageDisplay() {
    const container = document.getElementById('push-message-display');
    const countBadge = document.getElementById('push-msg-count');
    if (!container) return;

    if (countBadge) {
        countBadge.textContent = `${currentPushMessages.length} / 5`;
    }

    if (currentPushMessages.length === 0) {
        container.innerHTML = `
            <div class="text-muted text-center py-4">
                <i class="bi bi-inbox fs-2 d-block mb-2"></i>
                尚未加入任何訊息
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    currentPushMessages.forEach((msg, index) => {
        const div = document.createElement('div');
        div.className = 'push-msg-item';
        div.innerHTML = `
            <span class="badge bg-secondary">${getMessageTypeIcon(msg.type)}</span>
            <div class="flex-grow-1 small text-truncate">
                ${formatMessagePreview(msg.type, msg)}
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger remove-btn" onclick="removePushMessage(${index})">
                <i class="bi bi-trash"></i>
            </button>
        `;
        container.appendChild(div);
    });
}

// 掛載全域移除函式
window.removePushMessage = function (index) {
    currentPushMessages.splice(index, 1);
    renderPushMessageDisplay();
};

/**
 * 渲染會員列表
 */
function renderMemberList() {
    const container = document.getElementById('member-list-display');
    const searchVal = document.getElementById('member-search')?.value.toLowerCase() || '';

    // 獲取所有已勾選的篩選條件
    const selectedTags = Array.from(document.querySelectorAll('.tag-filter-checkbox:checked')).map(cb => cb.value);
    const selectedGenders = Array.from(document.querySelectorAll('.gender-checkbox:checked')).map(cb => cb.value);
    const selectedAges = Array.from(document.querySelectorAll('.age-checkbox:checked')).map(cb => cb.value);
    const selectedLocations = Array.from(document.querySelectorAll('.location-checkbox:checked')).map(cb => cb.value);

    if (!container) return;

    container.innerHTML = '';

    const filtered = allMembers.filter(m => {
        // 搜尋
        const matchSearch = !searchVal ||
            (m.name || '').toLowerCase().includes(searchVal) ||
            (m.lineName || '').toLowerCase().includes(searchVal) ||
            (m.tags || []).some(t => t.toLowerCase().includes(searchVal));

        // 標籤 (OR)
        const matchTag = selectedTags.length === 0 ||
            selectedTags.some(tag => (m.tags || []).includes(tag));

        // 性別 (OR)
        const matchGender = selectedGenders.length === 0 ||
            selectedGenders.includes(m.gender);

        // 地點 (OR)
        let matchLocation = selectedLocations.length === 0;
        if (selectedLocations.length > 0) {
            matchLocation = selectedLocations.some(loc => {
                if (loc === '其他') {
                    const majorCities = ['台北市', '新北市', '台中市', '台南市', '高雄市'];
                    return !majorCities.includes(m.address);
                }
                return m.address === loc;
            });
        }

        // 年齡 (OR)
        let matchAge = selectedAges.length === 0;
        if (selectedAges.length > 0 && m.birthday) {
            const age = calculateAge(m.birthday);
            matchAge = selectedAges.some(ageRange => {
                if (ageRange === '0-18') return age <= 18;
                if (ageRange === '19-25') return age >= 19 && age <= 25;
                if (ageRange === '26-35') return age >= 26 && age <= 35;
                if (ageRange === '36-45') return age >= 36 && age <= 45;
                if (ageRange === '46+') return age >= 46;
                return false;
            });
        } else if (selectedAges.length > 0 && !m.birthday) {
            matchAge = false;
        }

        return matchSearch && matchTag && matchGender && matchLocation && matchAge;
    });

    document.getElementById('loaded-count').textContent = filtered.length;

    if (filtered.length === 0) {
        container.innerHTML = '<li class="list-group-item text-center py-4 text-muted">查無匹配會員</li>';
        return;
    }

    filtered.forEach(m => {
        const li = document.createElement('li');
        li.className = 'list-group-item';

        const name = m.name || m.lineName || '未命名';
        const isChecked = selectedMemberIds.has(m.memberId);

        li.innerHTML = `
            <div class="d-flex align-items-center">
                <input class="form-check-input member-item-checkbox me-3" type="checkbox" value="${m.memberId}" ${isChecked ? 'checked' : ''}>
                <div class="d-flex align-items-center flex-grow-1" style="cursor: pointer;">
                    ${m.pictureUrl ? `<img src="${m.pictureUrl}" class="rounded-circle me-2" width="24" height="24">` : '<div class="bg-light rounded-circle me-2 d-flex align-items-center justify-content-center" style="width: 24px; height: 24px;"><i class="bi bi-person text-secondary" style="font-size: 12px;"></i></div>'}
                    <div class="small">
                        <div class="fw-bold">${name}</div>
                        <div class="text-muted" style="font-size: 0.7rem;">${(m.tags || []).slice(0, 2).join(', ') || '無標籤'}</div>
                    </div>
                </div>
            </div>
        `;

        li.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            const cb = li.querySelector('.member-item-checkbox');
            cb.checked = !cb.checked;
            updateSelection(cb.value, cb.checked);
        });

        const cb = li.querySelector('.member-item-checkbox');
        cb.addEventListener('change', (e) => {
            updateSelection(e.target.value, e.target.checked);
        });

        container.appendChild(li);
    });
}

function updateSelection(memberId, isChecked) {
    if (isChecked) {
        selectedMemberIds.add(memberId);
    } else {
        selectedMemberIds.delete(memberId);
    }
    updateSelectedCount();
}

function updateSelectedCount() {
    const countEl = document.getElementById('selected-count');
    if (countEl) {
        countEl.textContent = `已選 ${selectedMemberIds.size} 人`;
    }
}

/**
 * 篩選按鈕文字更新
 */
function updateFilterButtonText() {
    const filters = [
        { selector: '.tag-filter-checkbox', btnId: 'dropdownTags', defaultText: '標籤篩選' },
        { selector: '.gender-checkbox', btnId: 'dropdownGender', defaultText: '性別篩選' },
        { selector: '.age-checkbox', btnId: 'dropdownAge', defaultText: '年齡篩選' },
        { selector: '.location-checkbox', btnId: 'dropdownLocation', defaultText: '地區篩選' }
    ];

    filters.forEach(f => {
        const checked = document.querySelectorAll(`${f.selector}:checked`);
        const btn = document.getElementById(f.btnId);
        if (btn) {
            btn.textContent = checked.length > 0 ? `${f.defaultText} (${checked.length})` : f.defaultText;
            btn.classList.toggle('btn-primary', checked.length > 0);
            btn.classList.toggle('btn-outline-secondary', checked.length === 0);
        }
    });
}

/**
 * 渲染標籤篩選清單
 */
function renderTagFilter() {
    const list = document.getElementById('tag-filter-list');
    if (!list) return;

    list.innerHTML = '';
    if (allTags.length === 0) {
        list.innerHTML = '<li class="small text-muted mb-1 text-center">目前無標籤</li>';
        return;
    }

    allTags.forEach((tag, index) => {
        const id = `tag-filter-${index}`;
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="form-check">
                <input class="form-check-input tag-filter-checkbox" type="checkbox" value="${tag.name}" id="${id}">
                <label class="form-check-label small" for="${id}">
                    ${tag.name} (${tag.total})
                </label>
            </div>
        `;
        list.appendChild(li);
    });
}

/**
 * 開始發送流程
 */
async function startSendingProcess() {
    if (selectedMemberIds.size === 0) {
        toast.error('請先選擇接收會員');
        return;
    }

    if (currentPushMessages.length === 0) {
        toast.error('請先加入要發送的訊息');
        return;
    }

    const confirmed = await confirmWarning(`確定要將 ${currentPushMessages.length} 則訊息發送給 ${selectedMemberIds.size} 位會員嗎？\n這可能會產生 LINE 訊息費用。`, '發送確認');
    if (!confirmed) return;

    const statusCard = document.getElementById('sending-status-card');
    const logContainer = document.getElementById('send-logs');
    const progressBar = document.getElementById('send-progress-bar');
    const sendBtn = document.getElementById('btn-send-message');

    statusCard.classList.remove('d-none');
    logContainer.innerHTML = '🚀 準備發送...<br>';
    sendBtn.disabled = true;

    const memberIds = Array.from(selectedMemberIds);
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < memberIds.length; i++) {
        const id = memberIds[memberIds.length - 1 - i]; // Reverse or not? Let's just go with i
        const member = allMembers.find(m => m.memberId === id);
        const memberName = member ? (member.name || member.lineName || id) : id;

        try {
            const response = await api.post('/api/send-message', {
                to: id,
                messages: currentPushMessages
            });

            if (response.success) {
                successCount++;
                logContainer.innerHTML += `<span class="text-success small">✅ ${memberName}: 成功</span><br>`;
            } else {
                failCount++;
                logContainer.innerHTML += `<span class="text-danger small">❌ ${memberName}: 失敗 (${response.error})</span><br>`;
            }
        } catch (err) {
            failCount++;
            logContainer.innerHTML += `<span class="text-danger small">❌ ${memberName}: 錯誤 (${err.message})</span><br>`;
        }

        const progress = Math.round(((i + 1) / memberIds.length) * 100);
        progressBar.style.width = `${progress}%`;
        progressBar.textContent = `${progress}%`;
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    toast.success(`任務完成！成功: ${successCount}, 失敗: ${failCount}`);
    sendBtn.disabled = false;
    logContainer.innerHTML += `🏁 任務結束。<br>`;
}

/**
 * 計算年齡
 */
function calculateAge(birthday) {
    if (!birthday) return 0;
    const birthDate = new Date(birthday);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
}
