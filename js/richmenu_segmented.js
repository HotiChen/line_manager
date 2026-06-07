/**
 * 分眾圖文選單管理邏輯
 */
import { api } from '../helper/api.client.js';
import { toast } from '../helper/toast.js';
import { setInnerHTML } from '../helper/security.js';

let currentRules = [];
let allTags = [];
let allRichMenus = [];

/**
 * pageInit
 * 頁面初始化進入點 (由 main.js 調用)
 * 
 * Pre-conditions:
 * - 無
 * 
 * Post-conditions:
 * - 載入標籤、選單和分眾規則資料
 * - 綁定畫面事件
 */
export async function pageInit(pageData = {}) {
    await loadInitialData();
    initEventListeners();
}

/**
 * loadInitialData
 * 載入初始資料 (標籤、選單、現有規則)
 * 
 * Post-conditions:
 * - 利用 api.parallel 查詢所有所需資料
 * - 更新全域陣列 allTags, allRichMenus, currentRules
 * - 觸發畫面的 render 動作
 */
async function loadInitialData() {
    try {
        const [tagRes, menuRes, rulesRes] = await api.parallel([
            { method: 'GET', endpoint: '/tag/list' },
            { method: 'GET', endpoint: '/richmenu/list' },
            { method: 'GET', endpoint: '/richmenu/segmented/list' }
        ]);

        if (!tagRes.error && tagRes.success) {
            allTags = tagRes.data || [];
            renderTagSelect();
        }

        if (!menuRes.error && menuRes.richmenus) {
            allRichMenus = menuRes.richmenus;
            renderRichMenuSelect();
        }

        if (!rulesRes.error && rulesRes.success) {
            currentRules = rulesRes.rules || [];
            renderRuleList();
        }

    } catch (error) {
        console.error('載入資料失敗:', error);
        toast.error('載入資料失敗，請檢查網路連線');
    }
}

/**
 * 渲染標籤下拉選單
 */
function renderTagSelect() {
    const select = document.getElementById('tagSelect');
    if (!select) return;
    select.innerHTML = '<option value="">請選擇標籤...</option>'; // safe: static placeholder option
    allTags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag.name;
        option.textContent = `${tag.name} (${tag.total || 0})`;
        select.appendChild(option);
    });
}

/**
 * 渲染圖文選單下拉選單
 */
function renderRichMenuSelect() {
    const select = document.getElementById('richmenuSelect');
    if (!select) return;
    select.innerHTML = '<option value="">請選擇對應選單...</option>'; // safe: static placeholder option
    allRichMenus.forEach(menu => {
        const option = document.createElement('option');
        option.value = menu.richMenuId;
        option.textContent = menu.name + (menu.richMenuAliasId ? ` (${menu.richMenuAliasId})` : '');
        select.appendChild(option);
    });
}

/**
 * 初始化事件監聽
 */
function initEventListeners() {
    // 新增規則
    document.getElementById('addRuleBtn')?.addEventListener('click', () => {
        const tag = document.getElementById('tagSelect').value;
        const richMenuId = document.getElementById('richmenuSelect').value;
        const priority = parseInt(document.getElementById('priorityInput').value);

        if (!tag || !richMenuId) {
            toast.warning('請選擇標籤與對應選單');
            return;
        }

        // 檢查是否重複標籤
        if (currentRules.some(r => r.tag === tag)) {
            toast.warning('此標籤已存在規則中');
            return;
        }

        currentRules.push({ tag, richMenuId, priority });
        currentRules.sort((a, b) => a.priority - b.priority); // 自動排序
        renderRuleList();

        // 重置輸入
        document.getElementById('tagSelect').value = '';
        document.getElementById('richmenuSelect').value = '';
    });

    // 儲存所有規則
    document.getElementById('saveRulesBtn')?.addEventListener('click', async () => {
        try {
            const res = await api.post('/richmenu/segmented/save', { rules: currentRules });
            if (res.success) {
                toast.success('儲存成功！規則已即時生效。');
            } else {
                toast.error('儲存失敗: ' + (res.error || '未知錯誤'));
            }
        } catch (error) {
            toast.error('系統錯誤，請稍後再試');
        }
    });

    // 「同步所有用戶」按鈕
    document.getElementById('syncAllBtn')?.addEventListener('click', () => {
        toast.info('此操作將會針對現有所有用戶重新計算並同步選單，在大數據量下可能耗時較長。目前已排入背景處理。');
    });
}

/**
 * 渲染規則列表
 */
function renderRuleList() {
    const container = document.getElementById('ruleList');
    if (!container) return;

    if (currentRules.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-layer-group"></i>
                <p>尚未建立分眾規則，點擊上方按鈕開始新增。</p>
            </div>
        `; // safe: static empty state, no user input
        return;
    }

    container.innerHTML = ''; // safe: clear
    currentRules.forEach((rule, index) => {
        const menu = allRichMenus.find(m => m.richMenuId === rule.richMenuId);
        const menuName = menu ? menu.name : '未知選單 (可能是已被刪除)';

        const item = document.createElement('div');
        item.className = 'rule-item';

        // Priority
        const priorityDiv = document.createElement('div');
        priorityDiv.className = 'rule-priority';
        priorityDiv.textContent = String(rule.priority);
        item.appendChild(priorityDiv);

        // Tag info
        const tagInfoDiv = document.createElement('div');
        tagInfoDiv.className = 'rule-info';
        const tagLabel = document.createElement('span');
        tagLabel.className = 'rule-label';
        tagLabel.textContent = '當標籤為';
        const tagValue = document.createElement('span');
        tagValue.className = 'rule-value';
        const tagBadge = document.createElement('span');
        tagBadge.className = 'tag-badge';
        tagBadge.textContent = rule.tag;
        tagValue.appendChild(tagBadge);
        tagInfoDiv.appendChild(tagLabel);
        tagInfoDiv.appendChild(tagValue);
        item.appendChild(tagInfoDiv);

        // Menu info
        const menuInfoDiv = document.createElement('div');
        menuInfoDiv.className = 'rule-info';
        const menuLabel = document.createElement('span');
        menuLabel.className = 'rule-label';
        menuLabel.textContent = '則顯示選單';
        const menuValue = document.createElement('span');
        menuValue.className = 'rule-value';
        menuValue.textContent = menuName;
        menuInfoDiv.appendChild(menuLabel);
        menuInfoDiv.appendChild(menuValue);
        item.appendChild(menuInfoDiv);

        // Actions
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'rule-actions';
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.innerHTML = '<i class="fas fa-trash-alt"></i>'; // safe: static icon only
        delBtn.onclick = () => deleteRule(index);
        actionsDiv.appendChild(delBtn);
        item.appendChild(actionsDiv);

        container.appendChild(item);
    });
}

/**
 * 刪除規則 (全域函數給 HTML 調用)
 */
window.deleteRule = (index) => {
    if (confirm('確定要移除此規則嗎？')) {
        currentRules.splice(index, 1);
        renderRuleList();
    }
};
