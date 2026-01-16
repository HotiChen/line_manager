import { apiBase, getUserId, setUserId } from "../helper/state.js";
import {
  detectBuilder,
  getSupportedMsgTypes,
  getSavedMessages,
  formatMessagePreview,
  messageTypeLabels,
  fetchMessageListByType,
  generateReplyInputUI,
  getCurrentReplyInput,
  generateMessagePreviewHTML,
  getMessageTypeIcon,
  searchMessages,
  clearMessageCache,
  refreshMessageType
} from "../helper/message.helper.js";
import { toast, withButtonLoading } from "../helper/toast.js";
import { setInnerHTML } from "../helper/security.js";

// let userId = null; // Module-level userId removed

class KeywordReply {
  constructor({ keyword = "", replies = [] }) {
    this.type = "keyword_reply";
    this.keyword = keyword;
    this.replies = replies; // replies 為 array，可以是 text, imagemap, uri 等
  }

  addReply(reply) {
    this.replies.push(reply);
    this.isUpdated = true;
  }

  removeReply(index) {
    if (index >= 0 && index < this.replies.length) {
      this.replies.splice(index, 1);
      this.isUpdated = true;
    }
  }

  toJSON() {
    return {
      type: this.type,
      keyword: this.keyword,
      replies: this.replies
    };
  }

  isValid() {
    return this.keyword && Array.isArray(this.replies) && this.replies.length > 0;
  }
}



// js/keyword_reply_builder.js
// 關鍵字回覆編輯器主程式
export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();
  // 新增：初始化全域選取回覆輸入
  window.currentReplyInput = null;

  // 初始化全域變數
  window.currentReplies = [];

  // 偵測 builder 類型
  const builder = "keywords";

  // 載入該 builder 可用的訊息類型
  const msgTypes = getSupportedMsgTypes(builder);

  // 初始化 UI 元素
  const replyFieldsContainer = document.getElementById("reply-dynamic-fields");
  const selectedReplyDisplay = document.getElementById("selected-reply-display");
  const keywordInput = document.getElementById("keyword-input");
  const submitBtn = document.getElementById("submit");
  const addReplyBtn = document.getElementById("add-reply-btn");

  // 綁定表單提交事件
  const addKeywordForm = document.getElementById("add-keyword-form");
  if (addKeywordForm) {
    addKeywordForm.addEventListener("submit", handleKeywordSubmit);
  } else {
    // Fallback if form not found (shouldn't happen based on HTML)
    submitBtn?.addEventListener("click", handleKeywordSubmit);
  }

  addReplyBtn?.addEventListener("click", handleAddReply);

  // 顯示訊息選擇欄位
  if (replyFieldsContainer) {
    try {
      const ui = await generateReplyInputUI({
        builder,
        userId: getUserId(),
        onSelect: (type, item) => {
          // 新增：更新全域選取狀態
          window.currentReplyInput = { type, item };
          latestSelectedReply = { type, ...item };
          updateSelectedReplyDisplay(selectedReplyDisplay, type, item);
        }
      });
      replyFieldsContainer.appendChild(ui);
    } catch (error) {
      console.error("❌ 生成回覆輸入 UI 失敗:", error);
      setInnerHTML(replyFieldsContainer, "<div class='alert alert-warning'>載入回覆選項失敗，請重新整理頁面</div>");
    }
  }

  // 載入已儲存的關鍵字回覆清單
  await renderReplyList(userId);

  // 綁定刷新統計按鈕事件
  const refreshStatsBtn = document.getElementById("refresh-stats-btn");
  if (refreshStatsBtn) {
    refreshStatsBtn.addEventListener("click", async () => {
      refreshStatsBtn.disabled = true;
      setInnerHTML(refreshStatsBtn, "🔄 刷新中...");

      try {
        await renderReplyList(userId);
        toast.success("✅ 統計數據已更新");
      } catch (error) {
        console.error("❌ 刷新統計失敗:", error);
        toast.error("❌ 刷新統計失敗");
      } finally {
        refreshStatsBtn.disabled = false;
        setInnerHTML(refreshStatsBtn, "🔄 刷新統計");
      }
    });
  }


  // ✅ 綁定全選 checkbox 行為
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  selectAllCheckbox?.addEventListener("change", () => {
    const checkboxes = document.querySelectorAll(".keyword-checkbox");
    checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);
  });

  // ✅ 綁定刪除選取項目按鈕事件
  const deleteSelectedBtn = document.getElementById("delete-selected-btn");
  deleteSelectedBtn?.addEventListener("click", async () => {
    const checkboxes = document.querySelectorAll(".keyword-checkbox:checked");
    if (checkboxes.length === 0) {
      toast.warning("請先選取要刪除的項目");
      return;
    }

    const count = checkboxes.length;
    const keywords = Array.from(checkboxes).map(cb => cb.dataset.keyword).join("、");
    const message = count === 1
      ? `確定要刪除關鍵字「${keywords}」嗎？`
      : `確定要刪除 ${count} 個關鍵字嗎？\n\n${keywords}`;

    if (!confirm(message)) return;

    await withButtonLoading(deleteSelectedBtn, async () => {
      const keywordsToDelete = Array.from(checkboxes).map(cb => cb.dataset.keyword);
      for (const keyword of keywordsToDelete) {
        try {
          const res = await fetch(`${apiBase}/keyword/delete`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-User-Id": userId
            },
            body: JSON.stringify({ keyword })
          });
        } catch (err) {
          console.error("❌ 刪除失敗", keyword, err);
          toast.error(`刪除失敗: ${keyword}`);
        }
      }

      await renderReplyList(userId);
    }, '刪除中...');
  });

  // ✅ 綁定搜尋功能
  const searchInput = document.getElementById("keyword-search");
  const clearSearchBtn = document.getElementById("clear-search");

  searchInput?.addEventListener("input", (e) => {
    filterKeywordList(e.target.value);
  });

  clearSearchBtn?.addEventListener("click", () => {
    if (searchInput) {
      searchInput.value = "";
      filterKeywordList("");
    }
  });


}

