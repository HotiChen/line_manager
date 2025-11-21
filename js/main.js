import * as config from '../env/config.js?v=223';
import { initLiff } from "./liff.js";
import { setInnerHTML } from "../helper/security.js";


import { setUserId, getUserId, apiBase, debug } from "../helper/state.js";

// window.apiBase and window.debug are deprecated but kept for compatibility if needed
// window.apiBase = apiBase;
// window.debug = debug;

// Keep track of the current page
let currentPageName = 'richmenu'; // Default page

async function loadPage(pageName, pageData = {}) {
  currentPageName = pageName; // Update current page name

  const content = document.getElementById("main");
  const pagePath = `./pages/${pageName}.html`;
  const scriptPath = `./${pageName}.js`;

  try {
    if (debug) console.log(`[main] 載入 ${pageName}，並傳入資料:`, pageData);

    // 顯示 loading 動畫
    setInnerHTML(content, "<div class='text-center my-5'><div class='spinner-border text-primary' role='status'></div></div>");

    // 載入頁面 HTML
    const res = await fetch(pagePath);
    setInnerHTML(content, await res.text());

    // 動態載入模組並執行 pageInit，傳入 pageData
    const module = await import(`${scriptPath}?cb=${Date.now()}`);

    if (typeof module.pageInit === "function") {
      module.pageInit(pageData); // Pass data to the page's init function
      console.log(`載入 ${pageName} 完成`);
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
      console.log("[main] 使用者 ID：", profile.userId);

      fetch(`${apiBase}/profile/check`, { headers: { "X-User-Id": profile.userId } })
        .then(res => res.json())
        .then(data => {
          if (!data.exists) {
            alert("⚠️ 請先填寫個人資料");
            // Set userId here as well, because startApp is not called
            setUserId(profile.userId);
            // Explicitly pass userId to the profile page
            loadPage("profile", { userId: profile.userId });
          } else {
            console.log("✅ 使用者已註冊 profile", data.profile);
            startApp(profile.userId, data.profile);
          }
        });
    }).catch(err => {
      console.error("❌ LIFF 初始化失敗", err);
    });
  }
  else {
    const testUserId = config.testUserId;
    fetch(`${apiBase}/profile/check`, { headers: { "X-User-Id": testUserId } })
      .then(res => res.json())
      .then(data => {
        if (!data.exists) {
          alert("⚠️ 請先填寫個人資料");
          // Set userId in debug mode for consistency
          setUserId(testUserId);
          // Explicitly pass userId to the profile page
          loadPage("profile", { userId: testUserId });
        } else {
          console.log("✅ 使用者已註冊 profile", data.profile);
          startApp(testUserId, data.profile);
        }
      });
  }
});