import * as config from '../env/config.js?v=223';
import { initLiff } from "./liff.js";
import { setInnerHTML } from "../helper/security.js";


import { setUserId, getUserId, apiBase, debug } from "../helper/state.js";
import { toast } from "../helper/toast.js";



// Keep track of the current page
let currentPageName = 'dashboard'; // Default page - 輕量的入口頁面


async function loadPage(pageName, pageData = {}) {
  currentPageName = pageName; // Update current page name

  const content = document.getElementById("main");
  const pagePath = `./pages/${pageName}.html`;
  const scriptPath = `./${pageName}.js`;

  try {

    // 顯示 loading 動畫
    setInnerHTML(content, "<div class='text-center my-5'><div class='spinner-border text-primary' role='status'></div></div>");

    // 載入頁面 HTML
    const res = await fetch(pagePath);
    setInnerHTML(content, await res.text());

    // 動態載入模組並執行 pageInit，傳入 pageData
    const module = await import(`${scriptPath}?cb=${Date.now()}`);

    if (typeof module.pageInit === "function") {
      module.pageInit(pageData); // Pass data to the page's init function
    }
  } catch (e) {
    console.error(`❌ 載入 ${pageName}.html 或 JS 失敗:`, e);
  }
}

window.loadPage = loadPage;

/**
 * Initializes the global project selector in the top bar.
 * Fetches project list, sets the active project, and handles selection changes.
 */
async function initializeGlobalProjectSelector(activeProject) {
  const projectSelect = document.getElementById("project-select-global");
  if (!projectSelect) return;

  try {
    // 1. Fetch project list
    const res = await fetch(`${apiBase}/token/list`, {
      headers: { "X-User-Id": getUserId() }
    });
    const projectData = await res.json();

    // 2. Populate dropdown
    projectSelect.innerHTML = ""; // Clear existing options
    Object.keys(projectData).forEach(project => {
      const option = document.createElement("option");
      option.value = project;
      option.textContent = project;
      projectSelect.appendChild(option);
    });

    // 3. Set active project
    if (activeProject && projectData[activeProject]) {
      projectSelect.value = activeProject;
    } else if (Object.keys(projectData).length > 0) {
      // If no active project, default to the first one
      projectSelect.value = Object.keys(projectData)[0];
      // Optionally, set this as the active project on the backend
      await fetch(`${apiBase}/token/set`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
        body: JSON.stringify({ project: projectSelect.value })
      });
    }

    // 4. Add event listener
    projectSelect.addEventListener("change", async (e) => {
      const newProject = e.target.value;
      try {
        await fetch(`${apiBase}/token/set`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
          body: JSON.stringify({ project: newProject })
        });
        // Reload the current page to reflect the new project context
        loadPage(currentPageName, { userId: getUserId() });
      } catch (err) {
        console.error("❌ 設定專案失敗:", err);
      }
    });

  } catch (err) {
    console.error("❌ 無法載入專案列表:", err);
  }
}

/**
 * 更新 Top Bar 的用戶資訊
 */
async function updateUserInfo(userId) {
  const nameEl = document.getElementById('current-user-name');
  const idEl = document.getElementById('current-user-id');

  if (!nameEl || !idEl) return;

  // 先顯示 ID
  idEl.textContent = userId;

  // 嘗試獲取用戶名稱（這裡先簡單處理，理想情況應該從 API 獲取 Profile）
  // 如果是測試用戶，嘗試從 URL 獲取名稱
  const urlParams = new URLSearchParams(window.location.search);
  const testDisplayName = urlParams.get('testDisplayName') || urlParams.get('displayName');

  if (testDisplayName) {
    nameEl.textContent = testDisplayName;
  } else if (userId === 'Ud66f9caf44c4d927ca4f9361d66ccc18') {
    nameEl.textContent = 'Owner';
  } else {
    nameEl.textContent = 'User';
    // TODO: Call API to get user profile
  }
}


window.addEventListener("DOMContentLoaded", () => {
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

    // Initialize the global selector and then load the initial page
    initializeGlobalProjectSelector(activeProject).then(() => {
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
          toast.warning("請先填寫個人資料");
          // Set userId in debug mode for consistency
          setUserId(testUserId);

          // 即使沒有 Profile，也嘗試初始化專案列表 (因為可能是被邀請加入的)
          initializeGlobalProjectSelector().catch(console.error);

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