// js/tier_settings.js
import { getUserId, setUserId } from "../helper/state.js";
import api from '../helper/api.client.js';
import { toast } from '../helper/toast.js';
import { LoadingManager } from './shared/loader.js';

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
 */
async function loadTierConfig() {
    try {
        const result = await api.get('/tier/config');
        if (result.success) {
            tierConfig = result.config;
            console.log("✅ 載入等級配置:", tierConfig);
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
            console.log("✅ 載入等級統計:", tierStats);
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
            console.log("✅ 載入 Rich Menu 列表:", richMenuList);
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
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">目前沒有等級規則。請點擊「重設為預設值」或「儲存變更」來初始化。</td></tr>`;
        return;
    }

    tbody.innerHTML = tierConfig.tiers.map((tier, index) => {
        // 取得對應的規則，增加防呆
        const intRules = tierConfig.upgradeRules?.interactions?.rules || [];
        const timeRules = tierConfig.upgradeRules?.timeBased?.rules || [];

        const intRule = intRules.find(r => r.tier === tier.id) || { interactions: 0 };
        const timeRule = timeRules.find(r => r.tier === tier.id) || { days: 0 };

        return `
            <tr class="tier-row" data-tier-id="${tier.id}">
                <td>
                    <div class="d-flex align-items-center">
                        <span class="fs-4 me-2">${tier.icon || '🌱'}</span>
                        <span class="fw-bold">等級 ${tier.id}</span>
                    </div>
                </td>
                <td>
                    <input type="text" class="form-control tier-name-input" value="${tier.name || ''}">
                </td>
                <td>
                    <input type="text" class="form-control tier-title-input" value="${tier.title || ''}">
                </td>
                <td>
                    <div class="input-group">
                        <input type="number" class="form-control tier-int-input" value="${intRule.interactions || 0}" ${tier.id === 0 ? 'disabled' : ''}>
                        <span class="input-group-text">次</span>
                    </div>
                </td>
                <td>
                    <div class="input-group">
                        <input type="number" class="form-control tier-days-input" value="${timeRule.days || 0}" ${tier.id === 0 ? 'disabled' : ''}>
                        <span class="input-group-text">天</span>
                    </div>
                </td>
                <td>
                    <select class="form-select tier-richmenu-select">
                        <option value="">-- 不變動 / 預設 --</option>
                        ${richMenuList.map(menu => `
                            <option value="${menu.richMenuId}" ${tier.richMenuId === menu.richMenuId ? 'selected' : ''}>
                                ${menu.name} ${menu.richMenuAliasId ? `(${menu.richMenuAliasId})` : ''}
                            </option>
                        `).join('')}
                    </select>
                </td>
            </tr>
        `;
    }).join('');

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

    container.innerHTML = tiers.map(t => `
        <div class="col-md-3">
            <div class="card tier-card tier-${t.id} shadow-sm border-0">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <span class="fs-4">${t.icon}</span>
                        <span class="badge rounded-pill bg-light text-dark">${t.name}</span>
                    </div>
                    <h3 class="mb-0 fw-bold">${tierStats.tiers[t.id] || 0}</h3>
                    <p class="text-muted small mb-0">總計會員數</p>
                </div>
            </div>
        </div>
    `).join('');
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

        console.log("📤 正在儲存等級配置...", newConfig);
        const result = await api.post('/tier/config', newConfig);
        console.log("📥 儲存回應:", result);

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
