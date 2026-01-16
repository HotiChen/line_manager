/**
 * Dashboard Page
 * 入口頁面 - 顯示統計資訊和快速連結
 */

import { getUserId, apiBase } from "../helper/state.js";
import { toast } from "../helper/toast.js";

export async function pageInit(pageData) {

    const userId = getUserId();

    // 更新歡迎訊息
    updateWelcomeMessage(pageData);

    // 載入統計數據
    await loadStatistics(userId);

    // 綁定快速連結
    bindQuickLinks();
}

/**
 * 更新歡迎訊息
 */
function updateWelcomeMessage(pageData) {
    const welcomeMsg = document.getElementById('welcome-message');
    if (!welcomeMsg) return;

    const currentHour = new Date().getHours();
    let greeting = '早安';

    if (currentHour >= 12 && currentHour < 18) {
        greeting = '午安';
    } else if (currentHour >= 18) {
        greeting = '晚安';
    }

    const projectSelect = document.getElementById('project-select-global');
    const currentProject = projectSelect?.value || '專案';

    welcomeMsg.textContent = `${greeting}！當前專案：${currentProject}`;
}

/**
 * 載入統計數據
 */
async function loadStatistics(userId) {
    try {
        // 並行載入所有統計數據
        const [richmenuData, flexData, imagemapData, keywordData] = await Promise.all([
            fetchCount('/richmenu/list', 'richmenus', userId),
            fetchCount('/flex/list', 'flexs', userId),
            fetchCount('/imagemap/list', 'imagemaps', userId),
            fetchCount('/keyword/list', 'data', userId)
        ]);

        // 更新統計卡片
        updateStatCard('stat-richmenu', richmenuData);
        updateStatCard('stat-flex', flexData);
        updateStatCard('stat-imagemap', imagemapData);
        updateStatCard('stat-keyword', keywordData);

            richmenu: richmenuData,
            flex: flexData,
            imagemap: imagemapData,
            keyword: keywordData
        });

    } catch (error) {
        console.error('[dashboard] 載入統計數據失敗:', error);
        toast.error('載入統計數據失敗');
    }
}

/**
 * 獲取特定類型的數量
 */
async function fetchCount(endpoint, dataKey, userId) {
    try {
        const response = await fetch(`${apiBase}${endpoint}`, {
            headers: { 'X-User-Id': userId }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const items = data[dataKey] || [];

        return Array.isArray(items) ? items.length : 0;

    } catch (error) {
        console.error(`[dashboard] 載入 ${endpoint} 失敗:`, error);
        return 0;
    }
}

/**
 * 更新統計卡片
 */
function updateStatCard(elementId, count) {
    const element = document.getElementById(elementId);
    if (!element) return;

    // 添加動畫效果
    element.style.opacity = '0';

    setTimeout(() => {
        element.textContent = count;
        element.style.opacity = '1';
        element.style.transition = 'opacity 0.3s';
    }, 100);
}

/**
 * 綁定快速連結
 */
function bindQuickLinks() {
    document.querySelectorAll('[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageName = link.dataset.page;

            if (pageName && typeof window.loadPage === 'function') {
                window.loadPage(pageName, { userId: getUserId() });
            }
        });
    });
}
