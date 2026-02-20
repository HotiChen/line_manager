// (REWORKED) Renders the list of saved flex messages from the local `allFlexMessages` array
function renderSavedFlexList() {
  const container = document.getElementById('saved-flex-list');
  if (!container) return;

  setInnerHTML(container, '');
  if (allFlexMessages.length === 0) {
    setInnerHTML(container, "<div class='text-muted'>目前沒有已儲存的 Flex</div>");
    return;
  }

  allFlexMessages.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'card mb-2 p-2';
    card.dataset.id = item.id;

    if (item.isDeleted) {
      card.classList.add('bg-light', 'text-muted');
      card.style.opacity = '0.6';
      card.style.cursor = 'not-allowed';
    } else {
      card.style.cursor = 'pointer';
    }

    // NEW: Highlighting logic is now part of the render function
    if (currentFlex && item.id === currentFlex.id) {
      card.style.border = '2px solid #0d6efd';
      card.style.boxShadow = '0 0 0 3px rgba(13, 110, 253, 0.25)';
    }

    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';

    const titleContainer = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'fw-bold';
    title.textContent = `${index + 1}. ${item.title || item.name || '未命名'} `;
    titleContainer.appendChild(title);

    if (item.isDeleted) {
      const badge = document.createElement('span');
      badge.className = 'badge bg-danger ms-2';
      badge.textContent = '刪除';
      titleContainer.appendChild(badge);
    } else if (item.isNew) {
      const badge = document.createElement('span');
      badge.className = 'badge bg-success ms-2';
      badge.textContent = '新增';
      titleContainer.appendChild(badge);
    } else if (item.isUpdated) {
      const badge = document.createElement('span');
      badge.className = 'badge bg-warning text-dark ms-2';
      badge.textContent = '修改';
      titleContainer.appendChild(badge);
    }

    row.appendChild(titleContainer);
    card.appendChild(row);

    // 生成縮圖預覽
    if (item.contents) {
      const previewWrapper = document.createElement('div');
      // 修改樣式：設定固定寬度和改善顯示
      previewWrapper.style.cssText = "width: 1520px; transform: scale(0.25); transform-origin: top left; height: 120px; pointer-events: none; margin-top: 5px; overflow: hidden; background: rgba(248, 249, 250, 0.5); border: 1px solid #dee2e6; border-radius: 4px;";

      try {
        const previewContents = item.contents.type === 'carousel' ? item.contents.contents[0] : item.contents;

        if (previewContents) {
          const previewElement = createNameCardComponent(previewContents, false, false, null);

          if (previewElement) {
            previewWrapper.appendChild(previewElement);
          } else {
            console.warn(`[renderSavedFlexList] ⚠️ createNameCardComponent returned null for ${item.title}`);
            setInnerHTML(previewWrapper, '<div class="text-warning small">預覽元素為空</div>');
          }
        } else {
          console.warn(`[renderSavedFlexList] ⚠️ No preview contents for ${item.title}`);
          setInnerHTML(previewWrapper, '<div class="text-warning small">無預覽內容</div>');
        }
      } catch (e) {
        console.error(`[renderSavedFlexList] ❌ Could not generate preview for ${item.title}:`, e);
        setInnerHTML(previewWrapper, '<div class="text-danger small">無法產生預覽</div>');
      }
      card.appendChild(previewWrapper);
    } else {
      console.warn(`[renderSavedFlexList] ⚠️ Item ${item.title} has no contents`);
    }

    container.appendChild(card);
  });
}

// 搜尋篩選 Flex 列表
function filterFlexList(searchTerm) {
  const cards = document.querySelectorAll("#saved-flex-list .card");
  const term = searchTerm.toLowerCase().trim();
  let visibleCount = 0;

  if (!term) {
    // 如果搜尋欄位為空，顯示所有
    cards.forEach(card => {
      card.style.display = "";
      visibleCount++;
    });
  } else {
    cards.forEach(card => {
      const title = card.querySelector("span.fw-bold")?.textContent.toLowerCase() || "";

      if (title.includes(term)) {
        card.style.display = "";
        visibleCount++;
      } else {
        card.style.display = "none";
      }
    });
  }

  // 更新搜尋結果計數
  const resultCount = document.getElementById("flex-search-result-count");
  if (resultCount) {
    if (term) {
      resultCount.textContent = `找到 ${visibleCount} 個符合的 Flex`;
    } else {
      resultCount.textContent = "";
    }
  }
}

// (NEW) Fetches the initial list from the backend and renders it.
async function loadAndRenderInitialList(userId) {
  if (!userId) {
    showNotification("無法獲取使用者 ID，功能可能異常", "error");
    return;
  }

  try {
    LoadingManager.show('flex-fetch', '正在從後端讀取列表...');
    const messages = await fetchMessageListByType("flex", userId);
    allFlexMessages = messages.map(m => ({ ...m, isNew: false, isUpdated: false, isDeleted: false }));
    renderSavedFlexList();
  } catch (e) {
    console.error("❌ 載入 Flex 列表失敗:", e);
    const container = document.getElementById('saved-flex-list');
    if (container) setInnerHTML(container, "<div class='text-danger'>無法載入列表，請稍後再試。</div>");
  } finally {
    LoadingManager.hide('flex-fetch');
    updateButtonStates();
  }
}

