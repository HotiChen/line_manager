import { setInnerHTML } from "../helper/security.js";
import { apiBase, getUserId, setUserId } from "../helper/state.js";

let projectData = {}; // 用於存儲專案名稱和 Token 的對應

export async function pageInit(pageData) {
  // 如果有傳入 userId，更新 state
  if (pageData && pageData.userId) {
    setUserId(pageData.userId);
  }

  const currentUserId = getUserId();

  // 1. 載入使用者個人資料 (Profile)
  await loadUserProfile();

  // 2. 載入專案列表 (Access Tokens & Bots)
  // 若 DOM 尚未準備好，延後執行
  if (!document.getElementById("project-select")) {
    console.warn("[profile.js] ⏳ DOM 未就緒，延後載入專案列表");
    requestAnimationFrame(loadProfile);
  } else {
    await loadProfile();
    bindEvents(); // 綁定按鈕事件
  }
}

function bindEvents() {
  const addBtn = document.getElementById("add-project");
  const editBtn = document.getElementById("edit-project");
  const deleteBtn = document.getElementById("delete-project");
  const saveBtn = document.getElementById("save-profile");
  const submitEditBtn = document.getElementById("submit-edit-project");
  const submitAddBtn = document.getElementById("submit-add-project");

  if (!addBtn || !editBtn || !deleteBtn || !saveBtn) {
    console.warn("[profile.js] ⚠️ 部分按鈕未找到，跳過事件綁定");
    return;
  }

  // 儲存個人資料
  saveBtn.addEventListener("click", registerProfile);

  // 開啟新增視窗
  addBtn.addEventListener("click", () => {
    new bootstrap.Modal(document.getElementById("add-modal")).show();
  });

  // 開啟編輯視窗
  editBtn.addEventListener("click", () => {
    const selectedProject = document.getElementById("project-select")?.value;
    if (!selectedProject || selectedProject === "請選擇專案") {
      showStatusMessage("請先選擇一個專案", true);
      return;
    }
    document.getElementById("edit-project-name").value = selectedProject;
    document.getElementById("edit-project-token").value = projectData[selectedProject] || "";
    new bootstrap.Modal(document.getElementById("edit-modal")).show();
  });

  // 刪除專案
  deleteBtn.addEventListener("click", deleteProject);

  // 提交編輯
  submitEditBtn.addEventListener("click", submitEditProject);

  // 提交新增
  submitAddBtn.addEventListener("click", submitAddProject);
}

/**
 * 載入使用者個人資料
 */
async function loadUserProfile() {
  const userId = getUserId();
  try {
    const res = await fetch(`${apiBase}/profile/check`, {
      headers: { "X-User-Id": userId }
    });
    const data = await res.json();

    if (data.exists && data.profile) {
      document.getElementById("user-name").value = data.profile.userName || "";
      document.getElementById("user-email").value = data.profile.userEmail || "";
      document.getElementById("line-id").value = data.profile.lineDisplayName || "";
    }
  } catch (err) {
    console.error("[profile.js] ❌ 載入 Profile 失敗:", err);
  }
}

/**
 * 載入專案列表 (包含 Access Tokens 和 Team Bots)
 */
async function loadProfile() {
  const userId = getUserId();
  try {
    const res = await fetch(`${apiBase}/token/list`, {
      headers: { "X-User-Id": userId }
    });
    projectData = await res.json();

    const projectSelect = document.getElementById("project-select");
    if (projectSelect) {
      setInnerHTML(projectSelect, "<option selected disabled>請選擇專案</option>");

      Object.entries(projectData).forEach(([project, token]) => {
        const option = document.createElement("option");
        option.value = project;
        option.textContent = project;
        projectSelect.appendChild(option);
      });

      // 綁定選擇變更事件
      projectSelect.onchange = () => {
        const hasSelection = projectSelect.value && projectSelect.value !== "請選擇專案";
        document.getElementById("edit-project").disabled = !hasSelection;
        document.getElementById("delete-project").disabled = !hasSelection;
      };
    }
  } catch (err) {
    console.error("[profile.js] ❌ 載入專案列表失敗:", err);
  }
}

/**
 * 註冊/更新個人資料
 */
async function registerProfile() {
  const userId = getUserId();
  const body = {
    userName: document.getElementById("user-name").value.trim(),
    userEmail: document.getElementById("user-email").value.trim(),
    lineDisplayName: document.getElementById("line-id").value.trim()
  };

  try {
    const res = await fetch(`${apiBase}/profile/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": userId },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      showStatusMessage("✅ 個人資料已儲存！");
    } else {
      const result = await res.json();
      showStatusMessage("❌ 儲存失敗：" + (result.error || "未知錯誤"), true);
    }
  } catch (err) {
    showStatusMessage("❌ 系統錯誤", true);
  }
}

async function deleteProject() {
  const project = document.getElementById("project-select")?.value;
  if (!confirm(`確定要刪除專案 "${project}"?`)) return;

  try {
    const res = await fetch(`${apiBase}/token/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
      body: JSON.stringify({ project })
    });

    if (res.ok) {
      showStatusMessage("✅ 刪除成功");
      await loadProfile();
    } else {
      showStatusMessage("❌ 刪除失敗", true);
    }
  } catch (err) {
    showStatusMessage("❌ 系統錯誤", true);
  }
}

async function submitEditProject() {
  const name = document.getElementById("edit-project-name").value;
  const token = document.getElementById("edit-project-token").value.trim();
  await saveProject(name, token, "edit-modal");
}

async function submitAddProject() {
  const name = document.getElementById("add-project-name").value.trim();
  const token = document.getElementById("add-project-token").value.trim();
  await saveProject(name, token, "add-modal");
}

async function saveProject(name, token, modalId) {
  try {
    const res = await fetch(`${apiBase}/token/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
      body: JSON.stringify({ project: name, token })
    });

    if (res.ok) {
      showStatusMessage(`✅ 專案 ${name} 已儲存`);
      projectData[name] = token;
      await loadProfile();
    } else {
      const result = await res.json();
      showStatusMessage("❌ 儲存失敗：" + result.error, true);
    }
  } catch (err) {
    showStatusMessage("❌ 系統錯誤", true);
  }

  const modalEl = document.getElementById(modalId);
  if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();
}

function showStatusMessage(msg, isError = false) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.className = isError ? "fw-bold text-danger" : "fw-bold text-success";
    setTimeout(() => el.textContent = "", 3000);
  }
}