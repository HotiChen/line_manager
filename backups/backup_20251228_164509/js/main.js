import * as config from '../env/config.js?v=223';
import { initLiff } from "./liff.js";
import { setInnerHTML } from "../helper/security.js";
import { setupGlobalErrorHandlers } from "../helper/error.handler.js";

import { setUserId, getUserId, apiBase, debug } from "../helper/state.js";
import { toast } from "../helper/toast.js";
import { LoadingManager } from "./shared/loader.js";

// 設置全局錯誤處理
setupGlobalErrorHandlers();



// Keep track of the current page
let currentPageName = 'dashboard'; // Default page - 輕量的入口頁面


async function loadPage(pageName, pageData = {}) {
  console.log(`📄 [loadPage] 被調用: ${pageName}`, pageData);
  console.trace('📍 調用來源:');

  currentPageName = pageName; // Update current page name

  const content = document.getElementById("main");
  const pagePath = `./pages/${pageName}.html`;
  const scriptPath = `./${pageName}.js`;

  try {

    // 顯示 loading 動畫
    LoadingManager.show('page-load', `載入 ${pageName}...`);

    // 載入頁面 HTML
    const res = await fetch(pagePath);
    setInnerHTML(content, await res.text());

    // 動態載入模組並執行 pageInit，傳入 pageData
    const module = await import(`${scriptPath}?cb=${Date.now()}`);

    if (typeof module.pageInit === "function") {
      await module.pageInit(pageData); // 等待 pageInit 完成（包括資料載入）
    }

    // 隱藏 loading
    LoadingManager.hide('page-load');
  } catch (e) {
    console.error(`❌ 載入 ${pageName}.html 或 JS 失敗:`, e);
    LoadingManager.hide('page-load');
  }
}

window.loadPage = loadPage;

/**
 * Initializes the Bot (LINE@) selector in the sidebar.
 * Fetches bot list, sets the active bot, and handles selection changes.
 */
async function initializeBotSelector(activeBot) {
  const botSelect = document.getElementById("bot-select-global");
  if (!botSelect) return;

  try {
    // 1. Fetch bot/project list
    const res = await fetch(`${apiBase}/token/list`, {
      headers: { "X-User-Id": getUserId() }
    });
    const botData = await res.json();

    // 2. Populate dropdown
    setInnerHTML(botSelect, '<option value="">選擇帳號...</option>');
    Object.keys(botData).forEach(botName => {
      const option = document.createElement("option");
      option.value = botName;
      option.textContent = botName;
      botSelect.appendChild(option);
    });

    // 3. Set active bot
    if (activeBot && botData[activeBot]) {
      botSelect.value = activeBot;
    } else if (Object.keys(botData).length > 0) {
      // If no active bot, default to the first one
      botSelect.value = Object.keys(botData)[0];
      // Set this as the active project on the backend
      await fetch(`${apiBase}/token/set`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
        body: JSON.stringify({ project: botSelect.value })
      });
    }

    // 4. Add event listener for bot change
    botSelect.addEventListener("change", async (e) => {
      const newBot = e.target.value;
      console.log('🔄 [Bot Switch] 偵測到切換:', newBot);
      if (!newBot) return;

      try {
        console.log('🔄 [Bot Switch] 同步到後端...');
        await fetch(`${apiBase}/token/set`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
          body: JSON.stringify({ project: newBot })
        });

        // Reload the current page to reflect the new bot context
        toast.info(`正在切換至 ${newBot}...`);
        console.log('🔄 [Bot Switch] 重新載入頁面:', currentPageName);
        await loadPage(currentPageName, { userId: getUserId() });
        toast.success(`已切換至 ${newBot}`);
        console.log('✅ [Bot Switch] 切換完成');
      } catch (err) {
        console.error("❌ 切換 LINE@ 失敗:", err);
        toast.error("切換失敗，請稍後再試");
      }
    });

    console.log('✅ [Bot Selector] 事件監聽器已註冊');

  } catch (err) {
    console.error("❌ 無法載入 LINE@ 列表:", err);
  }
}

/**
 * 更新 Sidebar 的用戶資訊
 */
async function updateUserInfo(userId, profileData = null) {
  const nameEl = document.getElementById('sidebar-user-name');
  const avatarEl = document.getElementById('user-avatar');

  if (!nameEl) return;

  // 嘗試獲取用戶名稱
  const urlParams = new URLSearchParams(window.location.search);
  const testDisplayName = urlParams.get('testDisplayName') || urlParams.get('displayName');

  let displayName = 'User';

  if (profileData?.name) {
    displayName = profileData.name;
  } else if (testDisplayName) {
    displayName = testDisplayName;
  } else if (userId === 'Ud66f9caf44c4d927ca4f9361d66ccc18') {
    displayName = 'Owner';
  }

  nameEl.textContent = displayName;

  // 設定 Avatar 文字 (取名稱第一個字)
  if (avatarEl) {
    avatarEl.textContent = displayName.charAt(0).toUpperCase();
  }
}