// 搜尋篩選功能
function filterKeywordList(searchTerm) {
  const rows = document.querySelectorAll("#reply-list tr");
  const term = searchTerm.toLowerCase().trim();
  let visibleCount = 0;

  if (!term) {
    // 如果搜尋欄位為空，顯示所有
    rows.forEach(row => {
      row.style.display = "";
      visibleCount++;
    });
  } else {
    rows.forEach(row => {
      const keywordBtn = row.querySelector("button");
      const keyword = keywordBtn?.textContent.toLowerCase() || "";
      const replyTypes = row.querySelector(".d-flex")?.textContent.toLowerCase() || "";

      if (keyword.includes(term) || replyTypes.includes(term)) {
        row.style.display = "";
        visibleCount++;
      } else {
        row.style.display = "none";
      }
    });
  }

  // 更新搜尋結果計數
  const resultCount = document.getElementById("search-result-count");
  if (resultCount) {
    if (term) {
      resultCount.textContent = `找到 ${visibleCount} 個符合的關鍵字`;
    } else {
      resultCount.textContent = "";
    }
  }
}

// 暫存使用者目前選擇的訊息
let latestSelectedReply = null;





// 更新選取回覆顯示
function updateSelectedReplyDisplay(displayElement, type, item) {
  if (!displayElement) return;
  const preview = generateMessagePreviewHTML(type, item);
  setInnerHTML(displayElement, `<div class="alert alert-success">✅ 已選擇：${preview}</div>`);
}

// 加入 addReply 處理邏輯
function handleAddReply() {
  if (!latestSelectedReply) {
    toast.warning("請先選擇一個回覆項目");
    return;
  }
  // Re-create the structure that the rest of the function expects
  const current = { type: latestSelectedReply.type, item: latestSelectedReply };

  if (!current || !current.type) {
    console.warn("❗ 無效的回覆輸入");
    return;
  }

  const reply = { type: current.type };



  if (current.type === "text" && current.item?.text) {
    reply.text = current.item.text;
  } else if (current.type === "flex" && current.item?.id) {
    reply.id = current.item.id;
    reply.title = current.item.title;
    reply.altText = current.item.title || 'Flex Message'; // Add altText for previews
  } else if (current.item) {
    Object.assign(reply, current.item);
  }

  window.currentReplies.push(reply);
  renderSelectedReplies();
}

