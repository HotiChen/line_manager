// js/tag.js

import { apiBase, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { setInnerHTML } from "../helper/security.js";

// let userId = null; // Module-level userId removed

/**
 * 從 API 獲取指定使用者的標籤列表。
 * 這個函式被匯出以供其他模組重複使用。
 * @param {string} passedUserId The user's ID.
 * @returns {Promise<string[]>} 一個解析為標籤字串陣列的 Promise。
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
    return [];
  }
}


// --- 以下是 tag.html 頁面專用的程式碼 ---

let tags = [];

// 供 tag.html 頁面初始化使用
async function loadTags() {
  tags = await getTagList(getUserId()); // Pass module-level userId
  renderTags();
}

// 將標籤列表渲染到表格中
function renderTags() {
  const tagList = document.getElementById("tag-list");
  if (!tagList) return; // 如果不在 tag.html 頁面，則不執行

  setInnerHTML(tagList, "");
  tags.forEach((tag, index) => {
    const row = document.createElement("tr");
    setInnerHTML(row, `
      <td><input type="checkbox" class="tag-checkbox" data-index="${index}" /></td>
      <td>${tag}</td>
      <td>0</td>
    `);
    tagList.appendChild(row);
  });
}

// 新增標籤
async function addNewTag() {
  const tagInput = document.getElementById("tag-input");
  const name = tagInput.value.trim();
  if (!name || tags.includes(name)) return;

  try {
    const result = await api.post('/tag/save', { name });
    if (result.success) {
      tagInput.value = "";
      await loadTags();
    }
  } catch (err) {
    console.error("❌ 新增 tag 失敗", err);
  }
}

// 刪除選定的標籤
async function deleteSelectedTags() {
  const checkboxes = document.querySelectorAll(".tag-checkbox:checked");
  const names = Array.from(checkboxes).map(cb => tags[parseInt(cb.dataset.index)]);
  if (!names.length) return;

  try {
    const result = await api.post('/tag/delete', { names });
    if (result.success) {
      await loadTags();
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
