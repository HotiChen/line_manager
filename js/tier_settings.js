// js/tier_settings.js
import { getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { toast } from '../helper/toast.js';
import { LoadingManager } from './shared/loader.js';
import { setInnerHTML } from '../helper/security.js';

let tierConfig = null;
let tierStats = null;
let richMenuList = [];

/**
 * 頁面初始化
 */
export async function pageInit(pageData) {
    setUserId(pageData.userId);

    LoadingManager.show('tier-init', '載入等級設定...');

    try {
        await Promise.all([
            loadTierConfig(),
            loadTierStats(),
            loadRichMenuList()
        ]);

        renderTierRules();
        renderTierStats();
        renderBenefitSwitches();
        setupEventListeners();

        LoadingManager.hide('tier-init');
    } catch (error) {
        console.error("❌ 初始化失敗:", error);
        toast.error('載入失敗');
        LoadingManager.hide('tier-init');
    }
}

/**
 * 載入等級配置
 * 
 * Pre-conditions:
 * - api 物件與 /tier/config 後端路由有效
 * 
 * Post-conditions:
 * - 將取得的配置儲存到 tierConfig 供畫面渲染使用 
 */
async function loadTierConfig() {
    try {
        const result = await api.get('/tier/config');
        if (result.success) {
            tierConfig = result.config;
        }
    } catch (error) {
        console.error("❌ 載入等級配置失敗:", error);
        throw error;
    }
}

/**
 * 載入等級統計
 */
async function loadTierStats() {
    try {
        const result = await api.get('/tier/stats');
        if (result.success) {
            tierStats = result.stats;
        }
    } catch (error) {
        console.error("❌ 載入等級統計失敗:", error);
    }
}

/**
 * 載入 Rich Menu 列表
 */
async function loadRichMenuList() {
    try {
        const result = await api.get('/richmenu/list');
        if (result && result.richmenus) {
            richMenuList = result.richmenus;
        }
    } catch (error) {
        console.error("❌ 載入 Rich Menu 列表失敗:", error);
    }
}

/**
 * 渲染規則表格
 */
function renderTierRules() {
    const tbody = document.getElementById('tier-rules-body');
    if (!tbody || !tierConfig) return;

    // 確保 tiers 存在且是陣列
    if (!tierConfig.tiers || !Array.isArray(tierConfig.tiers) || tierConfig.tiers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">目前沒有等級規則。請點擊「重設為預設值」或「儲存變更」來初始化。</td></tr>`; // safe: static message, no user input
        return;
    }

    tbody.innerHTML = ''; // safe: clear
    tierConfig.tiers.forEach((tier, index) => {
        const intRules = tierConfig.upgradeRules?.interactions?.rules || [];
        const timeRules = tierConfig.upgradeRules?.timeBased?.rules || [];
        const intRule = intRules.find(r => r.tier === tier.id) || { interactions: 0 };
        const timeRule = timeRules.find(r => r.tier === tier.id) || { days: 0 };

        const tr = document.createElement('tr');
        tr.className = 'tier-row';
        tr.dataset.tierId = tier.id;

        // Icon + level label cell
        const tdIcon = document.createElement('td');
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'd-flex align-items-center';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'fs-4 me-2';
        iconSpan.textContent = tier.icon || '🌱';
        const levelSpan = document.createElement('span');
        levelSpan.className = 'fw-bold';
        levelSpan.textContent = `等級 ${tier.id}`;
        iconWrapper.appendChild(iconSpan);
        iconWrapper.appendChild(levelSpan);
        tdIcon.appendChild(iconWrapper);
        tr.appendChild(tdIcon);

        // Name input cell
        const tdName = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'form-control tier-name-input';
        nameInput.value = tier.name || '';
        tdName.appendChild(nameInput);
        tr.appendChild(tdName);

        // Title input cell
        const tdTitle = document.createElement('td');
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'form-control tier-title-input';
        titleInput.value = tier.title || '';
        tdTitle.appendChild(titleInput);
        tr.appendChild(tdTitle);

        // Interactions input cell
        const tdInt = document.createElement('td');
        const intGroup = document.createElement('div');
        intGroup.className = 'input-group';
        const intInput = document.createElement('input');
        intInput.type = 'number';
        intInput.className = 'form-control tier-int-input';
        intInput.value = String(intRule.interactions || 0);
        if (tier.id === 0) intInput.disabled = true;
        const intText = document.createElement('span');
        intText.className = 'input-group-text';
        intText.textContent = '次';
        intGroup.appendChild(intInput);
        intGroup.appendChild(intText);
        tdInt.appendChild(intGroup);
        tr.appendChild(tdInt);

        // Days input cell
        const tdDays = document.createElement('td');
        const daysGroup = document.createElement('div');
        daysGroup.className = 'input-group';
        const daysInput = document.createElement('input');
        daysInput.type = 'number';
        daysInput.className = 'form-control tier-days-input';
        daysInput.value = String(timeRule.days || 0);
        if (tier.id === 0) daysInput.disabled = true;
        const daysText = document.createElement('span');
        daysText.className = 'input-group-text';
        daysText.textContent = '天';
        daysGroup.appendChild(daysInput);
        daysGroup.appendChild(daysText);
        tdDays.appendChild(daysGroup);
        tr.appendChild(tdDays);

        // Richmenu select cell
        const tdMenu = document.createElement('td');
        const menuSelect = document.createElement('select');
        menuSelect.className = 'form-select tier-richmenu-select';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = '-- 不變動 / 預設 --';
        menuSelect.appendChild(defaultOpt);
        richMenuList.forEach(menu => {
            const opt = document.createElement('option');
            opt.value = menu.richMenuId;
            opt.textContent = menu.name + (menu.richMenuAliasId ? ` (${menu.richMenuAliasId})` : '');
            if (tier.richMenuId === menu.richMenuId) opt.selected = true;
            menuSelect.appendChild(opt);
        });
        tdMenu.appendChild(menuSelect);
        tr.appendChild(tdMenu);

        tbody.appendChild(tr);
    });

    // 初始化自動升級開關
    const autoUpgradeEnabled = (tierConfig.upgradeRules?.interactions?.enabled || tierConfig.upgradeRules?.timeBased?.enabled);
    const switchEl = document.getElementById('enable-auto-upgrade');
    if (switchEl) switchEl.checked = autoUpgradeEnabled;
}

/**
 * 渲染統計卡片
 */
function renderTierStats() {
    const container = document.getElementById('stats-container');
    if (!container || !tierStats) return;

    const tiers = tierConfig?.tiers || [];

    container.innerHTML = ''; // safe: clear
    tiers.forEach(t => {
        const col = document.createElement('div');
        col.className = 'col-md-3';

        const card = document.createElement('div');
        card.className = `card tier-card tier-${t.id} shadow-sm border-0`;

        const body = document.createElement('div');
        body.className = 'card-body';

        const topRow = document.createElement('div');
        topRow.className = 'd-flex justify-content-between align-items-center mb-2';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'fs-4';
        iconSpan.textContent = t.icon;

        const nameBadge = document.createElement('span');
        nameBadge.className = 'badge rounded-pill bg-light text-dark';
        nameBadge.textContent = t.name;

        topRow.appendChild(iconSpan);
        topRow.appendChild(nameBadge);

        const countH3 = document.createElement('h3');
        countH3.className = 'mb-0 fw-bold';
        countH3.textContent = String(tierStats.tiers[t.id] || 0);

        const totalP = document.createElement('p');
        totalP.className = 'text-muted small mb-0';
        totalP.textContent = '總計會員數';

        body.appendChild(topRow);
        body.appendChild(countH3);
        body.appendChild(totalP);
        card.appendChild(body);
        col.appendChild(card);
        container.appendChild(col);
    });
}

/**
 * 渲染權益開關
 */
function renderBenefitSwitches() {
    if (!tierConfig || !tierConfig.benefits) return;

    const benefits = tierConfig.benefits;
    const titleEl = document.getElementById('benefit-custom-title');
    const repliesEl = document.getElementById('benefit-specific-replies');
    const richMenuEl = document.getElementById('benefit-rich-menu');

    if (titleEl) titleEl.checked = benefits.customTitle?.enabled || false;
    if (repliesEl) repliesEl.checked = benefits.tierSpecificReplies?.enabled || false;
    if (richMenuEl) richMenuEl.checked = benefits.richMenu?.enabled || false;
}

/**
 * 設定事件監聽器
 */
function setupEventListeners() {
    document.getElementById('save-all-btn')?.addEventListener('click', saveAllSettings);
    document.getElementById('reset-defaults-btn')?.addEventListener('click', resetToDefaults);
}

/**
 * 重設為預設值
 * 
 * Pre-conditions:
 * - 無
 * 
 * Post-conditions:
 * - 以內建的 DEFAULT_CONFIG 取代現有的 tierConfig，並更新畫面
 * - 但未送至伺服器儲存，需再點擊「儲存所有設定」才會真正生效
 */
function resetToDefaults() {
    if (!confirm('確定要將所有等級設定重設為預設值嗎？（此動作不會即時儲存到伺服器）')) return;

    const DEFAULT_CONFIG = {
        upgradeRules: {
            interactions: {
                enabled: true,
                rules: [
                    { tier: 0, interactions: 0, name: "新手" },
                    { tier: 1, interactions: 10, name: "一般" },
                    { tier: 2, interactions: 50, name: "VIP" },
                    { tier: 3, interactions: 200, name: "SVIP" }
                ]
            },
            timeBased: {
                enabled: true,
                rules: [
                    { tier: 0, days: 0, name: "新手" },
                    { tier: 1, days: 7, name: "一般" },
                    { tier: 2, days: 30, name: "VIP" },
                    { tier: 3, days: 90, name: "SVIP" }
                ]
            },
            manual: { enabled: true }
        },
        benefits: {
            customTitle: { enabled: true },
            tierSpecificReplies: { enabled: true },
            richMenu: { enabled: false }
        },
        tiers: [
            { id: 0, name: "新手", title: "親愛的", icon: "🌱", color: "#4caf50" },
            { id: 1, name: "一般", title: "會員", icon: "⭐", color: "#2196f3" },
            { id: 2, name: "VIP", title: "尊貴的 VIP", icon: "💎", color: "#ff9800" },
            { id: 3, name: "SVIP", title: "至尊 SVIP", icon: "👑", color: "#f44336" }
        ]
    };

    tierConfig = DEFAULT_CONFIG;
    renderTierRules();
    renderBenefitSwitches();
    toast.info('已恢復預設顯示，請點擊儲存以生效');
}

/**
 * 儲存所有設定
 * 
 * Pre-conditions:
 * - 各表單欄位已經填妥，並且有現有的 tierConfig 可以當作基底擴充
 * 
 * Post-conditions:
 * - 將新的 `newConfig` 傳送給後端 API
 * - 回傳成功將重新渲染畫面與統計，讓最新配置就緒
 */
async function saveAllSettings() {
    if (!tierConfig) return;

    LoadingManager.show('save-tier', '儲存設定中...');

    try {
        // 1. 收集規則
        const rows = document.querySelectorAll('.tier-row');
        const updatedTiers = [];
        const intRules = [];
        const timeRules = [];

        rows.forEach(row => {
            const tierId = parseInt(row.dataset.tierId);
            const name = row.querySelector('.tier-name-input').value.trim();
            const title = row.querySelector('.tier-title-input').value.trim();
            const interactions = parseInt(row.querySelector('.tier-int-input').value) || 0;
            const days = parseInt(row.querySelector('.tier-days-input').value) || 0;
            const richMenuId = row.querySelector('.tier-richmenu-select').value;

            updatedTiers.push({
                id: tierId,
                name,
                title,
                icon: getTierIcon(tierId),
                color: getTierColor(tierId),
                richMenuId: richMenuId || null
            });

            intRules.push({ tier: tierId, interactions, name });
            timeRules.push({ tier: tierId, days, name });
        });

        // 2. 收集開關
        const autoUpgradeEnabled = document.getElementById('enable-auto-upgrade').checked;
        const benefitTitleEnabled = document.getElementById('benefit-custom-title').checked;
        const benefitRepliesEnabled = document.getElementById('benefit-specific-replies').checked;

        // 3. 組合新配置
        const newConfig = {
            ...tierConfig,
            tiers: updatedTiers,
            upgradeRules: {
                interactions: {
                    enabled: autoUpgradeEnabled,
                    rules: intRules
                },
                timeBased: {
                    enabled: autoUpgradeEnabled,
                    rules: timeRules
                },
                manual: { enabled: true }
            },
            benefits: {
                customTitle: { enabled: benefitTitleEnabled },
                tierSpecificReplies: { enabled: benefitRepliesEnabled },
                richMenu: { enabled: document.getElementById('benefit-rich-menu').checked }
            }
        };

        const result = await api.post('/tier/config', newConfig);

        if (result && result.success) {
            toast.success('等級配置已更新');
            tierConfig = newConfig;
            renderTierRules(); // 重新渲染規則表格
            renderTierStats(); // 名稱可能變更，重新渲染統計
        } else {
            console.error("❌ 儲存失敗理由:", result);
            toast.error('更新失敗[V5_UI]：' + (result?.error || result?.message || '伺服器回應格式錯誤'));
        }

    } catch (error) {
        console.error("❌ 儲存過程發生異常:", error);
        toast.error('儲存失敗：' + (error.message || '網路或伺服器錯誤'));
    } finally {
        LoadingManager.hide('save-tier');
    }
}

// 輔助函式 (需與後端一致)
function getTierIcon(tier) {
    const icons = ["🌱", "⭐", "💎", "👑"];
    return icons[tier] || icons[0];
}

function getTierColor(tier) {
    const colors = ["#4caf50", "#2196f3", "#ff9800", "#f44336"];
    return colors[tier] || colors[0];
}

// 導出初始化函式
window.pageInit = pageInit;