import { getTagList } from './tag.js';
import { showConfirm } from '../helper/modal.helper.js';
import { toast, withButtonLoading } from "../helper/toast.js";
import { setInnerHTML } from "../helper/security.js";
import { createNameCardComponent } from "../js/flexcards.js";
import { apiBase, debug, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import {
  detectBuilder,
  getSupportedMsgTypes,
  getSavedMessages,
  formatMessagePreview,
  messageTypeLabels,
  fetchMessageListByType,
  generateMessagePreviewHTML,
  getMessageTypeIcon,
  clearMessageCache,
  refreshMessageType,
  searchMessages,
  uploadImage
} from "../helper/message.helper.js";
import { systemTemplates } from "./shared/flex_templates.js";

// 顯示通知
function showNotification(message, type = "info") {
  if (toast[type]) {
    toast[type](message);
  } else {
    toast.info(message);
  }
}

function renderPreview(swiper) {
  // 🛡️ Swiper 安全檢查（保險檢查）
  if (!swiper || typeof swiper.appendSlide !== "function") {
    console.warn("⚠️ Swiper 尚未初始化完成，稍後重試 renderPreview()");
    setTimeout(() => renderPreview(window.mainSwiper), 300);
    return;
  }
  if (typeof Swiper === "undefined") {
    console.error("❌ Swiper 尚未定義，請確認是否已正確載入 Swiper 套件");
    return;
  }

  // 原有程式碼繼續...

  if (swiper && Array.isArray(swiper.slides)) {
  } else {
    console.warn("⚠️ mainSwiper.slides 尚未準備好");
  }
  if (flexJson.type === "carousel") {
    const swiperContainer = document.querySelector(".swiper-container");
    const swiperWrapper = swiperContainer?.querySelector(".swiper-wrapper");
    if (!swiperContainer || !swiperWrapper) return;

    const slides = [];
    if (!Array.isArray(flexJson.contents)) {
      console.warn("⚠️ flexJson.contents 不是 array，無法 render carousel");
      return;
    }

    flexJson.contents.filter(Boolean).forEach((bubble, index) => {
      const vDiv = document.createElement("div");
      vDiv.className = "swiper-slide";
      vDiv.style.backgroundColor = "white";
      vDiv.id = `bubble - ${index} `;
      // ✅ 固定寬度與 CSS max-width 一致
      vDiv.style.width = "380px";

      try {
        const component = createNameCardComponent(bubble, false, true, swiper);

        if (component instanceof HTMLElement) {
          vDiv.appendChild(component);
          slides.push(vDiv);
        } else {
          console.warn("❌ 未產出有效 DOM 元素，跳過此 bubble");
        }

        console.groupEnd();
      } catch (err) {
        console.group(`🧩 Bubble ${index} Debug`);
        console.error("❌ Bubble render 發生錯誤：", err);
        console.error("🛠 Bubble JSON 結構：", JSON.stringify(bubble, null, 2));
        console.groupEnd();
      }
    });

    if (swiper && typeof swiper.destroy === "function") {
      swiper.destroy(true, true);
      swiper = null;
    }

    swiper = new Swiper(".swiper-container", {
      effect: "coverflow",
      grabCursor: true,
      initialSlide: 0, // ✅ 從第一張開始
      centeredSlides: true,
      slidesPerView: "auto",
      spaceBetween: 20, // ✅ 設定 slide 之間的間距
      coverflowEffect: {
        rotate: 30,
        stretch: 0,
        depth: 100,
        modifier: 1,
        slideShadows: true,
      },
      pagination: {
        el: ".swiper-pagination",
      },
    });
    window.mainSwiper = swiper;

    if (
      swiper &&
      typeof swiper.removeAllSlides === "function" &&
      Array.isArray(swiper.slides) &&
      swiper.slides.length > 0
    ) {
      swiper.removeAllSlides();
    }
    const validSlides = slides.filter(s => s instanceof HTMLElement && s.querySelector("*"));
    if (validSlides.length === 0) {
      console.warn("⚠️ 沒有有效的 slide 可供渲染，取消 appendSlide");
      return;
    }
    requestAnimationFrame(() => {
      validSlides.forEach((slide, i) => {
        try {
          swiper.appendSlide(slide);
        } catch (err) {
          console.warn(`⚠️ appendSlide 第 ${i} 個 slide 失敗：`, err);
        }
      });
      swiper.update();
    });
    printAllActions();
    return;
  }
  try {
    const result = createNameCardComponent(flexJson, false, true, null);
    result.style.maxWidth = "360px";
    result.style.minWidth = "320px";
    result.style.width = "100%";
    result.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.35)";
    result.style.borderRadius = "12px";

    const swiperContainerEl = document.querySelector(".swiper-container");
    if (!swiperContainerEl) throw new Error("找不到 .swiper-container");
    if (window.mainSwiper && typeof window.mainSwiper.removeAllSlides === "function") {
      window.mainSwiper.removeAllSlides();
    } else {
      window.mainSwiper = new Swiper(".swiper-container", {
        initialSlide: 0,
        effect: "coverflow",
        grabCursor: true,
        centeredSlides: true,
        slidesPerView: "auto",
        spaceBetween: 20, // ✅ 設定 slide 之間的間距
        coverflowEffect: {
          rotate: 30,
          stretch: 0,
          depth: 100,
          modifier: 1,
          slideShadows: true,
        },
        pagination: {
          el: ".swiper-pagination",
        },
      });
    }

    const slide = document.createElement("div");
    slide.className = "swiper-slide";
    slide.style.width = "380px"; // ✅ 統一寬度
    slide.appendChild(result);
    window.mainSwiper.appendSlide(slide);
    printAllActions();

    const blocks = result.querySelectorAll(".flex-element");
    blocks.forEach(el => {
      const flexType = el.getAttribute("data-flex-type");
      if (!flexType) return;

      el.addEventListener("mouseenter", () => el.classList.add("hovering"));

      el.addEventListener("mouseleave", () => el.classList.remove("hovering"));
    });
  } catch (err) {
    console.error("❌ 預覽失敗", err);
  }
}

// 顯示目前 Bubble 數量
function updateBubbleCount() {
  const bubbleCount = (flexJson.type === "carousel" && Array.isArray(flexJson.contents)) ? flexJson.contents.length : 1;
  let bubbleCountEl = document.getElementById("bubble-count");
  if (!bubbleCountEl) return;
  bubbleCountEl.textContent = `${bubbleCount} `;
}

// 在 renderPreview 之後呼叫 updateBubbleCount 和 checkUnsavedChanges
const _oldRenderPreview = renderPreview;
renderPreview = function (swiper) {
  _oldRenderPreview(swiper);
  updateBubbleCount();
  checkUnsavedChanges();
};

// 綁定所有動作連結，並列印
function bindAllActions(root) {
  try {
    const scope = root || document;
    const links = scope.querySelectorAll("a[data-action-type]");
    links.forEach(a => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const type = a.getAttribute("data-action-type");
        const label = a.getAttribute("data-action-label") || "";
        const uri = a.getAttribute("data-action-uri") || "";
        const text = a.getAttribute("data-action-text") || "";
        const data = a.getAttribute("data-action-data") || "";

        switch (type) {
          case "uri":
            if (uri) window.open(uri, "_blank");
            break;
          case "message":
            if (text) toast.info(text);
            break;
          case "postback":
            if (data) toast.info(data);
            break;
          default:
        }

        printAllActions();
      }, { once: false });
    });
  } catch (e) {
    console.warn("bindAllActions failed", e);
  }
}

function printAllActions() {
  try {
    const links = document.querySelectorAll(".swiper-container a[data-action-type]");
    const actions = [];
    links.forEach(a => {
      actions.push({
        type: a.getAttribute("data-action-type"),
        label: a.getAttribute("data-action-label") || "",
        uri: a.getAttribute("data-action-uri") || "",
        text: a.getAttribute("data-action-text") || "",
        data: a.getAttribute("data-action-data") || ""
      });
    });
    console.table(actions);
  } catch (e) {
    console.warn("printAllActions failed", e);
  }
}


import { showLoader, hideLoader, LoadingManager } from './shared/loader.js';

// NEW: Centralized function to update button states based on selection
function updateButtonStates() {
  const cloneBtn = document.getElementById('clone-list-item-btn');
  const deleteBtn = document.getElementById('delete-flex-btn');

  // Buttons should be enabled only when a valid (non-deleted) item is selected
  const isItemSelected = currentFlex && !currentFlex.isDeleted;

  if (cloneBtn) {
    cloneBtn.disabled = !isItemSelected;
  }
  if (deleteBtn) {
    deleteBtn.disabled = !isItemSelected;
  }
}