// 顯示目前已選擇加入的回覆（綠色區塊）
function renderSelectedReplies() {
  const selectedReplyDisplay = document.getElementById("selected-reply-display");
  if (!selectedReplyDisplay) return;

  if (!window.currentReplies || window.currentReplies.length === 0) {
    setInnerHTML(selectedReplyDisplay, "");
    return;
  }

  const previews = window.currentReplies.map((reply, index) => `
    <div class="d-flex align-items-center gap-2 mb-2 p-2 border rounded">
      <div class="flex-grow-1">
        ${generateMessagePreviewHTML(reply.type, reply)}
      </div>
      <button 
        class="btn btn-sm btn-danger" 
        onclick="window.removeReply(${index})"
        type="button"
        title="移除此回覆">
        ✕
      </button>
    </div>
  `).join("");

  setInnerHTML(selectedReplyDisplay, `
    <div class="alert alert-success">
      <strong>✅ 已加入回覆 (${window.currentReplies.length})</strong>
      <div class="mt-2">${previews}</div>
    </div>
  `);
}

// 移除單個回覆
function removeReply(index) {
  if (index >= 0 && index < window.currentReplies.length) {
    const removed = window.currentReplies.splice(index, 1)[0];
    renderSelectedReplies();
    toast.info(`已移除回覆：${removed.type}`);
  }
}

// 將函數暴露到 window 以便從 HTML 呼叫
window.removeReply = removeReply;


async function createKeywordRow(item, index, onDelete) {
  const tr = document.createElement("tr");
  // 新增 checkbox 欄位
  const tdCheckbox = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "keyword-checkbox";
  checkbox.dataset.keyword = item.keyword;
  tdCheckbox.appendChild(checkbox);
  tr.appendChild(tdCheckbox);
  // 關鍵字欄位
  const tdKeyword = document.createElement("td");
  const keywordBtn = document.createElement("button");
  keywordBtn.className = "btn btn-outline-primary btn-sm";
  keywordBtn.textContent = item.keyword;
  keywordBtn.addEventListener("click", () => {
    editKeyword(item, index);
  });
  tdKeyword.appendChild(keywordBtn);

  // 回覆類型欄位
  const tdTypes = document.createElement("td");
  const replySummary = document.createElement("div");
  replySummary.className = "d-flex flex-wrap gap-1";

  item.replies.forEach((reply, replyIndex) => {
    const badge = document.createElement("span");
    badge.className = "badge bg-secondary me-1";
    setInnerHTML(badge, `${getMessageTypeIcon(reply.type)} ${formatMessagePreview(reply.type, reply)}`);
    replySummary.appendChild(badge);
  });

  tdTypes.appendChild(replySummary);

  // 統計數據欄位
  const tdTotal = document.createElement("td");
  const tdThisMonth = document.createElement("td");
  const tdLastMonth = document.createElement("td");

  // 添加樣式類
  tdTotal.className = "stats-cell";
  tdThisMonth.className = "stats-cell";
  tdLastMonth.className = "stats-cell";

  // 獲取統計數據
  try {
    const stats = await getKeywordStats(item.keyword);

    // 總觸發次數
    const totalBadge = document.createElement("span");
    totalBadge.className = "badge bg-primary stats-badge";
    totalBadge.textContent = stats.total || 0;
    tdTotal.appendChild(totalBadge);

    // 本月觸發
    const thisMonthBadge = document.createElement("span");
    thisMonthBadge.className = "badge bg-success stats-badge";
    thisMonthBadge.textContent = stats.thisMonth || 0;
    tdThisMonth.appendChild(thisMonthBadge);

    // 上月觸發
    const lastMonthBadge = document.createElement("span");
    lastMonthBadge.className = "badge bg-info stats-badge";
    lastMonthBadge.textContent = stats.lastMonth || 0;
    tdLastMonth.appendChild(lastMonthBadge);

  } catch (error) {
    console.error("❌ 獲取關鍵字統計失敗:", error);

    // 顯示錯誤狀態
    setInnerHTML(tdTotal, '<span class="badge bg-secondary stats-badge">-</span>');
    setInnerHTML(tdThisMonth, '<span class="badge bg-secondary stats-badge">-</span>');
    setInnerHTML(tdLastMonth, '<span class="badge bg-secondary stats-badge">-</span>');
  }


  tr.appendChild(tdKeyword);
  tr.appendChild(tdTypes);
  tr.appendChild(tdTotal);
  tr.appendChild(tdThisMonth);
  tr.appendChild(tdLastMonth);

  return tr;
}

