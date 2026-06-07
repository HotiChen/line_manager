import * as config from '../env/config.js?v=223';
import { initLiff } from "./liff.js";
import { setInnerHTML } from "../helper/security.js";
import { setupGlobalErrorHandlers, ErrorHandler } from "../helper/error.handler.js";
import { setUserId, getUserId, clearUserId, apiBase, debug } from "../helper/state.js";
import { toast } from "../helper/toast.js";
import { LoadingManager } from "./shared/loader.js";
import { api } from "../helper/api.client.js";

// 初始化全域錯誤捕獲
setupGlobalErrorHandlers();



let currentPageName = 'dashboard';

// BUG-002: AbortController 追蹤 bot selector 的 change listener，重新初始化時先取消舊的
let botSelectAbortController = null;

/**
 * loadPage
 * 動態載入頁面 HTML 與對應的 JS 模組
 * 
 * Pre-conditions:
 * - pageName: 頁面名稱 (對應 pages/[name].html 與 js/[name].js)
 * - pageData: 傳遞給 pageInit 的資料
 * 
 * Post-conditions:
 * - 更新 #main 內容，隱藏 Loading，並執行初始化。
 */
async function loadPage(pageName, pageData = {}) {
  currentPageName = pageName;
  const content = document.getElementById("main");
  if (!content) return;

  try {
    LoadingManager.show('page-load', `載入中...`);
    const res = await fetch(`./pages/${pageName}.html?cb=${Date.now()}`);
    if (!res.ok) throw new Error(`頁面載入失敗 (${res.status}): ${pageName}`);
    setInnerHTML(content, await res.text());

    const module = await import(`./${pageName}.js?cb=${Date.now()}`);
    if (typeof module.pageInit === "function") {
      await module.pageInit(pageData);
    }
  } catch (e) {
    ErrorHandler.handle(e, `載入頁面 ${pageName} 失敗`);
  } finally {
    LoadingManager.hide('page-load');
  }
}

window.loadPage = loadPage;

/**
 * initializeBotSelector
 * 初始化側邊欄的 LINE@ 專案選擇器
 */
async function initializeBotSelector(activeBot) {
  const botSelect = document.getElementById("bot-select-global");
  if (!botSelect) return;

  // 取消上次綁定的 change listener，避免重複觸發（BUG-002）
  if (botSelectAbortController) botSelectAbortController.abort();
  botSelectAbortController = new AbortController();

  try {
    const botData = await api.get('/token/list');
    // 使用 createElement + textContent 而非 innerHTML，避免 XSS
    botSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '選擇帳號...';
    botSelect.appendChild(defaultOpt);
    Object.keys(botData).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      botSelect.appendChild(opt);
    });

    let targetBot = activeBot;
    if (!targetBot || !botData[targetBot]) {
      targetBot = Object.keys(botData)[0] || '';
    }

    if (targetBot) {
      botSelect.value = targetBot;
      localStorage.setItem('flow_designer_bot', targetBot);
      if (targetBot !== activeBot) await api.post('/token/set', { project: targetBot });
    }

    botSelect.addEventListener("change", async (e) => {
      const newBot = e.target.value;
      if (!newBot) return;

      try {
        await api.post('/token/set', { project: newBot });
        localStorage.setItem('flow_designer_bot', newBot);
        toast.info(`切換至 ${newBot}...`);
        await loadPage(currentPageName, { userId: getUserId() });
        toast.success(`已切換至 ${newBot}`);
      } catch (err) {
        ErrorHandler.handle(err, '切換帳號失敗');
      }
    }, { signal: botSelectAbortController.signal });

  } catch (err) {
    console.error("❌ 載入專案列表失敗:", err);
  }
}

/**
 * updateUserInfo
 * 更新 Sidebar 顯示的使用者名稱與頭像
 */
async function updateUserInfo(userId, profileData = null) {
  const nameEl = document.getElementById('sidebar-user-name');
  const avatarEl = document.getElementById('user-avatar');
  if (!nameEl) return;

  const urlParams = new URLSearchParams(window.location.search);
  const displayName = profileData?.name || urlParams.get('displayName') || 'User';

  nameEl.textContent = displayName;
  if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
}

/**
 * initializeLogoutButton
 * 設置登出邏輯，支援 LIFF 與 本地模式
 */
function initializeLogoutButton() {
  const logoutBtn = document.getElementById('btn-logout');
  if (!logoutBtn) return;

  logoutBtn.addEventListener('click', async () => {
    const { showConfirm } = await import('../helper/modal.helper.js');
    if (!(await showConfirm({ title: '登出', message: '確定要登出嗎？', type: 'warning' }))) return;

    if (!debug && window.liff?.isLoggedIn()) window.liff.logout();
    clearUserId();
    window.location.reload();
  });
}


// 監聽 DOM 載入
window.addEventListener("DOMContentLoaded", () => {
  // 自動清理 Modal 背景 (Bootstrap 5 輔助)
  document.addEventListener('hidden.bs.modal', () => {
    if (!document.querySelector('.modal.show')) {
      document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
      document.body.classList.remove('modal-open');
      document.body.style.removeProperty('overflow');
    }
  });

  LoadingManager.show('app-init', '初始化中...');

  document.querySelectorAll(".nav-link[data-page]").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const page = e.currentTarget.dataset.page;
      if (page) loadPage(page, { userId: getUserId() });
    });
  });

  const startApp = async (userId, profileData) => {
    setUserId(userId);
    updateUserInfo(userId, profileData);
    initializeLogoutButton();

    await initializeBotSelector(profileData?.activeProject);
    await loadPage(currentPageName, { userId: getUserId() });
    LoadingManager.hide('app-init');
  };

  const handleNoProfile = (userId) => {
    LoadingManager.hide('app-init');
    toast.warning("請先填寫個人資料");
    setUserId(userId);
    loadPage("profile", { userId });
  };

  // Force local mode when running on localhost regardless of module-cached debug value
  const isLocalHostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!debug && !isLocalHostname) {
    initLiff(config.liffId).then(async profile => {
      if (!profile?.userId) throw new Error("LIFF 載入失敗");
      setUserId(profile.userId);
      const data = await api.post('/profile/check');
      data.exists ? startApp(profile.userId, data.profile) : handleNoProfile(profile.userId);
    }).catch(e => ErrorHandler.handle(e, 'LIFF 初始化失敗'));
  } else {
    const uid = getUserId() || config.testUserId || localStorage.getItem('dev_test_userId') || null;
    setUserId(uid);
    updateUserInfo(uid);
    api.post('/profile/check').then(data => {
      if (!data.exists) {
        initializeBotSelector().catch(console.error);
        initializeLogoutButton();
        if (!window.location.pathname.includes('invite.html')) handleNoProfile(uid);
      } else {
        startApp(uid, data.profile);
      }
    }).catch(err => {
      console.warn('⚠️ [Dev] /profile/check 失敗，以 dev 模式繼續啟動:', err?.message || err);
      LoadingManager.hide('app-init');
      initializeBotSelector().catch(console.error);
      initializeLogoutButton();
      loadPage(currentPageName, { userId: uid });
    });
  }
});