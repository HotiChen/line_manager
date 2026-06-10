import { setInnerHTML } from "../helper/security.js";
import { apiBase, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { showConfirm } from "../helper/modal.helper.js";

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
    // ApiClient already returns parsed JSON, no need for .json()
    const data = await api.post('/profile/check');

    if (data.exists && data.profile) {
      document.getElementById("user-name").value = data.profile.userName || data.profile.name || "";
      document.getElementById("user-email").value = data.profile.userEmail || data.profile.email || "";
      document.getElementById("line-id").value = data.profile.lineDisplayName || data.profile.lineName || "";
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
    // ApiClient already returns parsed JSON, no need for .json()
    projectData = await api.get('/token/list');

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

  // 添加確認對話框
  const confirmed = await showConfirm({
    title: '儲存個人資料',
    message: '確定要儲存個人資料嗎？',
    type: 'info',
    confirmText: '儲存',
    cancelText: '取消'
  });

  if (!confirmed) return;

  try {
    const result = await api.post('/profile/register', body);

    if (result.success || result.ok) {
      showStatusMessage("✅ 個人資料已儲存！");
    } else {
      showStatusMessage("❌ 儲存失敗：" + (result.error || "未知錯誤"), true);
    }
  } catch (err) {
    console.error('[registerProfile] 錯誤:', err);
    if (err instanceof Response) {
      try {
        const errorData = await err.json();
        showStatusMessage("❌ 儲存失敗：" + (errorData.error || err.statusText), true);
      } catch {
        showStatusMessage("❌ 儲存失敗：" + err.statusText, true);
      }
    } else {
      showStatusMessage("❌ 系統錯誤", true);
    }
  }
}

async function deleteProject() {
  const project = document.getElementById("project-select")?.value;
  const confirmed = await showConfirm({
    title: '刪除專案',
    message: `確定要刪除專案 "${project}"？`,
    type: 'danger',
    confirmText: '刪除',
    cancelText: '取消'
  });

  if (!confirmed) return;

  try {
    // DELETE 請求需要用 POST 方式傳送 body
    const result = await api.post('/token/delete', { project });

    if (result.success) {
      showStatusMessage("✅ 刪除成功");
      await loadProfile();
    } else {
      showStatusMessage("❌ 刪除失敗：" + (result.error || "未知錯誤"), true);
    }
  } catch (err) {
    console.error('[deleteProject] 錯誤:', err);
    if (err instanceof Response) {
      try {
        const errorData = await err.json();
        showStatusMessage("❌ 刪除失敗：" + (errorData.error || err.statusText), true);
      } catch {
        showStatusMessage("❌ 刪除失敗：" + err.statusText, true);
      }
    } else {
      showStatusMessage("❌ 系統錯誤", true);
    }
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
  if (!name || !token) {
    showStatusMessage("❌ 請填寫專案名稱和 Token", true);
    return;
  }

  try {
    // api.post 會直接返回解析後的 JSON，而非 Response 物件
    const result = await api.post('/token/register', { project: name, token });

    if (result.success || result.destination) {
      showStatusMessage(`✅ 專案 ${name} 已儲存`);
      projectData[name] = token;
      await loadProfile();

      // 關閉 Modal
      const modalEl = document.getElementById(modalId);
      if (modalEl) {
        const instance = bootstrap.Modal.getInstance(modalEl);
        if (instance) {
          instance.hide();
          setTimeout(() => {
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('overflow');
            document.body.style.removeProperty('padding-right');
          }, 300);
        }
      }
    } else {
      showStatusMessage("❌ 儲存失敗：" + (result.error || "未知錯誤"), true);
    }
  } catch (err) {
    console.error('[saveProject] 錯誤:', err);
    // err 可能是一個 Response 物件（從 api.client 拋出）
    if (err instanceof Response) {
      try {
        const errorData = await err.json();
        showStatusMessage("❌ 儲存失敗：" + (errorData.error || errorData.message || err.statusText), true);
      } catch {
        showStatusMessage("❌ 儲存失敗：" + err.statusText, true);
      }
    } else if (err.error) {
      showStatusMessage("❌ 儲存失敗：" + err.error, true);
    } else {
      showStatusMessage("❌ 系統錯誤", true);
    }
  }
}

function showStatusMessage(msg, isError = false) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.className = isError ? "fw-bold text-danger" : "fw-bold text-success";
    setTimeout(() => el.textContent = "", 3000);
  }
}