// 檢查未儲存變更並顯示狀態
function checkUnsavedChanges() {
  const flexNameInput = document.getElementById("flex-name");
  const statusEl = document.getElementById("save-status");

  if (!flexNameInput || !statusEl) return;

  const flexName = flexNameInput.value.trim();
  const hasName = flexName.length > 0;
  const hasChanges = JSON.stringify(flexJson) !== JSON.stringify(originalFlexJson);

  if (hasChanges && hasName) {
    setInnerHTML(statusEl, '<span class="badge bg-warning text-dark">⚠️ 有未儲存的修改</span>');
    statusEl.classList.remove('d-none');
  } else if (currentFlex && !hasChanges) {
    setInnerHTML(statusEl, '<span class="badge bg-success">✅ 已儲存</span>');
    statusEl.classList.remove('d-none');
  } else {
    statusEl.classList.add('d-none');
  }
}

// 更新同步按鈕狀態（顯示待同步數量）
function updateSyncButtonState() {
  const syncBtn = document.getElementById("sync-flex-btn");
  if (!syncBtn) return;

  const changedCount = allFlexMessages.filter(item =>
    item.isNew || item.isUpdated || item.isDeleted
  ).length;

  if (changedCount > 0) {
    setInnerHTML(syncBtn, `☁️ 同步到 LINE <span class="badge bg-light text-dark ms-1">${changedCount}</span>`);
    syncBtn.classList.remove('btn-outline-success');
    syncBtn.classList.add('btn-warning');
  } else {
    setInnerHTML(syncBtn, '☁️ 同步到 LINE');
    syncBtn.classList.remove('btn-warning');
    syncBtn.classList.add('btn-outline-success');
  }
}

let templateSwiper = null;

// NEW STATE MANAGEMENT
let allFlexMessages = []; // Holds the entire list of flex messages from the backend
let currentFlex = null; // The currently selected flex message object for editing
let flexJson = {}; // The JSON for the active flex message being edited in the preview
let originalFlexJson = {}; // A clean copy of the JSON to check for unsaved changes
let userId = null; // Will be set in pageInit via state.js

let currentEditingElement = null;
let currentEditingBubbleIndex = 0;
let currentEditingNodeType = null;
let currentEditingNodeIndex = 0;
let currentComponentTags = []; // 用於暫存當前編輯元件的標籤

