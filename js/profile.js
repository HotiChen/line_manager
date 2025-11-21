let projectData = {}; // To store project names and tokens
// let userId = null; // Module-level userId removed
import { setInnerHTML } from "../helper/security.js";
import { apiBase, getUserId, setUserId } from "../helper/state.js";

export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();
  if (window.debug) console.log(`[profile.js] ✅ pageInit 被執行，傳入的 userId: ${userId}`);

  await loadUserProfile(); // 載入現有使用者資料

  // ⏳ 若 DOM 尚未準備好，延後執行 loadProfile
  if (!document.getElementById("project-select")) {
    console.warn("[profile.js] ❌ 專案選單尚未載入，延後執行 loadProfile()");
    requestAnimationFrame(() => {
      loadProfile();
    });
    return;
  }

  const addBtn = document.getElementById("add-project");
  const editBtn = document.getElementById("edit-project");
  const deleteBtn = document.getElementById("delete-project");
  const saveBtn = document.getElementById("save-profile");
  const submitEditBtn = document.getElementById("submit-edit-project");
  const submitAddBtn = document.getElementById("submit-add-project");

  if (!addBtn || !editBtn || !deleteBtn || !saveBtn || !submitEditBtn || !submitAddBtn) {
    console.warn("[profile.js] ❗ 找不到按鈕元素，請確認 DOM 是否正確載入");
  } else {
    console.log("[profile.js] ✅ 成功綁定按鈕");

    saveBtn.addEventListener("click", registerProfile);

    addBtn.addEventListener("click", () => {
      console.log("[profile.js] 🔘 點擊：新增按鈕");
      const modal = new bootstrap.Modal(document.getElementById("add-modal"));
      modal.show();
    });

    editBtn.addEventListener("click", () => {
      console.log("[profile.js] 🔘 點擊：編輯按鈕");
      const selectedProject = document.getElementById("project-select")?.value;
      if (!selectedProject || selectedProject === "請選擇專案") {
        showStatusMessage("請先從下拉選單中選擇一個專案", true);
        return;
      }

      const projectToken = projectData[selectedProject];

      document.getElementById("edit-project-name").value = selectedProject;
      document.getElementById("edit-project-token").value = projectToken;

      const modal = new bootstrap.Modal(document.getElementById("edit-modal"));
      modal.show();
    });

    deleteBtn.addEventListener("click", async () => {
      console.log("[profile.js] 🔘 點擊：刪除按鈕");
      const project = document.getElementById("project-select")?.value;
      if (!project || project === "請選擇專案" || !confirm(`確定要刪除專案 \"${project}\"?`)) return;

      try {
        const res = await fetch(`${apiBase}/token/delete`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": userId
          },
          body: JSON.stringify({ project })
        });

        const result = await res.json();
        if (res.ok) {
          showStatusMessage("✅ 刪除成功！");
          if (window.debug) console.log("[deleteProject] 刪除成功:", result);
          await loadProfile(); // 重新載入列表
        } else {
          showStatusMessage("❌ 刪除失敗：" + (result.error || "未知錯誤"), true);
        }
      } catch (err) {
        console.error("[deleteProject] 發生錯誤:", err);
        showStatusMessage("❌ 刪除失敗，請檢查控制台", true);
      }
    });

    submitEditBtn.addEventListener("click", async () => {
      const name = document.getElementById("edit-project-name").value;
      const token = document.getElementById("edit-project-token").value.trim();

      try {
        const res = await fetch(`${apiBase}/token/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": userId
          },
          body: JSON.stringify({ project: name, token })
        });

        const result = await res.json();
        if (res.ok) {
          showStatusMessage("✅ 專案已更新！");
          // Update the local data
          projectData[name] = token;
        } else {
          showStatusMessage("❌ 更新失敗：" + (result.error || "未知錯誤"), true);
        }
      } catch (err) {
        console.error("[submit-edit-project] 發生錯誤:", err);
        showStatusMessage("❌ 發生錯誤，請檢查控制台", true);
      }

      const modal = bootstrap.Modal.getInstance(document.getElementById("edit-modal"));
      modal.hide();
    });

    submitAddBtn.addEventListener("click", async () => {
      const name = document.getElementById("add-project-name").value.trim();
      const token = document.getElementById("add-project-token").value.trim();
      const lineId = document.getElementById("add-project-id").value.trim();

      console.log("[profile.js] 📝 新增專案內容：", { name, token, lineId });

      try {
        const res = await fetch(`${apiBase}/token/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": userId
          },
          body: JSON.stringify({ project: name, token })
        });

        const result = await res.json();
        if (res.ok) {
          showStatusMessage(`✅ 已註冊：${name}`);
          if (window.debug) console.log("[submit-add-project] 註冊成功", result);
          await loadProfile(); // 重新載入專案清單
        } else {
          showStatusMessage("❌ 註冊失敗：" + (result.error || "未知錯誤"), true);
        }
      } catch (err) {
        console.error("[submit-add-project] 發生錯誤:", err);
        showStatusMessage("❌ 發生錯誤，請檢查控制台", true);
      }

      const modal = bootstrap.Modal.getInstance(document.getElementById("add-modal"));
      modal.hide();
    });
  }

  // 📌 載入現有使用者資訊
  await loadProfile();
}

