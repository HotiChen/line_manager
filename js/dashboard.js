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

    // 渲染圖表
    await renderDashboardCharts(userId);

    // ⚠️ 移除 bindQuickLinks() - main.js 已經全局綁定所有 [data-page] 連結
    // 避免重複綁定造成頁面載入兩次
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

    const botSelect = document.getElementById('bot-select-global');
    const currentBot = botSelect?.value || 'LINE@';

    welcomeMsg.textContent = `${greeting}！當前帳號：${currentBot}`;
}

/**
 * 載入統計數據
 */
async function loadStatistics(userId) {
    try {
        // 並行載入所有統計數據
        const [richmenuData, flexData, imagemapData, keywordData, memberData, messageData] = await Promise.all([
            fetchCount('/richmenu/list', 'richmenus', userId),
            fetchCount('/flex/list', 'flexs', userId),
            fetchCount('/imagemap/list', 'imagemaps', userId),
            fetchCount('/keyword/list', 'data', userId),
            fetchCount('/member/list', 'data', userId),
            fetchMessageCount(userId)
        ]);

        // 更新統計卡片
        updateStatCard('stat-richmenu', richmenuData);
        updateStatCard('stat-flex', flexData);
        updateStatCard('stat-imagemap', imagemapData);
        updateStatCard('stat-keyword', keywordData);
        updateStatCard('stat-member', memberData);
        updateStatCard('stat-message', messageData.total || 0);

        // 更新詳細訊息統計 (分類)
        if (messageData.total > 0) {
            const detailElem = document.getElementById('stat-message-detail');
            if (detailElem) {
                const paid = (messageData.push || 0) + (messageData.broadcast || 0);
                detailElem.innerHTML = `(回覆: ${messageData.reply || 0}, 計費: ${paid})`;
            }
        }

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
 * 獲取發送訊息總數
 */
async function fetchMessageCount(userId) {
    try {
        const response = await fetch(`${apiBase}/stats/messages`, {
            headers: { 'X-User-Id': userId }
        });

        if (!response.ok) return { total: 0, reply: 0, push: 0, broadcast: 0 };

        const data = await response.json();
        return data.stats || { total: 0, reply: 0, push: 0, broadcast: 0 };

    } catch (error) {
        console.error('[dashboard] 載入訊息統計失敗:', error);
        return { total: 0, reply: 0, push: 0, broadcast: 0 };
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
 * 渲染儀表板圖表
 */
async function renderDashboardCharts(userId) {
    try {
        // 1. 取得會員資料用於成長趨勢
        const memberRes = await fetch(`${apiBase}/member/list-full`, {
            headers: { 'X-User-Id': userId }
        });
        const members = (await memberRes.json()).data || [];

        // 2. 取得關鍵字資料用於熱度分析
        const keywordRes = await fetch(`${apiBase}/keyword/list`, {
            headers: { 'X-User-Id': userId }
        });
        const keywords = (await keywordRes.json()).data || [];

        // --- 會員成長趨勢 (近 7 日) ---
        renderMemberGrowthChart(members);

        // --- 關鍵字熱度 Top 5 ---
        await renderKeywordUsageChart(keywords, userId);

    } catch (error) {
        console.error('[dashboard] 渲染圖表失敗:', error);
    }
}

/**
 * 渲染會員成長趨勢圖
 */
function renderMemberGrowthChart(members) {
    const ctx = document.getElementById('member-growth-chart');
    if (!ctx) return;

    // 計算近 7 日日期
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
    }

    // 計算每日累積人數
    const counts = dates.map(date => {
        return members.filter(m => {
            if (!m.joinedAt) return false;
            return m.joinedAt.split('T')[0] <= date;
        }).length;
    });

    const dailyNew = dates.map((date, idx) => {
        const currentCount = members.filter(m => m.joinedAt && m.joinedAt.split('T')[0] === date).length;
        return currentCount;
    });

    // Check if Chart is loaded
    if (typeof Chart === 'undefined') {
        console.warn('[dashboard] Chart.js is not loaded. Skipping chart rendering.');
        return;
    }

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates.map(d => d.split('-').slice(1).join('/')),
            datasets: [{
                label: '總會員數',
                data: counts,
                borderColor: '#4361ee',
                backgroundColor: 'rgba(67, 97, 238, 0.1)',
                fill: true,
                tension: 0.4,
                yAxisID: 'y',
            }, {
                label: '每日新增',
                data: dailyNew,
                type: 'bar',
                backgroundColor: 'rgba(76, 201, 240, 0.6)',
                yAxisID: 'y1',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { position: 'top' }
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    beginAtZero: true,
                    title: { display: true, text: '總人數' }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    beginAtZero: true,
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: '新增人數' }
                }
            }
        }
    });
}

/**
 * 渲染關鍵字熱度圖
 */
async function renderKeywordUsageChart(keywords, userId) {
    const ctx = document.getElementById('keyword-usage-chart');
    if (!ctx) return;

    // 取得每個關鍵字的統計數據
    // 注意：這會產生多個 Request，未來建議後端提供一個批量統計 API
    const statsPromises = keywords.slice(0, 10).map(async k => {
        try {
            const res = await fetch(`${apiBase}/keyword/stats`, {
                method: 'POST',
                headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword: k.keyword })
            });
            const json = await res.json();
            return {
                keyword: k.keyword,
                total: json.stats?.total || 0
            };
        } catch {
            return { keyword: k.keyword, total: 0 };
        }
    });

    const stats = await Promise.all(statsPromises);
    const sortedStats = stats.sort((a, b) => b.total - a.total).slice(0, 5);

    // Check if Chart is loaded
    if (typeof Chart === 'undefined') return;

    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: sortedStats.map(s => s.keyword),
            datasets: [{
                data: sortedStats.map(s => s.total),
                backgroundColor: [
                    '#4361ee', '#3f37c9', '#4cc9f0', '#4895ef', '#560bad'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
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
