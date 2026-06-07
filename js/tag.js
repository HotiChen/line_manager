// js/tag.js

import { apiBase, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { setInnerHTML } from "../helper/security.js";
import { toast } from "../helper/toast.js";

// let userId = null; // Module-level userId removed

/**
 * 從 API 獲取指定使用者的標籤列表。
 * 這個函式被匯出以供其他模組重複使用。
 * @param {string} passedUserId The user's ID.
 * @returns {Promise<Object[]>} 一個解析為標籤物件陣列的 Promise (每個物件包含 name, total, stats)。
 */
export async function getTagList(passedUserId) {
  const idToUse = passedUserId || getUserId();
  if (!idToUse) {
    console.error("❌ getTagList: userId is missing.");
    return [];
  }

  try {
    const data = await api.get('/tag/list');
    if (data.success && Array.isArray(data.data)) {
      return data.data;
    }
    return [];
  } catch (err) {
    console.error("❌ 無法載入 tags", err);
    toast.error('無法載入標籤列表');
    return [];
  }
}


// --- 以下是 tag.html 頁面專用的程式碼 ---

let tags = [];

// 供 tag.html 頁面初始化使用
/**
 * 載入所有標籤到 tags 陣列並渲染
 * 
 * Pre-conditions:
 * - 需透過 getUserId 取得有效使用戶 ID
 * 
 * Post-conditions:
 * - 取得 tags 並調用 renderTags 更新前端清單
 */
async function loadTags() {
  tags = await getTagList(getUserId()); // Pass module-level userId
  renderTags();
}

// 將標籤列表渲染到表格中
function renderTags() {
  const tagList = document.getElementById("tag-list");
  if (!tagList) return; // 如果不在 tag.html 頁面，則不執行

  tagList.innerHTML = ""; // safe: clear before building rows via insertRow/insertCell
  tags.forEach((tag, index) => {
    const row = tagList.insertRow();

    // Checkbox 欄位
    const cellCheckbox = row.insertCell();
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tag-checkbox";
    checkbox.dataset.index = index;
    cellCheckbox.appendChild(checkbox);

    // 標籤名稱 欄位
    const cellName = row.insertCell();
    cellName.textContent = tag.name;

    // 關聯數量 欄位
    const cellCount = row.insertCell();
    cellCount.textContent = tag.total || 0;
  });
}

// 新增標籤
async function addNewTag() {
  const tagInput = document.getElementById("tag-input");
  const name = tagInput.value.trim();
  if (!name || tags.some(t => t.name === name)) return;

  try {
    const result = await api.post('/tag/save', { name });
    if (result.success) {
      toast.success('新增標籤成功');
      tagInput.value = "";
      await loadTags();
    } else {
      toast.error('新增失敗');
    }
  } catch (err) {
    console.error("❌ 新增 tag 失敗", err);
  }
}

// 刪除選定的標籤
/**
 * 刪除透過 Checkbox 勾選的標籤
 * 
 * Pre-conditions:
 * - 畫面上至少勾選一個標籤 `.tag-checkbox:checked`
 * 
 * Post-conditions:
 * - 呼叫 API 進行批次刪除，並重新載入列表
 */
async function deleteSelectedTags() {
  const checkboxes = document.querySelectorAll(".tag-checkbox:checked");
  const names = Array.from(checkboxes).map(cb => tags[parseInt(cb.dataset.index)].name);
  if (!names.length) return;

  try {
    const result = await api.post('/tag/delete', { names });
    if (result.success) {
      toast.success('刪除標籤成功');
      await loadTags();
    } else {
      toast.error('刪除標籤失敗');
    }
  } catch (err) {
    console.error("❌ 批次刪除 tags 失敗", err);
  }
}

// tag.html 頁面的主進入點
export async function pageInit(pageData) {
  setUserId(pageData.userId);

  const addTagBtn = document.getElementById("add-tag-btn");
  const deleteSelectedBtn = document.getElementById("delete-selected-tags");
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  const tagInput = document.getElementById("tag-input");

  // 確保這些元素只在 tag.html 頁面執行
  if (addTagBtn) {
    addTagBtn.addEventListener("click", addNewTag);
  }
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", async () => {
      await deleteSelectedTags();
      if (selectAllCheckbox) selectAllCheckbox.checked = false;
    });
  }
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener("change", () => {
      const allCheckboxes = document.querySelectorAll(".tag-checkbox");
      allCheckboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
      });
    });
  }

  await loadTags();
}