// 編輯關鍵字功能
function editKeyword(item, index) {
  // 填入表單
  const keywordInput = document.getElementById("keyword-input");
  if (keywordInput) {
    keywordInput.value = item.keyword;
  }

  // 清空現有回覆
  window.currentReplies = [...item.replies];

  // 更新顯示
  const selectedReplyDisplay = document.getElementById("selected-reply-display");
  if (selectedReplyDisplay && item.replies.length > 0) {
    const previews = item.replies.map(reply =>
      generateMessagePreviewHTML(reply.type, reply)
    ).join("");
    setInnerHTML(selectedReplyDisplay, `<div class="alert alert-info">📝 編輯模式 - 已載入 ${item.replies.length} 個回覆：${previews}</div>`);
  }

}

export async function renderReplyList(userId) {
  const replyListContainer = document.getElementById("reply-list");
  const savedKeywordReplies = await fetchKeywordReplyList(userId);
  setInnerHTML(replyListContainer, "");

  // 將現有關鍵字存到 window.existingKeywords
  const list = savedKeywordReplies || [];
  window.existingKeywords = list.map(item => item.keyword);


  // 顯示載入狀態
  setInnerHTML(replyListContainer, `
    <tr class="loading-row">
      <td colspan="6" class="text-center">
        <div class="spinner-border text-primary" role="status">
          <span class="visually-hidden">載入中...</span>
        </div>
        <div class="mt-2">載入關鍵字統計中...</div>
      </td>
    </tr>
  `);

  try {
    const fragment = document.createDocumentFragment();

    // 使用 Promise.all 來並行處理所有行的創建
    const rowPromises = savedKeywordReplies.map(async (item, index) => {
      return await createKeywordRow(item, index, async (i) => {
        savedKeywordReplies.splice(i, 1);
        await fetch(`${apiBase}/keyword/save`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Id": userId
          },
          body: JSON.stringify(savedKeywordReplies)
        });
        renderReplyList(userId);
      });
    });

    const rows = await Promise.all(rowPromises);
    rows.forEach(row => fragment.appendChild(row));

    setInnerHTML(replyListContainer, "");
    replyListContainer.appendChild(fragment);

  } catch (error) {
    console.error("❌ 載入關鍵字清單失敗:", error);
    setInnerHTML(replyListContainer, `
      <tr>
        <td colspan="6" class="text-center text-danger">
          ❌ 載入失敗，請重新整理頁面
        </td>
      </tr>
    `);
  }
}