async function loadUserProfile() {
  console.log("[profile] loading id:" + userId)
  try {
    const res = await fetch(`${apiBase}/profile/check`, {
      headers: { "X-User-Id": userId }
    });

    const data = await res.json();
    if (data.exists && data.profile) {
      if (window.debug) console.log("[profile.js] ✅ 已取得使用者資料", data.profile);

      document.getElementById("user-name").value = data.profile.userName || "";
      document.getElementById("user-email").value = data.profile.userEmail || "";
      document.getElementById("line-id").value = data.profile.lineDisplayName || "";
    }
  } catch (err) {
    console.error("[profile.js] ❌ 無法載入使用者資料:", err);
  }
}

async function loadProfile() {
  try {
    const res = await fetch(`${apiBase}/token/list`, {
      headers: { "X-User-Id": userId }
    });
    projectData = await res.json();

    if (window.debug) console.log("[loadProfile] 已載入 token list:", projectData);

    const projectSelect = document.getElementById("project-select");

    if (projectSelect) {
      setInnerHTML(projectSelect, "<option selected disabled>請選擇專案</option>");
      Object.entries(projectData).forEach(([project, token]) => {
        const option = document.createElement("option");
        option.value = project;
        option.textContent = project;
        projectSelect.appendChild(option);
      });

      projectSelect.addEventListener("change", () => {
        const selected = projectSelect.value;
        console.log("[profile.js] 使用者選擇專案：", selected);

        // Enable/disable buttons based on selection
        const editBtn = document.getElementById("edit-project");
        const deleteBtn = document.getElementById("delete-project");
        if (selected && selected !== "請選擇專案") {
          editBtn.disabled = false;
          deleteBtn.disabled = false;
        } else {
          editBtn.disabled = true;
          deleteBtn.disabled = true;
        }
      });
    }
  } catch (err) {
    console.error("[loadProfile] 發生錯誤:", err);
  }
}

async function registerProfile() {
  const userName = document.getElementById("user-name").value.trim();
  const userEmail = document.getElementById("user-email").value.trim();
  const lineDisplayName = document.getElementById("line-id").value.trim();

  const requestBody = { userName, userEmail, lineDisplayName };
  const requestHeaders = {
    "Content-Type": "application/json",
    "X-User-Id": userId
  };

  console.log("[registerProfile] 📤 即將發送至後端的資料:", {
    url: `${apiBase}/profile/register`,
    method: "POST",
    headers: requestHeaders,
    body: requestBody
  });

  try {
    const res = await fetch(`${apiBase}/profile/register`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });

    const result = await res.json();
    if (res.ok) {
      showStatusMessage("✅ 個人資料已儲存！");
      if (window.debug) console.log("[registerProfile] 成功：", result);
    } else {
      showStatusMessage("❌ 儲存失敗：" + (result.error || "未知錯誤"), true);
    }
  } catch (err) {
    console.error("[registerProfile] 發生錯誤：", err);
    showStatusMessage("❌ 發生錯誤，請查看控制台", true);
  }
}

function showStatusMessage(message, isError = false) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = isError ? "fw-bold text-danger" : "fw-bold text-success";

  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "fw-bold";
  }, 3000);
}