/**
 * 初始化登出按鈕
 */
function initializeLogoutButton() {
  const logoutBtn = document.getElementById('btn-logout');
  if (!logoutBtn) return;

  logoutBtn.addEventListener('click', async () => {
    if (!confirm('確定要登出嗎？')) return;

    try {
      // 如果使用 LIFF，呼叫 LIFF 登出
      if (!debug && window.liff && liff.isLoggedIn()) {
        liff.logout();
      }

      // 清除本地狀態
      setUserId(null);

      // 重新載入頁面
      window.location.reload();
    } catch (err) {
      console.error('登出失敗:', err);
      toast.error('登出失敗，請稍後再試');
    }
  });
}


window.addEventListener("DOMContentLoaded", () => {
  // 🔧 全局 Modal Backdrop 清理
  // 自動監聽所有 modal 的關閉事件
  document.addEventListener('hidden.bs.modal', function (event) {
    setTimeout(() => {
      // 只有在沒有其他 modal 打開時才清理
      if (!document.querySelector('.modal.show')) {
        document.querySelectorAll('.modal-backdrop').forEach(el => {
          console.log('[Global Modal Cleanup] Removing backdrop');
          el.remove();
        });
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
      }
    }, 100);
  });
  console.log('✅ Global modal backdrop cleanup initialized');

  // 立即顯示 loading（暗色毛玻璃效果）
  LoadingManager.show('app-init', '初始化應用程式...');

  // 綁定側邊選單事件
  document.querySelectorAll(".nav-link[data-page]").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault(); // 防止 # 造成頁面跳轉
      const pageName = e.currentTarget.dataset.page;
      if (pageName) {
        // Pass userId on every page navigation
        loadPage(pageName, { userId: getUserId() });
      }
    });
  });

  const startApp = (userId, profileData) => {
    setUserId(userId);
    const activeProject = profileData?.activeProject;

    const userIdDisplay = document.getElementById("user-id-display");
    if (userIdDisplay) {
      userIdDisplay.textContent = `User ID: ${userId}`;
    }

    // 更新 Top Bar 用戶資訊
    updateUserInfo(userId);

    // 隱藏初始化 loading
    LoadingManager.hide('app-init');

    // 初始化登出按鈕
    initializeLogoutButton();

    // Initialize the bot selector and then load the initial page
    initializeBotSelector(activeProject).then(() => {
      loadPage(currentPageName, { userId: getUserId() }); // Pass userId to the default page
    });
  };

  if (!debug) {
    initLiff(config.liffId).then(profile => {
      if (!profile || !profile.userId) {
        throw new Error("⚠️ LIFF 回傳 profile 為 undefined");
      }

      fetch(`${apiBase}/profile/check`, { headers: { "X-User-Id": profile.userId } })
        .then(res => res.json())
        .then(data => {
          if (!data.exists) {
            LoadingManager.hide('app-init');
            toast.warning("請先填寫個人資料");
            // Set userId here as well, because startApp is not called
            setUserId(profile.userId);
            // Explicitly pass userId to the profile page
            loadPage("profile", { userId: profile.userId });
          } else {
            startApp(profile.userId, data.profile);
          }
        });
    }).catch(err => {
      console.error("❌ LIFF 初始化失敗", err);
    });
  }
  else {
    // 優先使用 URL 參數中的 testUserId (由 getUserId 處理)
    const testUserId = getUserId() || config.testUserId;

    // 立即更新 Top Bar (使用 URL 參數或預設值)
    updateUserInfo(testUserId);

    fetch(`${apiBase}/profile/check`, { headers: { "X-User-Id": testUserId } })
      .then(res => res.json())
      .then(data => {
        if (!data.exists) {
          LoadingManager.hide('app-init');
          toast.warning("請先填寫個人資料");
          // Set userId in debug mode for consistency
          setUserId(testUserId);

          // 即使沒有 Profile，也嘗試初始化 Bot 選擇器 (因為可能是被邀請加入的)
          initializeBotSelector().catch(console.error);
          initializeLogoutButton();

          // Explicitly pass userId to the profile page
          // 如果當前頁面不是 invite，才跳轉 profile
          if (!window.location.pathname.includes('invite.html')) {
            loadPage("profile", { userId: testUserId });
          }
        } else {
          startApp(testUserId, data.profile);
        }
      });
  }
});