async function handleKeywordSubmit(e) {
  if (e) e.preventDefault();

  const submitBtn = e?.submitter || document.getElementById("submit");

  if (!submitBtn) {
    console.error("❌ 無法找到儲存按鈕");
    toast.error("系統錯誤：無法找到儲存按鈕");
    return;
  }

  await withButtonLoading(submitBtn, async () => {
    try {
      const keywordInput = document.getElementById("keyword-input");
      const keyword = keywordInput?.value?.trim();
      const replies = window.currentReplies;

      // 新增重複檢查邏輯
      const isDuplicate = window.existingKeywords?.some(item => item.toLowerCase() === keyword.toLowerCase());
      if (isDuplicate) {
        toast.warning(`關鍵字「${keyword}」已存在，請使用其他關鍵字`);
        return;
      }

      if (!keyword) {
        toast.warning("請輸入關鍵字");
        return;
      }

      if (!window.currentReplies || window.currentReplies.length === 0) {
        toast.warning("請至少加入一個回覆");
        return;
      }

      // 確保所有回覆都有正確的類型
      const enrichedReplies = window.currentReplies.map(reply => {
        if (typeof reply === "object" && !reply.type) {
          return { ...reply, type: detectReplyType(reply) };
        }
        return reply;
      });

      const newItem = new KeywordReply({
        keyword,
        replies: enrichedReplies,
        createdAt: new Date().toISOString()
      });

      if (!newItem.isValid()) {
        toast.warning("請至少加入一個有效回覆");
        return;
      }

      const res = await fetch(`${apiBase}/keyword/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": getUserId()
        },
        body: JSON.stringify(newItem.toJSON())
      });

      const result = await res.json();

      if (result.success) {
        toast.success("已儲存關鍵字回覆");

        // 清空表單
        keywordInput.value = "";
        window.currentReplies = [];
        const selectedReplyDisplay = document.getElementById("selected-reply-display");
        if (selectedReplyDisplay) {
          setInnerHTML(selectedReplyDisplay, "");
        }

        // 重新載入清單
        await renderReplyList(getUserId());

        // 清除快取
        clearMessageCache();
      } else {
        toast.error("儲存失敗：" + (result.error || "未知錯誤"));
      }
    } catch (err) {
      console.error("❌ 儲存失敗", err);
      toast.error("儲存過程中發生錯誤，請稍後再試");
    }
  }, '儲存中...');
}

// 🔍 根據物件特徵推斷 reply 類型 (更穩健的版本)
function detectReplyType(reply) {
  // 優先相信明確指定的 type 屬性
  if (reply && reply.type) {
    return reply.type;
  }

  // 若無 type 屬性，則根據物件特徵進行推斷 (相容舊資料)
  if (reply.altText && reply.baseUrl) return "imagemap";
  if (reply.contents) return "flex";
  if (reply.uri) return "uri";
  if (reply.data) return "postback";
  if (typeof reply.text === "string") return "text";

  return "unknown";
}



async function fetchKeywordReplyList(userId) {
  const res = await fetch(`${apiBase}/keyword/list`, {
    headers: { "X-User-Id": userId }
  });
  const json = await res.json();
  return json.data || [];
}

// 獲取關鍵字統計數據
async function getKeywordStats(keyword) {
  try {
    const res = await fetch(`${apiBase}/keyword/stats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": getUserId()
      },
      body: JSON.stringify({ keyword })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    return data.stats || { total: 0, thisMonth: 0, lastMonth: 0 };
  } catch (error) {
    console.error("❌ 獲取關鍵字統計失敗:", error);
    return { total: 0, thisMonth: 0, lastMonth: 0 };
  }
}



// === Reset form button event ===
// 綁定重設表單按鈕，清空所有輸入欄位與 UI
document.addEventListener("DOMContentLoaded", () => {
  const resetBtn = document.getElementById("reset-form-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetForm();
    });
  }
});

// 新重設表單邏輯，預設回到 text 類型並顯示 textarea
function resetForm() {

  // 清空目前選取的回覆與欄位
  window.currentReplyInput = null;

  const replyTypeSelect = document.getElementById("reply-type");
  if (replyTypeSelect) {
    replyTypeSelect.value = "text"; // 預設為文字
  }

  const dynamicFields = document.getElementById("reply-dynamic-fields");
  if (dynamicFields) {
    setInnerHTML(dynamicFields, "");
  }

  const replyInputArea = document.getElementById("reply-input-area");
  if (replyInputArea) {
    setInnerHTML(replyInputArea, "");
  }

  const selectedReplyDisplay = document.getElementById("selected-reply-display");
  if (selectedReplyDisplay) {
    setInnerHTML(selectedReplyDisplay, "");
  }

  // 註解：resetForm 只清空欄位，不重新生成 UI
  // UI 在 pageInit 時已經生成，不需要重複生成
}