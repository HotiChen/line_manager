/**
 * Dashboard Page
 * 入口頁面 - 顯示統計資訊和快速連結
 */
import { getUserId } from "../helper/state.js";
import { toast } from "../helper/toast.js";
import { api } from "../helper/api.client.js";

/**
 * pageInit
 * 初始化儀表板頁面
 * 
 * Pre-conditions:
 * - pageData: 傳遞給頁面的初始化資料
 * - DOM 中必須存在對應的容器 (如 #welcome-message)
 * 
 * Post-conditions:
 * - 更新歡迎訊息
 * - 非同步載入統計數據與圖表並渲染
 */
export async function pageInit(pageData) {
    const userId = getUserId();
    if (!userId) {
        toast.warning('無法取得用戶識別碼，請重新登入');
        return;
    }

    updateWelcomeMessage();

    // 平行處理統計與圖表資料加載
    await Promise.all([
        loadStatistics(),
        renderDashboardCharts()
    ]);
}

/**
 * updateWelcomeMessage
 * 更新歡迎訊息與當前專案狀態
 * 
 * Post-conditions:
 * - 依據設備時間顯示 早安/午安/晚安
 * - 顯示當前選定的目標 LINE@ 專案名稱
 */
function updateWelcomeMessage() {
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
 * loadStatistics
 * 載入並更新所有的統計數據卡片
 * 
 * Post-conditions:
 * - 利用 api.parallel 統一取得並解決多個端點的 Request
 * - 成功取得後更新 UI 上的統計數量與明細
 */
async function loadStatistics() {
    try {
        const [richmenuRes, flexRes, imagemapRes, keywordRes, memberRes, messageRes] = await api.parallel([
            { method: 'GET', endpoint: '/richmenu/list' },
            { method: 'GET', endpoint: '/flex/list' },
            { method: 'GET', endpoint: '/imagemap/list' },
            { method: 'GET', endpoint: '/keyword/list' },
            { method: 'GET', endpoint: '/member/list' },
            { method: 'GET', endpoint: '/stats/messages' }
        ]);

        const getCount = (res, key) => (res.success && Array.isArray(res.data?.[key])) ? res.data[key].length : 0;

        updateStatCard('stat-richmenu', getCount(richmenuRes, 'richmenus'));
        updateStatCard('stat-flex', getCount(flexRes, 'flexs'));
        updateStatCard('stat-imagemap', getCount(imagemapRes, 'imagemaps'));
        updateStatCard('stat-keyword', getCount(keywordRes, 'data'));
        updateStatCard('stat-member', getCount(memberRes, 'data'));

        const msgData = messageRes.success ? messageRes.data.stats || {} : {};
        const msgTotal = msgData.total || 0;
        updateStatCard('stat-message', msgTotal);

        if (msgTotal > 0) {
            const detailElem = document.getElementById('stat-message-detail');
            if (detailElem) {
                const paid = (msgData.push || 0) + (msgData.broadcast || 0);
                detailElem.innerHTML = `(回覆: ${msgData.reply || 0}, 計費: ${paid})`;
            }
        }
    } catch (error) {
        console.error('[dashboard] 載入統計數據失敗:', error);
        toast.error('載入統計數據失敗');
    }
}

/**
 * updateStatCard
 * 動畫更新統計卡片數字
 * 
 * Pre-conditions:
 * - elementId 必須是存在於 DOM 中的節點 ID
 */
function updateStatCard(elementId, count) {
    const element = document.getElementById(elementId);
    if (!element) return;

    element.style.opacity = '0';
    setTimeout(() => {
        element.textContent = count;
        element.style.opacity = '1';
        element.style.transition = 'opacity 0.3s';
    }, 100);
}

/**
 * renderDashboardCharts
 * 獲取圖表所需的底層資料並觸發渲染函數
 */
async function renderDashboardCharts() {
    try {
        const [memberRes, keywordRes] = await api.parallel([
            { method: 'GET', endpoint: '/member/list-full' },
            { method: 'GET', endpoint: '/keyword/list' }
        ]);

        const members = memberRes.success ? memberRes.data.data : [];
        const keywords = keywordRes.success ? keywordRes.data.data : [];

        renderMemberGrowthChart(members || []);
        await renderKeywordUsageChart(keywords || []);
    } catch (error) {
        console.error('[dashboard] 渲染圖表失敗:', error);
    }
}

/**
 * renderMemberGrowthChart
 * 渲染會員成長趨勢圖
 */
function renderMemberGrowthChart(members) {
    const ctx = document.getElementById('member-growth-chart');
    if (!ctx || typeof Chart === 'undefined') return;

    // 計算近 7 日日期
    const dates = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return d.toISOString().split('T')[0];
    });

    // 計算每日累積人數與新增人數
    const counts = dates.map(date => members.filter(m => m.joinedAt?.split('T')[0] <= date).length);
    const dailyNew = dates.map(date => members.filter(m => m.joinedAt?.split('T')[0] === date).length);

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates.map(d => d.split('-').slice(1).join('/')),
            datasets: [
                {
                    label: '總會員數',
                    data: counts,
                    borderColor: '#4361ee',
                    backgroundColor: 'rgba(67, 97, 238, 0.1)',
                    fill: true,
                    tension: 0.4,
                    yAxisID: 'y',
                },
                {
                    label: '每日新增',
                    data: dailyNew,
                    type: 'bar',
                    backgroundColor: 'rgba(76, 201, 240, 0.6)',
                    yAxisID: 'y1',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { type: 'linear', display: true, position: 'left', beginAtZero: true, title: { display: true, text: '總人數' } },
                y1: { type: 'linear', display: true, position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: '新增人數' } }
            }
        }
    });
}

/**
 * renderKeywordUsageChart
 * 渲染關鍵字熱度圖 (Top 5)
 */
async function renderKeywordUsageChart(keywords) {
    const ctx = document.getElementById('keyword-usage-chart');
    if (!ctx || typeof Chart === 'undefined' || !keywords.length) return;

    // 取得前 10 個關鍵字進行統計查詢 (利用 api.parallel 一次打出多個 req)
    const topKeywords = keywords.slice(0, 10);
    const requests = topKeywords.map(k => ({
        method: 'POST',
        endpoint: '/keyword/stats',
        body: { keyword: k.keyword }
    }));

    const results = await api.parallel(requests);

    const stats = results.map((res, index) => ({
        keyword: topKeywords[index].keyword,
        total: res.success ? res.data?.stats?.total || 0 : 0
    }));

    const sortedStats = stats.sort((a, b) => b.total - a.total).slice(0, 5);

    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: sortedStats.map(s => s.keyword),
            datasets: [{
                data: sortedStats.map(s => s.total),
                backgroundColor: ['#4361ee', '#3f37c9', '#4cc9f0', '#4895ef', '#560bad']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } }
        }
    });
}