export async function pageInit(pageData) {
  // 防止重複執行事件綁定
  if (window._flexEventListenersSetup) {
    // 仍然需要載入資料和更新 UI
    setUserId(pageData.userId);
    const userId = getUserId();
    loadAndRenderInitialList(userId);
    return;
  }
  window._flexEventListenersSetup = true;

  setUserId(pageData.userId);
  const userId = getUserId();
  window.openFlexElementModal = openEditModal;
  // ... (existing pageInit code)

  // 綁定多重標籤新增按鈕
  const addTagBtn = document.getElementById('add-tag-to-component-btn');
  if (addTagBtn) {
    addTagBtn.addEventListener('click', () => {
      const select = document.getElementById('modal-tag-select');
      const tagToAdd = select.value;
      if (tagToAdd && !currentComponentTags.includes(tagToAdd)) {
        currentComponentTags.push(tagToAdd);
        renderTagPills(document.getElementById('tag-pills-container'), currentComponentTags);
      }
      select.value = ''; // Reset dropdown
    });
  }

  // 綁定多重標籤移除事件 (事件委派)
  const pillsContainer = document.getElementById('tag-pills-container');
  if (pillsContainer) {
    pillsContainer.addEventListener('click', (e) => {
      if (e.target && e.target.matches('.btn-close')) {
        const tagToRemove = e.target.getAttribute('data-tag-name');
        currentComponentTags = currentComponentTags.filter(t => t !== tagToRemove);
        renderTagPills(pillsContainer, currentComponentTags);
      }
    });
  }

  // Load the initial list from the backend, passing the userId
  loadAndRenderInitialList(userId);

  // Add a single delegated event listener for the entire list
  const listContainer = document.getElementById('saved-flex-list');
  if (listContainer) {
    listContainer.addEventListener('click', async (e) => {
      const card = e.target.closest('.card');
      if (!card || !card.dataset.id) return;

      const itemId = card.dataset.id;
      const item = allFlexMessages.find(m => m.id === itemId);

      if (!item) {
        console.warn(`Clicked item with id ${itemId} but not found in allFlexMessages.`);
        return;
      }

      if (item.isDeleted) {
        showNotification("此訊息已被標記為刪除，無法載入", "warning");
        return;
      }

      const isDirty = JSON.stringify(flexJson) !== JSON.stringify(originalFlexJson);
      if (isDirty && currentFlex) {
        const confirmed = await showConfirm({
          title: '捨棄變更',
          message: '您有未儲存的變更，確定要載入嗎？這將會捨棄目前的變更。',
          type: 'warning'
        });
        if (!confirmed) return;
      }

      currentFlex = item;
      flexJson = JSON.parse(JSON.stringify(item.contents));
      originalFlexJson = JSON.parse(JSON.stringify(item.contents));
      document.getElementById('flex-name').value = item.title || item.name || '';

      renderPreview(window.mainSwiper);
      renderSavedFlexList(); // Re-render the list to apply highlight
      updateButtonStates();
      showNotification(`已載入 ${item.title || item.name} `, "success");
    });
  }


  // 偵測 builder 類型
  const builder = "flex";

  // 🚀 載入已儲存的 Flex Message 清單

  // === (REWORKED) Button Event Listeners for local-first workflow ===

  // "Update to List" button
  const updateListBtn = document.getElementById("update-list-btn");
  if (updateListBtn) {
    updateListBtn.addEventListener("click", () => {
      const name = document.getElementById("flex-name").value.trim();
      if (!name) {
        showNotification("請為此 Flex Message 命名", "error");
        return;
      }

      if (currentFlex) {
        // Update existing item
        currentFlex.title = name;
        currentFlex.name = name;
        currentFlex.contents = JSON.parse(JSON.stringify(flexJson));
        if (!currentFlex.isNew) { // Don't overwrite the 'new' status
          currentFlex.isUpdated = true;
        }
      } else {
        // Add new item
        const newFlex = {
          id: `local_${Date.now()} `,
          name: name,
          title: name,
          contents: JSON.parse(JSON.stringify(flexJson)),
          isNew: true,
          isUpdated: false,
          isDeleted: false,
        };
        allFlexMessages.push(newFlex);
        currentFlex = newFlex; // Set the new one as current
      }

      originalFlexJson = JSON.parse(JSON.stringify(flexJson)); // Update clean state
      showNotification("✅ 已儲存修改", "success");
      renderSavedFlexList();
      checkUnsavedChanges(); // 更新狀態顯示
      updateSyncButtonState(); // 更新同步按鈕
    });
  }

  // "Delete from List" button
  const deleteFlexBtn = document.getElementById("delete-flex-btn");
  if (deleteFlexBtn) {
    deleteFlexBtn.addEventListener("click", async () => {
      if (!currentFlex) {
        showNotification("請先從左側列表載入一個訊息", "warning");
        return;
      }

      const confirmed = await showConfirm({
        title: '標記刪除',
        message: `確定要將「${currentFlex.title}」標記為刪除嗎？\n變更將在點擊「上傳」後生效。`,
        type: 'danger'
      });
      if (!confirmed) return;

      currentFlex.isDeleted = true;

      // Reset editor
      currentFlex = null;
      flexJson = {};
      originalFlexJson = {};
      document.getElementById('flex-name').value = '';
      renderPreview(window.mainSwiper);

      showNotification("已在列表中標記為刪除", "info");
      renderSavedFlexList();
      updateButtonStates();
    });
  }

  // "Upload Changes to Backend" button
  const syncFlexBtn = document.getElementById("sync-flex-btn");
  if (syncFlexBtn) {
    syncFlexBtn.addEventListener("click", async () => {
      if (!getUserId()) { // Use module-level userId
        showNotification("無法獲取使用者 ID", "error");
        return;
      }

      const confirmed = await showConfirm({
        title: '確認上傳',
        message: '確定要將目前的變更上傳到後台嗎？這將會覆寫後台的資料。',
        type: 'warning',
        confirmText: '上傳'
      });
      if (!confirmed) return;

      // 1. Filter out deleted items
      let payload = allFlexMessages.filter(item => !item.isDeleted);

      // 2. Clean up local-only flags before sending
      payload = payload.map(item => {
        const { isNew, isUpdated, isDeleted, ...itemToSend } = item;
        // By no longer deleting the ID, the locally generated ID becomes permanent.
        return itemToSend;
      });


      await withButtonLoading(syncFlexBtn, async () => {
        try {
          const result = await api.post('/flex/sync', { flexs: payload });

          if (!result.success) {
            throw new Error(result.error || "同步失敗");
          }

          showNotification("✅ 成功同步變更到後台！", "success");

          // CRITICAL FIX: Clear the cache before reloading the list
          clearMessageCache();

          // Reload everything from the server to get a fresh, clean state
          await loadAndRenderInitialList(getUserId());
          updateSyncButtonState(); // 更新同步按鈕狀態

        } catch (err) {
          console.error("❌ 同步失敗:", err);
          showNotification(`❌ 同步失敗: ${err.message}`, "error");
        }
      }, '同步中...');
    });
  }

  // "Clone Current Flex" button
  const cloneListItemBtn = document.getElementById("clone-list-item-btn");
  if (cloneListItemBtn) {
    cloneListItemBtn.addEventListener("click", () => {
      if (!currentFlex) {
        showNotification("請先從列表中選擇一個要複製的 Flex Message", "warning");
        return;
      }

      // Create a deep copy of the current flex message
      const clone = JSON.parse(JSON.stringify(currentFlex));

      // Modify properties for the new clone
      clone.id = `local_${Date.now()} `;
      clone.title = `${currentFlex.title} (複製)`;
      clone.name = clone.title;
      clone.isNew = true;
      clone.isUpdated = false;
      clone.isDeleted = false;

      // Find the index of the current item to insert the clone after it
      const currentIndex = allFlexMessages.findIndex(item => item.id === currentFlex.id);

      if (currentIndex !== -1) {
        allFlexMessages.splice(currentIndex + 1, 0, clone);
      } else {
        // Fallback: just add to the end if the original couldn't be found
        allFlexMessages.push(clone);
      }

      // Set the new clone as the current item
      currentFlex = clone;

      showNotification(`已複製「${clone.title}」`, "success");
      renderSavedFlexList(); // Re-render the list to show the new item and highlight
      updateButtonStates();
    });
  }

  // "Add Bubble" button - Opens the template modal
  const addBubbleBtn = document.getElementById("add-bubble-btn");
  if (addBubbleBtn) {
    addBubbleBtn.addEventListener("click", () => {
      try {
        if (!flexJson) {
          flexJson = { type: "carousel", contents: [] };
        }

        // If the current message is a single bubble, convert it to a carousel first
        if (flexJson.type === "bubble") {
          flexJson = { type: "carousel", contents: [flexJson] };
          renderPreview(window.mainSwiper);
          updateBubbleCount();
        }

        if (flexJson.contents.length >= 12) {
          showNotification("一個輪播訊息中，最多只能有 12 個 Bubble！", "warning");
          return;
        }

        // Open the template selection modal
        const templateModalEl = document.getElementById("templateModal");
        if (templateModalEl) {
          const templateModal = new bootstrap.Modal(templateModalEl);
          templateModal.show();
        }

      } catch (err) {
        console.error("❌ 處理新增 Bubble 流程失敗:", err);
        showNotification("打開樣板選擇視窗時發生錯誤", "error");
      }
    });
  }

  // 綁定複製目前 Bubble 按鈕（簡單複製 activeIndex 的 bubble）
  const cloneFlexBtn = document.getElementById("clone-flex-btn");
  if (cloneFlexBtn) {
    cloneFlexBtn.addEventListener("click", () => {
      try {
        if (!flexJson) return;
        if (flexJson.type === "carousel" && Array.isArray(flexJson.contents) && flexJson.contents.length > 0) {
          const activeIndex = (window.mainSwiper && typeof window.mainSwiper.activeIndex === 'number') ? window.mainSwiper.activeIndex : 0;
          const src = flexJson.contents[activeIndex] || flexJson.contents[0];
          const clone = JSON.parse(JSON.stringify(src));
          if (flexJson.contents.length >= 12) {
            showNotification("最多只能加入 12 個 Bubble！", "warning");
            return;
          }
          const targetIndex = activeIndex + 1;
          flexJson.contents.splice(targetIndex, 0, clone);
          renderPreview(window.mainSwiper);
          updateBubbleCount();
          // 將焦點移到新複製的那一張
          if (window.mainSwiper && typeof window.mainSwiper.slideTo === 'function') {
            window.mainSwiper.slideTo(targetIndex, 0);
          }
          return;
        } else if (flexJson.type === "bubble") {
          // 單一 bubble -> 轉成 carousel 並複製一份
          const original = JSON.parse(JSON.stringify(flexJson));
          flexJson = { type: "carousel", contents: [original, JSON.parse(JSON.stringify(original))] };
          renderPreview(window.mainSwiper);
          updateBubbleCount();
          if (window.mainSwiper && typeof window.mainSwiper.slideTo === 'function') {
            window.mainSwiper.slideTo(1, 0);
          }
          return;
        }
      } catch (err) {
        console.error("❌ 複製 Bubble 失敗:", err);
        showNotification("複製 Bubble 發生錯誤", "error");
      }
    });
  }

  // Helper function to update UI based on Action Type
  function updateActionUI(actionType) {
    const tagCard = document.getElementById('tag-management-card');
    const actionProps = document.getElementById('action-properties-container');
    const uriLabel = document.getElementById('action-uri-label');
    const uriInput = document.getElementById('action-uri');

    if (!tagCard || !actionProps || !uriLabel || !uriInput) return;

    const isDisabled = actionType === 'none';

    // Toggle disabled state for containers
    [tagCard, actionProps].forEach(el => {
      el.classList.toggle('opacity-50', isDisabled);
      el.classList.toggle('pe-none', isDisabled);
    });

    // Disable inputs within the action properties container
    actionProps.querySelectorAll('input').forEach(input => input.disabled = isDisabled);

    // Update label and placeholder
    if (isDisabled) {
      uriLabel.textContent = '---';
      uriInput.placeholder = '';
    } else {
      switch (actionType) {
        case 'uri':
          uriLabel.textContent = 'URI';
          uriInput.placeholder = 'https://example.com';
          break;
        case 'message':
          uriLabel.textContent = 'Message Text';
          uriInput.placeholder = 'Hello, world!';
          break;
        case 'postback':
          uriLabel.textContent = 'Postback Data';
          uriInput.placeholder = 'action=buy&itemid=123';
          break;
      }
    }
  }

  // 綁定 Action Type 下拉選單的變更事件
  const actionTypeSelect = document.getElementById('action-type');
  if (actionTypeSelect) {
    actionTypeSelect.addEventListener('change', (e) => {
      const selectedType = e.target.value;
      updateActionUI(selectedType);
      // Clear the input when type changes, unless it's 'none'
      if (selectedType !== 'none') {
        document.getElementById('action-uri').value = '';
      }
    });
  }

  // 新增：建立 start-create-flex-btn 的事件邏輯
  const startCreateFlexBtn = document.getElementById("start-create-flex-btn");
  if (startCreateFlexBtn) {
    startCreateFlexBtn.addEventListener("click", async () => {
      const defaultEmptyBubble = {
        type: "bubble",
        body: { type: "box", layout: "vertical", contents: [] }
      };

      const isEditing = JSON.stringify(flexJson) !== JSON.stringify(defaultEmptyBubble);

      if (isEditing) {
        const decision = await showConfirm({
          title: '儲存變更',
          message: '目前有正在編輯的 Flex Message，要儲存嗎？',
          confirmText: '儲存',
          cancelText: '捨棄變更',
          type: 'info'
        });
        if (decision) {
          toast.success("✅ Flex Message 已儲存");
        }
      }

      // 清空 Flex JSON 為預設空白 bubble
      flexJson = defaultEmptyBubble;

      // 重新 render
      renderPreview(window.mainSwiper);

      // 改為觸發現有的 template modal 邏輯，才能載入 slides
      const openTemplateModalBtn = document.getElementById("open-template-modal");
      if (openTemplateModalBtn) {
        openTemplateModalBtn.click();
      }
    });
  }

  const newFlexBtn = document.getElementById('new-flex-btn');
  if (newFlexBtn) {
    newFlexBtn.addEventListener('click', () => {
      // Clear the input field for the new modal
      const newFlexNameInput = document.getElementById("new-flex-name");
      if (newFlexNameInput) newFlexNameInput.value = '';

      // Show only the naming modal
      const newFlexModalEl = document.getElementById("newFlexModal");
      if (newFlexModalEl) {
        const newFlexModal = new bootstrap.Modal(newFlexModalEl);
        newFlexModal.show();
      }
    });
  }

  // Add logic for the "Create" button inside the naming modal
  const createFlexBtn = document.getElementById('create-flex-btn');
  if (createFlexBtn) {
    createFlexBtn.addEventListener('click', () => {
      const newFlexNameInput = document.getElementById('new-flex-name');
      const flexNameInput = document.getElementById('flex-name'); // Main page's name input
      if (!newFlexNameInput || !flexNameInput) return;

      const newName = newFlexNameInput.value.trim();
      if (!newName) {
        showNotification("請輸入 Flex 名稱", "error");
        return;
      }

      // 1. Set the main page's name input
      flexNameInput.value = newName;

      // 2. Reset the current flex message to an empty carousel
      currentFlex = null; // CRITICAL: Reset current flex to indicate we are in creation mode
      flexJson = { type: "carousel", contents: [] };
      originalFlexJson = JSON.parse(JSON.stringify(flexJson)); // Also reset the clean state
      renderPreview(window.mainSwiper); // This will clear the preview

      // 3. Close the current modal
      const newFlexModal = bootstrap.Modal.getInstance(document.getElementById('newFlexModal'));
      newFlexModal?.hide();

      // 4. Open the template selection modal
      const templateModalEl = document.getElementById("templateModal");
      if (templateModalEl) {
        const templateModal = new bootstrap.Modal(templateModalEl);
        templateModal.show();
        updateButtonStates();
      }
    });
  }
  const nameCardContainer = document.getElementById("nameCardContainer");
  if (nameCardContainer) {
    setInnerHTML(nameCardContainer, "");

    window.mainSwiper = new Swiper(".swiper-container", {
      initialSlide: 0,
      effect: 'coverflow',
      grabCursor: true,
      centeredSlides: true,
      slidesPerView: 'auto',
      spaceBetween: 20, // ✅ 設定 slide 之間的間距
      coverflowEffect: {
        depth: 100,
        rotate: 20,
        stretch: 1,
        modifier: 1,
        slideShadows: true
      },
      pagination: {
        el: '.swiper-pagination',
      },
    });

    // Initialize with a clean, empty state
    currentFlex = null;
    flexJson = { type: "carousel", contents: [] };
    originalFlexJson = JSON.parse(JSON.stringify(flexJson));
    document.getElementById('flex-name').value = '';
    renderPreview(window.mainSwiper);
  }

  const addCarouselBubbleBtn = document.getElementById("add-carousel-bubble");
  if (addCarouselBubbleBtn) {
    addCarouselBubbleBtn.addEventListener("click", () => {



      const bubble = systemTemplates.hello; // 使用完整樣板
      try {
        if (flexJson.contents.length >= 12) {
          showNotification("最多只能加入 12 個 Bubble！", "warning");
          return;
        }

        if (!flexJson || flexJson.type !== "carousel") {
          const original = flexJson;
          flexJson = {
            type: "carousel",
            contents: [original]
          };
        } else {
          flexJson.contents.push(bubble);
        }
        renderPreview(window.mainSwiper);
        updateBubbleCount();
      } catch (err) {
        showNotification("❌ 加入 bubble 失敗：" + err.message, "error");
        console.error(err);
      }
    });
  }

  // Removed hover blue border style block
  const cancelModalBtn = document.getElementById("cancel-modal");
  if (cancelModalBtn) {
    cancelModalBtn.addEventListener("click", () => {
      const modal = bootstrap.Modal.getInstance(document.getElementById("editModal"));
      if (modal) {
        modal.hide();
        // 清理 backdrop
        setTimeout(() => {
          document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
          document.body.classList.remove('modal-open');
          document.body.style.removeProperty('overflow');
          document.body.style.removeProperty('padding-right');
        }, 300);
      }
      document.querySelector(".modal-backdrop")?.remove();
      document.body.classList.remove("modal-open");
      document.body.style = "";
    });
  }

  // 綁定刪除目前 Bubble 按鈕
  const deleteBubbleBtn = document.getElementById("delete-bubble-btn");
  if (deleteBubbleBtn) {
    deleteBubbleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      deleteCurrentBubble();
    });
  }


  const modalEl = document.getElementById("editModal");
  modalEl?.addEventListener("hidden.bs.modal", () => {
    document.querySelector(".modal-backdrop")?.remove();
    document.body.classList.remove("modal-open");
    document.body.style = "";
    document.body.focus(); // Move focus away from the closed modal
  });

  // 編輯 Modal：儲存變更
  const saveModalBtn = document.getElementById("save-modal");
  if (saveModalBtn) {
    saveModalBtn.addEventListener("click", () => {
      try {
        if (!currentEditingElement) return;

        const type = currentEditingNodeType; // Use the more reliable stored type

        const getActiveBubble = () => {
          if (!flexJson) return null;
          if (flexJson.type === 'carousel' && Array.isArray(flexJson.contents)) {
            return flexJson.contents[currentEditingBubbleIndex] || null;
          }
          return flexJson;
        };

        const bubble = getActiveBubble();
        if (!bubble) {
          console.error("Could not find active bubble to save into.");
          showNotification("儲存失敗：找不到目標 Bubble。", "error");
          return;
        }

        // --- NEW UNIFIED LOGIC ---
        const collected = [];
        const collect = (node) => {
          if (!node || typeof node !== 'object') return;
          if (node.type === type) collected.push(node);

          // Recurse through all possible child locations
          const keysToRecurse = ['header', 'hero', 'body', 'footer', 'contents'];
          for (const key of keysToRecurse) {
            const value = node[key];
            if (Array.isArray(value)) {
              value.forEach(collect);
            } else if (value && typeof value === 'object') {
              collect(value);
            }
          }
        };
        collect(bubble);

        const target = collected[currentEditingNodeIndex];
        if (!target) {
          console.error(`Could not find target element of type '${type}' at index ${currentEditingNodeIndex} `);
          showNotification("儲存失敗：找不到目標元件。", "error");
          return;
        }

        // 儲存多重標籤
        if (currentComponentTags && currentComponentTags.length > 0) {
          target.tags = [...currentComponentTags]; // 使用 tags (複數) 並儲存副本
        } else {
          delete target.tags;
        }

        // --- END NEW UNIFIED LOGIC ---

        // 儲存標籤
        if (currentComponentTags && currentComponentTags.length > 0) {
          target.tags = [...currentComponentTags];
        } else {
          delete target.tags;
        }

        // 儲存元件特有屬性
        if (type === 'text') {
          target.text = document.getElementById('modal-text').value;
          const color = document.getElementById('modal-color').value;
          if (color && color !== '#000000') {
            target.color = color;
          } else {
            delete target.color;
          }
        } else if (type === 'image') {
          target.url = document.getElementById('image-url').value;
        } else if (type === 'button') {
          if (!target.action) target.action = {};
          target.action.label = document.getElementById('modal-button-label').value;
          target.color = document.getElementById('modal-button-text-color').value;
        }

        // 儲存動作屬性 (如果適用)
        const hasAction = type === 'text' || type === 'image' || type === 'button';
        if (hasAction) {
          const actionType = document.getElementById('action-type').value;

          if (actionType === 'none') {
            delete target.action;
          } else {
            const label = document.getElementById('action-label').value;
            const uri = document.getElementById('action-uri').value;

            target.action = target.action || {};
            target.action.type = actionType;

            // For buttons, the label is set in the button-panel section.
            // For other types, it's set here from the generic action-label.
            if (type !== 'button') {
              target.action.label = label;
            }

            delete target.action.uri;
            delete target.action.text;
            delete target.action.data;

            if (actionType === 'uri') {
              target.action.uri = uri;
            } else if (actionType === 'message') {
              target.action.text = uri || label;
            } else if (actionType === 'postback') {
              target.action.data = uri || label;
            }
          }
        }

        renderPreview(window.mainSwiper);
        const modal = bootstrap.Modal.getInstance(document.getElementById("editModal"));
        modal?.hide();
        showNotification("✅ 變更已儲存", "success");

      } catch (e) {
        console.error(e);
        showNotification("儲存變更時發生錯誤", "error");
      }
    });
  }

  // 綁定圖片上傳按鈕
  const uploadImageBtn = document.getElementById('upload-image-btn');
  if (uploadImageBtn) {
    uploadImageBtn.addEventListener('click', async () => {
      const input = document.getElementById('image-upload-input');
      const file = input.files[0];
      if (!file) {
        showNotification('請先選擇一個圖片檔案', 'warning');
        return;
      }

      await withButtonLoading(uploadImageBtn, async () => {
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error('讀取檔案失敗'));
            reader.readAsDataURL(file);
          });

          const newUrl = await uploadImage(base64, file.name);

          // 將返回的 URL 填入輸入框
          const imageUrlInput = document.getElementById('image-url');
          if (imageUrlInput) {
            imageUrlInput.value = newUrl;
          }
          showNotification('✅ 圖片上傳成功！', 'success');

        } catch (err) {
          console.error('Upload failed:', err);
          showNotification(`❌ 上傳失敗: ${err.message} `, 'error');
        }
      }, '上傳中...');
    });
  }

  // 綁定清除快取按鈕
  const clearCacheBtn = document.getElementById('clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      clearMessageCache();
      showNotification('🧹 快取已清除！正在重新載入列表...', 'info');
      renderSavedFlexList();
    });
  }

  const addButtonBtn = document.getElementById("add-button");
  if (addButtonBtn) {
    addButtonBtn.addEventListener("click", () => {
      const button = {
        type: "button",
        style: "link",
        action: {
          type: "uri",
          label: "新按鈕",
          uri: "https://example.com"
        }
      };
      const target = flexJson.body?.contents;
      if (Array.isArray(target)) {
        target.push(button);
        renderPreview(window.mainSwiper);
      } else {
        toast.error("❌ 無法加入按鈕，找不到可用的 body");
      }
    });
  }

  const openTemplateModalBtn = document.getElementById("open-template-modal");
  if (openTemplateModalBtn) {
    openTemplateModalBtn.addEventListener("click", () => {
      // 移除舊的 swiper
      const templateModalEl = document.getElementById("templateModal");
      if (templateModalEl) {
        const templateModal = new bootstrap.Modal(templateModalEl);
        templateModal.show();
      }
      const wrapper = document.getElementById("template-swiper-wrapper");
      if (wrapper) {
        setInnerHTML(wrapper, ""); // 清空原本內容
        if (Array.isArray(systemTemplates.sampleTemplate.contents)) {
          systemTemplates.sampleTemplate.contents.forEach((bubble, index) => {
            const div = document.createElement("div");
            div.className = "swiper-slide";
            const preview = createNameCardComponent(bubble, false, false, null);
            div.appendChild(preview);
            wrapper.appendChild(div);
          });
        }
      }
      // Removed templateSwiper initialization.
    });
  }



  const insertTemplateBtn = document.getElementById("insert-template-btn");
  if (insertTemplateBtn) {
    insertTemplateBtn.addEventListener("click", () => {
      try {
        if (!templateSwiper) {
          showNotification("樣板選擇器尚未初始化", "error");
          return;
        }

        const activeSlide = templateSwiper.slides[templateSwiper.activeIndex];
        if (!activeSlide || !activeSlide.templateJson) {
          console.error("Could not find template JSON on the active slide.");
          showNotification("找不到對應的樣板資料", "error");
          return;
        }
        const selectedTemplate = activeSlide.templateJson;

        // Since the new flex flow already resets flexJson, we just push the new template.
        if (!flexJson || !Array.isArray(flexJson.contents)) {
          flexJson = { type: "carousel", contents: [] };
        }
        flexJson.contents.push(selectedTemplate);

        // Re-render the main preview
        renderPreview(window.mainSwiper);

        // Close the modal
        const templateModal = bootstrap.Modal.getInstance(document.getElementById("templateModal"));
        templateModal?.hide();
      } catch (err) {
        console.error("❌ 加入樣板失敗", err);
        showNotification("加入樣板時發生錯誤！", "error");
      }
    });
  }



  // --- Function moved to top of file to fix ReferenceError ---

  // --- Functions moved to top of file ---

  // 工具函式：更新 selector
  function updateBubbleSelector(contents) {
    const selector = document.getElementById("bubble-selector");
    setInnerHTML(selector, "");
    contents.forEach((_, i) => {
      const option = document.createElement("option");
      option.value = i;
      option.textContent = `Bubble ${i + 1} `;
      selector.appendChild(option);
    });
  }

  const modalElTemplate = document.getElementById("templateModal");
  modalElTemplate?.addEventListener("shown.bs.modal", () => {
    const wrapper = document.getElementById("template-swiper-wrapper");
    if (wrapper) {
      setInnerHTML(wrapper, ""); // Clear previous slides

      Object.values(systemTemplates).forEach(template => {
        let bubbles = [];
        if (template.type === 'carousel' && Array.isArray(template.contents)) {
          bubbles = template.contents;
        } else if (template.type === 'bubble') {
          bubbles.push(template);
        } else if (template.type === 'flex' && template.contents && template.contents.type === 'bubble') {
          bubbles.push(template.contents);
        }

        bubbles.forEach(bubble => {
          if (bubble && bubble.type === 'bubble') {
            const slide = document.createElement("div");
            slide.className = "swiper-slide flex-preview-wrapper"; // Add the wrapper class for styling
            slide.templateJson = bubble; // Attach the JSON object to the slide element
            const preview = createNameCardComponent(bubble, false, false, null);
            slide.appendChild(preview);
            wrapper.appendChild(slide);
          }
        });
      });
    }

    if (templateSwiper && typeof templateSwiper.destroy === "function") {
      templateSwiper.destroy(true, true);
      templateSwiper = null;
    }

    templateSwiper = new Swiper(".template-swiper", {
      initialSlide: 0,
      effect: "coverflow",
      grabCursor: true,
      centeredSlides: true,
      slidesPerView: "auto",
      coverflowEffect: {
        rotate: 30,
        stretch: 0,
        depth: 100,
        modifier: 1,
        slideShadows: true,
      },
      pagination: {
        el: ".swiper-pagination",
      },
    });

    templateSwiper.slideTo(templateSwiper.activeIndex, 0);
    const templateSwiperEl = document.querySelector(".template-swiper");
    if (templateSwiperEl) {
      templateSwiperEl.style.maxWidth = "100%";
      templateSwiperEl.style.width = "100%";
      templateSwiperEl.style.margin = "0 auto";
      templateSwiperEl.style.boxSizing = "border-box";
    }

    const modalBody = document.querySelector("#templateModal .modal-body");
    if (modalBody) {
      modalBody.style.overflowX = "hidden";
      modalBody.style.padding = "1rem";
    }

    // 新增程式碼：更新樣板頁碼顯示
    const currentPageDisplay = document.getElementById("template-page-number");
    if (currentPageDisplay) {
      templateSwiper.on("slideChange", () => {
        currentPageDisplay.textContent = `樣板 ${templateSwiper.activeIndex + 1} / ${templateSwiper.slides.length}`;
      });
      // 初始設定
      currentPageDisplay.textContent = `樣板 ${templateSwiper.activeIndex + 1} / ${templateSwiper.slides.length}`;
    }
  });

  // 解決 aria-hidden + focus 問題：modal 關閉時把焦點移回主按鈕
  const templateModalEl2 = document.getElementById('templateModal');
  if (templateModalEl2) {
    templateModalEl2.addEventListener('hidden.bs.modal', () => {
      const newFlexBtn = document.getElementById('new-flex-btn');
      if (newFlexBtn) newFlexBtn.focus();
    });
  }
  function renderTagPills(container, tags) {
    if (!container) return;
    setInnerHTML(container, '');
    tags.forEach(tag => {
      const pill = document.createElement('span');
      pill.className = 'badge rounded-pill bg-primary d-flex align-items-center';
      pill.style.paddingRight = '0.5rem';
      setInnerHTML(pill, `
      ${tag}
      <button type="button" class="btn-close btn-close-white ms-2" data-tag-name="${tag}" aria-label="Remove"></button>
    `);
      container.appendChild(pill);
    });
  }

  async function populateTagSelect(selectElement) {
    if (!selectElement) return;

    const tags = await getTagList(getUserId());
    setInnerHTML(selectElement, '<option value="">-- 請選擇要加入的標籤 --</option>');

    tags.forEach(tag => {
      const option = document.createElement('option');
      option.value = tag.name;
      option.textContent = tag.name;
      selectElement.appendChild(option);
    });
  }

  async function openEditModal(clicked) {
    if (!clicked) {
      console.error("openEditModal was called with a null or undefined element.");
      return;
    }
    const flexType = clicked.getAttribute("data-flex-type");

    if (document.querySelector('.modal-backdrop')) return;


    currentEditingElement = clicked;
    if (window.mainSwiper && typeof window.mainSwiper.activeIndex === 'number') {
      currentEditingBubbleIndex = window.mainSwiper.activeIndex;
    } else {
      currentEditingBubbleIndex = 0;
    }

    currentEditingNodeType = flexType;
    const bubbleSlide = clicked.closest('.swiper-slide');
    if (bubbleSlide && currentEditingNodeType) {
      const sameTypeNodes = Array.from(bubbleSlide.querySelectorAll(`.flex-element[data-flex-type="${currentEditingNodeType}"]`));
      currentEditingNodeIndex = Math.max(0, sameTypeNodes.indexOf(clicked));
    } else {
      currentEditingNodeIndex = 0;
    }

    const bubble = (flexJson.type === 'carousel') ? flexJson.contents[currentEditingBubbleIndex] : flexJson;
    const collected = [];
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === flexType) collected.push(node);
      const keysToRecurse = ['header', 'hero', 'body', 'footer', 'contents'];
      for (const key of keysToRecurse) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') collect(value);
      }
    };
    collect(bubble);
    const target = collected[currentEditingNodeIndex];

    // 填充 UI
    await populateTagSelect(document.getElementById('modal-tag-select'));
    currentComponentTags = target?.tags || [];
    renderTagPills(document.getElementById('tag-pills-container'), currentComponentTags);

    document.getElementById("modal-text").value = "";
    document.getElementById("modal-color").value = "#000000";
    document.getElementById("image-url").value = "";
    document.getElementById("action-label").value = "";
    document.getElementById("action-uri").value = "";

    // 隱藏所有面板
    document.getElementById("text-panel")?.classList.add("d-none");
    document.getElementById("image-panel")?.classList.add("d-none");
    document.getElementById("button-panel")?.classList.add("d-none");
    document.getElementById("action-panel-card")?.classList.add("d-none");

    // 根據元件類型，顯示並填充對應面板
    if (flexType === "text") {
      document.getElementById("text-panel")?.classList.remove("d-none");
      document.getElementById("modal-text").value = target?.text || '';
      document.getElementById("modal-color").value = target?.color || '#000000';
    }
    if (flexType === "image") {
      document.getElementById("image-panel")?.classList.remove("d-none");
      document.getElementById('image-url').value = target?.url || '';
    }
    if (flexType === "button") {
      document.getElementById("button-panel")?.classList.remove("d-none");
      document.getElementById("modal-button-label").value = target?.action?.label || '';
      document.getElementById("modal-button-text-color").value = target?.action?.color || '#000000';
    }

    // 處理動作面板 (文字、圖片、按鈕都需要)
    const hasAction = flexType === 'text' || flexType === 'image' || flexType === 'button';
    if (hasAction) {
      document.getElementById("action-panel-card")?.classList.remove("d-none");
      const action = target?.action || {};
      const actionType = action.type || 'none';
      document.getElementById('action-type').value = actionType;
      document.getElementById('action-label').value = action.label || (flexType === 'text' ? target?.text : '') || '';
      const uriInput = document.getElementById('action-uri');
      uriInput.value = action.uri || action.text || action.data || '';

      // 根據動作類型，設定 UI 初始狀態
      updateActionUI(actionType);
    }

    const typeDisplay = document.getElementById("modal-type");
    if (typeDisplay) {
      typeDisplay.textContent = `元件類型：${flexType}`;
    }

    const modal = new bootstrap.Modal(document.getElementById("editModal"));
    modal.show();
  }
  // --- Old, unused API and helper functions have been removed. ---

  // 顯示通知


  // ---------- Function moved to top of file to fix ReferenceError ----------

  async function deleteCurrentBubble() {
    try {
      if (!flexJson) return;

      if (flexJson.type === 'carousel' && Array.isArray(flexJson.contents)) {
        const count = flexJson.contents.length;
        const activeIndex = (window.mainSwiper && typeof window.mainSwiper.activeIndex === 'number') ? window.mainSwiper.activeIndex : 0;

        if (count <= 0) {
          showNotification("目前沒有可刪除的 Bubble", "error");
          return;
        }

        const confirmed = await showConfirm({
          title: '刪除 Bubble',
          message: `將刪除第 ${activeIndex + 1} 個 Bubble（總數 ${count}）。確定嗎？`,
          type: 'warning'
        });
        if (!confirmed) return;

        flexJson.contents.splice(activeIndex, 1);

        if (flexJson.contents.length === 0) {
          flexJson = {
            type: "bubble",
            body: { type: "box", layout: "vertical", contents: [] }
          };
        } else if (flexJson.contents.length === 1) {
          flexJson = flexJson.contents[0];
        }

        renderPreview(window.mainSwiper);
        updateBubbleCount();
        showNotification("🗑️ 已刪除該 Bubble", "success");
        return;
      }

      const confirmedSingle = await showConfirm({
        title: '清空內容',
        message: '目前只有一個 Bubble，刪除會清空內容（會保留一個空白 bubble）。確定嗎？',
        type: 'warning'
      });
      if (!confirmedSingle) return;

      flexJson = {
        type: "bubble",
        body: { type: "box", layout: "vertical", contents: [] }
      };
      renderPreview(window.mainSwiper);
      updateBubbleCount();
      showNotification("🗑️ 已清空目前 Bubble（重置為空白）", "success");
    } catch (err) {
      console.error("❌ 刪除 Bubble 發生錯誤：", err);
      showNotification("刪除 Bubble 發生錯誤，查看 Console", "error");
    }
  }

  // --- JSON Import/Export Modal Logic ---
  const jsonIoBtn = document.getElementById('json-io-btn');
  const jsonIoModalEl = document.getElementById('json-io-modal');
  const jsonIoTextarea = document.getElementById('json-io-textarea');
  if (jsonIoBtn && jsonIoModalEl && jsonIoTextarea) {
    const jsonIoModal = new bootstrap.Modal(jsonIoModalEl);
    jsonIoBtn.addEventListener('click', () => {
      jsonIoTextarea.value = JSON.stringify(flexJson, null, 2);
      jsonIoModal.show();
    });

    const copyJsonBtn = document.getElementById('copy-json-btn');
    if (copyJsonBtn) {
      copyJsonBtn.addEventListener('click', () => {
        jsonIoTextarea.select();
        navigator.clipboard.writeText(jsonIoTextarea.value).then(() => {
          showNotification('✅ 已複製到剪貼簿！', 'success');
        }).catch(err => {
          showNotification('❌ 複製失敗', 'error');
          console.error('Copy failed', err);
        });
      });
    }

    const updateJsonBtn = document.getElementById('update-json-btn');
    if (updateJsonBtn) {
      updateJsonBtn.addEventListener('click', () => {
        try {
          const newJsonString = jsonIoTextarea.value;
          const newJson = JSON.parse(newJsonString);

          if (typeof newJson.type !== 'string') {
            throw new Error('JSON 缺少 "type" 屬性');
          }

          flexJson = newJson;
          renderPreview(window.mainSwiper);
          jsonIoModal.hide();
          showNotification('✅ Flex 預覽已更新', 'success');

        } catch (err) {
          toast.error('JSON 格式錯誤，請檢查後再試一次。\\n\\n' + err.message);
          console.error("Invalid JSON:", err);
        }
      });
    }
  }

  // ✅ 綁定 Flex 搜尋功能
  const flexSearchInput = document.getElementById("flex-search");
  const clearFlexSearchBtn = document.getElementById("clear-flex-search");

  flexSearchInput?.addEventListener("input", (e) => {
    filterFlexList(e.target.value);
  });

  clearFlexSearchBtn?.addEventListener("click", () => {
    if (flexSearchInput) {
      flexSearchInput.value = "";
      filterFlexList("");
    }
  });

  // ✅ 監聽 Flex 名稱輸入，檢查未儲存變更
  const flexNameInput = document.getElementById("flex-name");
  if (flexNameInput) {
    flexNameInput.addEventListener("input", checkUnsavedChanges);
  }

}