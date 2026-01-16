
import { CanvasHelper } from './canva.module.js?v=0.0001';
import { processImageFor } from './image.helper.js';
import {
  detectBuilder,
  getSupportedMsgTypes,
  getSavedMessages,
  formatMessagePreview,
  messageTypeLabels,
  fetchMessageListByType,
  generateReplyInputUI,
  getCurrentReplyInput,
  createAction,
  generateMessagePreviewHTML,
  getMessageTypeIcon,
  clearMessageCache,
  refreshMessageType,
  searchMessages,
  uploadImage,
  MessageFactory
} from "../helper/message.helper.js";


import { showLoader, hideLoader } from './shared/loader.js';
import { getUserId, setUserId, apiBase } from "../helper/state.js";
import { toast, withButtonLoading } from "../helper/toast.js";  // ✅ 添加缺少的 toast import

let processedImageFile = null; // To store the processed image file

/**
 * Converts a base64 data URL to a File object.
 * @param {string} dataurl The base64 data URL.
 * @param {string} filename The desired filename for the new File.
 * @returns {File}
 */
function dataURLtoFile(dataurl, filename) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
    bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

class ImageMap {
  constructor({ baseUrl, altText, baseSize, actions = [], video = null, deletehash = null }) {
    this.type = "imagemap";
    this.baseUrl = baseUrl;
    this.altText = altText;
    this.baseSize = baseSize;
    this.actions = actions;
    if (video) this.video = video;
    this.deletehash = deletehash;
  }

  addArea(area) {
    this.actions.push(area);
    this.isUpdated = true;
  }

  removeArea(index) {
    if (index >= 0 && index < this.actions.length) {
      this.actions.splice(index, 1);
      this.isUpdated = true;
    }
  }

  toJSON() {
    // ✅ 檢查 baseUrl 是否為 base64，如果是則警告（應該在上傳前轉換）
    if (this.baseUrl && this.baseUrl.startsWith('data:image/')) {
      console.warn(`⚠️ ImageMap "${this.altText}" 的 baseUrl 仍為 base64，可能尚未上傳圖片`);
    }

    return {
      type: this.type,
      baseUrl: this.baseUrl,
      altText: this.altText,
      baseSize: this.baseSize,
      actions: this.actions,
      ...(this.video ? { video: this.video } : {}),
      ...(this.deletehash ? { deletehash: this.deletehash } : {})
      // ❌ 不包含 image 屬性（image 只是暫存資料，不應存入 KV）
    };
  }
}

// 搜尋篩選 Imagemap 列表
function filterImagemapList(searchTerm) {
  const thumbnails = document.querySelectorAll("#imagemap-thumbnails > div");
  const term = searchTerm.toLowerCase().trim();
  let visibleCount = 0;

  if (!term) {
    // 如果搜尋欄位為空，顯示所有
    thumbnails.forEach(thumb => {
      thumb.style.display = "";
      visibleCount++;
    });
  } else {
    thumbnails.forEach(thumb => {
      const title = thumb.querySelector("p")?.textContent.toLowerCase() || "";

      if (title.includes(term)) {
        thumb.style.display = "";
        visibleCount++;
      } else {
        thumb.style.display = "none";
      }
    });
  }

  // 更新搜尋結果計數
  const resultCount = document.getElementById("imagemap-search-result-count");
  if (resultCount) {
    if (term) {
      resultCount.textContent = `找到 ${visibleCount} 個符合的 ImageMap`;
    } else {
      resultCount.textContent = "";
    }
  }
}

// ImageMap 編輯器主程式
export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();

  // 🔄 顯示 loading 動畫
  const thumbnailArea = document.getElementById("imagemap-thumbnails");
  if (thumbnailArea) {
    thumbnailArea.innerHTML = `<div class="text-center my-3" id="loading-spinner">
      <div class="spinner-border text-primary" role="status"><span class="visually-hidden">載入中...</span></div>
      <div>讀取圖片選單中...</div>
    </div>`;
  }

  // 偵測 builder 類型
  const builder = "imagemap";

  // 讀取 Cloudflare Worker 上的 imagemap 資料
  try {

    // 使用 helper 中的函數載入 imagemap 清單
    const imagemapData = await fetchMessageListByType("imagemap", userId);

    if (Array.isArray(imagemapData)) {
      window.imagemaps = imagemapData.map(data => new ImageMap(data));
    } else {
      console.warn("⚠️ 無法讀取 KV imagemaps");
      window.imagemaps = [];
    }
  } catch (err) {
    console.error("❌ 讀取 imagemaps 發生錯誤:", err);
    window.imagemaps = [];
  }

  // 清除 loading 並顯示縮圖
  if (thumbnailArea) {
    thumbnailArea.innerHTML = ""; // 清空
    window.imagemaps.forEach((imagemap, idx) => {
      const thumb = document.createElement("div");
      thumb.className = "mb-2 p-2 border rounded bg-light";
      thumb.innerText = `${idx + 1}. ${imagemap.altText}${imagemap.isNew ? "（新建）" : imagemap.isUpdated ? "（已修改）" : ""}`;
      const img = document.createElement("img");
      img.src = imagemap.baseUrl;
      img.alt = imagemap.altText;
      img.style.maxWidth = "100%";
      img.style.height = "auto";
      thumb.appendChild(img);

      thumb.addEventListener("click", () => {
        const selected = window.imagemaps[idx];
        if (!selected) return;

        areas = selected.actions.map(a => ({ ...a })); // 複製
        document.getElementById("menu-name").value = selected.altText;

        const canvas = document.getElementById("uploaded-image-canvas");
        const ctx = canvas?.getContext("2d");
        const imagePreview = new Image();
        canvas.width = selected.baseSize.width;
        canvas.height = selected.baseSize.height;

        imagePreview.onload = () => {
          try {
            CanvasHelper.init(canvas, ctx, 1, imagePreview);
            CanvasHelper.redrawCanvasWithAreas(areas);
            updateTable && updateTable();

            // 是不是這邊要把 mouse event 加入?
          } catch (e) {
            console.error("⚠️ 畫布載入失敗：", e);
          }
        };
        imagePreview.src = selected.baseUrl;

        window.currentImagemap = selected;
      });

      thumbnailArea.appendChild(thumb);
    });
  }

  if (!document.getElementById("uploaded-image-canvas")) {
    console.error("❌ 找不到 canvas 元素！");
    return;
  }

  const canvas = document.getElementById("uploaded-image-canvas");
  if (!canvas) {
    console.error("❌ 找不到 canvas 元素！");
    return;
  }

  const ctx = canvas.getContext("2d");
  const imageInput = document.getElementById("new-image-upload");
  const imagePreview = new Image();
  const areasTable = document.getElementById("areas-table").querySelector("tbody");

  let imageLoaded = false;
  let areas = [];
  let previewBox = null;

  // 監聽圖片上傳（使用標記防止重複綁定）
  if (!imageInput._uploadListenerAdded) {
    imageInput?.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const previewAreaImagePreview = document.getElementById("image-preview");
      showLoader('正在處理圖片...');
      try {
        const processedDataUrl = await processImageFor(file, 'imagemap');

        window.latestBase64Image = processedDataUrl; // For existing logic that uses this
        previewAreaImagePreview.src = processedDataUrl;
        previewAreaImagePreview.style.display = "block";

        const newFilename = file.name.replace(/\.\w+$/, '.jpg');
        processedImageFile = dataURLtoFile(processedDataUrl, newFilename);

      } catch (error) {
        console.error("❌ [DEBUG] 圖片處理錯誤:", error);
        toast.error(error.message);
        e.target.value = '';
        previewAreaImagePreview.src = "";
        previewAreaImagePreview.style.display = "none";
        processedImageFile = null;
        window.latestBase64Image = null;
      } finally {
        hideLoader();
      }
    });
    if (imageInput) imageInput._uploadListenerAdded = true;
  } else {
  }

  // 綁定新增加的「選擇檔案」按鈕（使用標記防止重複綁定）
  const triggerBtn = document.getElementById("trigger-image-upload");
  if (triggerBtn && !triggerBtn._clickListenerAdded) {
    triggerBtn.addEventListener("click", () => {
      imageInput?.click(); // 觸發隱藏的檔案輸入框點擊事件
    });
    triggerBtn._clickListenerAdded = true;
  } else {
  }


  // 更新區域資料表格
  function updateTable() {
    areasTable.innerHTML = "";

    // 定義類型的圖示和顏色配置
    const typeConfig = {
      uri: { icon: '🔗', label: '網址', color: 'primary' },
      message: { icon: '💬', label: '文字訊息', color: 'success' },
      postback: { icon: '📦', label: '回傳', color: 'info' },
      keyword: { icon: '🔑', label: '關鍵字', color: 'secondary' }
    };

    areas.forEach((a, idx) => {
      const row = document.createElement("tr");
      row.style.cursor = 'pointer';
      row.style.transition = 'background-color 0.2s';

      // Hover 效果
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = '#f8f9fa';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = '';
      });

      // 點擊整行編輯
      row.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
          editArea(idx);
        }
      });

      // 根據 action 類型取得對應的顯示文字
      let contentDisplay = "";
      if (a.type === "uri") {
        contentDisplay = a.linkUri || "";
      } else if (a.type === "message") {
        contentDisplay = a.text || "";
      } else if (a.type === "keyword") {
        contentDisplay = a.keyword || a.text || "";
      } else {
        contentDisplay = a.text || a.linkUri || a.data || "";
      }

      // 取得類型配置
      const config = typeConfig[a.type] || { icon: '❓', label: a.type, color: 'secondary' };

      // 截斷過長的內容
      const maxLength = 40;
      const displayText = contentDisplay.length > maxLength
        ? contentDisplay.substring(0, maxLength) + '...'
        : contentDisplay;

      row.innerHTML = `
        <td class="text-center" style="width: 40px;">
          <span class="badge bg-secondary rounded-circle">${idx + 1}</span>
        </td>
        <td style="width: 140px; font-size: 0.85rem; color: #6c757d;">
          <div>📍 (${a.area.x}, ${a.area.y})</div>
          <div style="font-size: 0.75rem;">📐 ${a.area.width} × ${a.area.height}</div>
        </td>
        <td style="width: 120px;">
          <span class="badge bg-${config.color}" style="font-size: 0.85rem;">
            ${config.icon} ${config.label}
          </span>
        </td>
        <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" 
            title="${contentDisplay}">
          <span style="font-size: 0.9rem;">${displayText}</span>
        </td>
        <td style="width: 100px; text-align: center;">
          <button class="btn btn-sm btn-outline-primary me-1" title="編輯" 
                  onclick="event.stopPropagation()">
            ✏️
          </button>
          <button class="btn btn-sm btn-outline-danger" title="刪除" 
                  onclick="event.stopPropagation()">
            🗑️
          </button>
        </td>
      `;

      // 重新綁定按鈕事件
      const editBtn = row.querySelector('.btn-outline-primary');
      const deleteBtn = row.querySelector('.btn-outline-danger');

      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editArea(idx);
      });

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeArea(idx);
      });

      areasTable.appendChild(row);
    });
  }

  // 刪除區域
  window.removeArea = function (index) {
    areas.splice(index, 1);
    if (!canvas || !ctx) {
      console.warn("⚠️ Canvas 或 Context 尚未初始化，跳過重繪");
      return;
    }
    try {

      CanvasHelper.redrawCanvasWithAreas(areas);
    } catch (e) {
      console.error("[CanvasHelper] ❌ redrawCanvasWithAreas() 發生錯誤：", e);
    }
    updateTable();
  };

  window.editArea = async function (index) {
    if (index < 0 || index >= areas.length) return;

    const area = areas[index];
    const modalEl = document.getElementById("edit-modal");
    const replyContainer = document.getElementById("reply-dynamic-fields");
    replyContainer.innerHTML = '<p class="text-muted">載入中...</p>'; // 顯示載入狀態

    const editModal = new bootstrap.Modal(modalEl);
    editModal.show();

    // 根據舊的 area 格式，建立一個給 helper 使用的 initialReply 物件
    const replyForUI = {
      type: area.type === 'uri' ? 'uri' : 'message',
      text: area.text,
      uri: area.linkUri,
      tags: area.tags || []
    };

    const userId = getUserId() || localStorage.getItem("line_user_id");
    const ui = await generateReplyInputUI({
      builder: 'imagemap',
      userId,
      initialReply: replyForUI
    });

    replyContainer.innerHTML = '';
    replyContainer.appendChild(ui);

    // 隱藏「儲存」按鈕，顯示「更新」按鈕
    document.getElementById("save-button").classList.add("d-none");
    document.getElementById("update-button").classList.remove("d-none");
    document.getElementById("update-button").setAttribute("data-index", index);
  };





  document.getElementById("confirm-new-imagemap")?.addEventListener("click", async () => {

    const name = document.getElementById("new-menu-name").value.trim();

    // ✅ 驗證名稱
    if (!name) {
      return toast.warning("請輸入圖文訊息名稱");
    }

    // ✅ 驗證名稱不能太短
    if (name.length < 2) {
      return toast.warning("圖文訊息名稱至少需要 2 個字元");
    }

    // ✅ 建議不要使用純數字作為名稱（會造成混淆）
    if (/^\d+$/.test(name)) {
      toast.warning("建議不要使用純數字作為名稱，容易混淆");
      // 不return，只是警告
    }

    // ✅ 檢查是否與現有名稱重複
    if (window.imagemaps && window.imagemaps.some(im => im.altText === name)) {
      return toast.warning(`名稱「${name}」已存在，請使用不同的名稱`);
    }


    const previewAreaImagePreview = document.getElementById("image-preview");
    let baseUrl = previewAreaImagePreview.src;

    if (!baseUrl || baseUrl === window.location.href) {
      return toast.warning("請先上傳圖片");
    }

    // ✅ 檢查是否為 base64 圖片（上傳的本地圖片）
    let imageData = null;
    if (baseUrl.startsWith('data:image/')) {

      if (!processedImageFile) {
        return toast.error("無法取得處理後的圖片檔案，請重新上傳");
      }

      // 暫存圖片資料，稍後在「上傳 imagemap」時再真正上傳
      imageData = {
        base64: baseUrl,
        file: processedImageFile
      };

    }


    // --- NEW LOGIC: Directly use the preview image's properties ---
    const imageWidth = previewAreaImagePreview.naturalWidth;
    const imageHeight = previewAreaImagePreview.naturalHeight;

    if (!imageWidth || !imageHeight) {
      console.error("[Confirm Click] 錯誤：無法從預覽圖片取得尺寸 (naturalWidth/naturalHeight)。");
      toast.error("錯誤：無法讀取圖片尺寸，請嘗試重新上傳圖片。");
      return;
    }

    // --- All logic from the old 'onload' handler is now moved here and executed synchronously ---
    canvas.width = imageWidth;
    canvas.height = imageHeight;

    try {
      // We need a new Image object for the CanvasHelper, but we know it's loaded.
      const imgForCanvas = new Image();
      imgForCanvas.src = baseUrl;

      CanvasHelper.init(canvas, ctx, 1, imgForCanvas);
      CanvasHelper.redrawCanvasWithAreas([]);
    } catch (e) {
      console.error("[Confirm Click] ❌ Canvas 操作失敗：", e);
      toast.error("Canvas 操作失敗，請查看控制台。");
      return;
    }

    // --- Setup drawing listeners ---
    let isDrawing = false;
    let startX = 0;
    let startY = 0;

    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      startX = Math.floor((e.clientX - rect.left) * scaleX);
      startY = Math.floor((e.clientY - rect.top) * scaleY);
      isDrawing = true;
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!isDrawing) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const currentX = Math.floor((e.clientX - rect.left) * scaleX);
      const currentY = Math.floor((e.clientY - rect.top) * scaleY);
      const width = currentX - startX;
      const height = currentY - startY;
      previewBox = {
        area: { x: startX, y: startY, width, height },
        ...MessageFactory.text("預設文字")  // ✅ 使用 MessageFactory 統一格式
      };

      try {
        CanvasHelper.redrawCanvasWithAreas([...areas, previewBox]);
      } catch (e) {
        console.error("[CanvasHelper] ❌ redrawCanvasWithAreas(mousemove) 發生錯誤：", e);
      }
    });

    canvas.addEventListener("mouseup", (e) => {
      if (!isDrawing) return;
      isDrawing = false;
      if (previewBox && previewBox.area.width !== 0 && previewBox.area.height !== 0) {
        const { x, y, width, height } = previewBox.area;
        const normalizedBox = {
          area: { x: width < 0 ? x + width : x, y: height < 0 ? y + height : y, width: Math.abs(width), height: Math.abs(height) },
          type: previewBox.type,
          data: previewBox.text
        };
        const isOverlap = areas.some((a) => {
          const r1 = a.area; const r2 = normalizedBox.area;
          return r1.x < r2.x + r2.width && r1.x + r1.width > r2.x && r1.y < r2.y + r2.height && r1.y + r1.height > r2.y;
        });
        if (isOverlap) {
          toast.warning("新框框與既有區塊重疊，已取消新增。");
        } else {
          areas.push(normalizedBox);
          updateTable();

          // 生成訊息選擇 UI
          const replyContainer = document.getElementById("reply-dynamic-fields");
          if (replyContainer) {
            replyContainer.innerHTML = '<p class="text-muted">載入中...</p>';
            generateReplyInputUI({
              builder: 'imagemap',
              userId: getUserId()
            }).then((ui) => {
              replyContainer.innerHTML = '';
              replyContainer.appendChild(ui);

              // 隱藏「更新」按鈕，顯示「儲存」按鈕
              document.getElementById("save-button").classList.remove("d-none");
              document.getElementById("update-button").classList.add("d-none");
            });
          }

          const editModal = new bootstrap.Modal(document.getElementById("edit-modal"));
          editModal.show();
        }
      }
      previewBox = null;
      try {
        CanvasHelper.redrawCanvasWithAreas(areas);
      } catch (e) {
        console.error("[CanvasHelper] ❌ redrawCanvasWithAreas(mouseup) 發生錯誤：", e);
      }
    });

    canvas.addEventListener("mouseleave", () => {
      if (isDrawing) { // Only redraw if the user was in the middle of drawing
        isDrawing = false;
        previewBox = null;
        try {
          CanvasHelper.redrawCanvasWithAreas(areas);
        } catch (e) {
          console.error("[CanvasHelper] ❌ redrawCanvasWithAreas(mouseleave) 發生錯誤：", e);
        }
      }
    });

    // --- Finalize UI ---
    document.getElementById("menu-name").value = name;
    document.getElementById("new-imagemap-form").reset();
    document.getElementById("image-preview").style.display = "none";
    bootstrap.Modal.getInstance(document.getElementById("new-imagemap-modal"))?.hide();

    // --- Create new ImageMap object with image data ---
    const altText = name;
    const baseSize = { width: imageWidth, height: imageHeight };
    const actions = [...areas];

    // 如果有圖片資料（上傳的本地圖片），則暫存在物件中
    const imagemapConfig = {
      baseUrl,
      altText,
      baseSize,
      actions
    };

    if (imageData) {
      imagemapConfig.image = imageData; // 暫存圖片資料
    }

    const newImagemap = new ImageMap(imagemapConfig);
    window.currentImagemap = newImagemap;
  });

  // 綁定刪除按鈕（使用標記防止重複綁定）
  const deleteBtn = document.getElementById("delete-selected-imagemap");
  if (deleteBtn && !deleteBtn._deleteListenerAdded) {
    deleteBtn.addEventListener("click", function () {

      const btn = this;
      if (!window.currentImagemap) {
        console.warn("⚠️ [DEBUG] window.currentImagemap 為空！");
        toast.warning("請先選擇要刪除的 ImageMap");
        return;
      }

      const imagemapName = window.currentImagemap.altText || window.currentImagemap.name || "未命名";

      // 直接切換刪除標記（移除 confirm 對話框，因為會自動關閉）
      window.currentImagemap._markedForDelete = !window.currentImagemap._markedForDelete;

      // 更新按鈕文字
      btn.innerText = window.currentImagemap._markedForDelete ? "恢復刪除" : "刪除";

      // 顯示通知
      if (window.currentImagemap._markedForDelete) {
        toast.info(`已標記「${imagemapName}」為刪除`);
      } else {
        toast.info(`已恢復「${imagemapName}」`);
      }

      // 標示 thumbnail
      const idx = window.imagemaps.indexOf(window.currentImagemap);
      const thumbs = document.querySelectorAll("#imagemap-thumbnails > div");
      if (thumbs[idx]) {
        thumbs[idx].classList.toggle("bg-danger", window.currentImagemap._markedForDelete);
        thumbs[idx].classList.toggle("text-white", window.currentImagemap._markedForDelete);
        thumbs[idx].style.opacity = window.currentImagemap._markedForDelete ? "0.6" : "1.0";
        thumbs[idx].querySelector("img").style.filter = window.currentImagemap._markedForDelete ? "grayscale(100%)" : "none";
      }
    });
    deleteBtn._deleteListenerAdded = true;
  } else {
  }

  document.getElementById("create-new-imagemap")?.addEventListener("click", () => {
    areas = [];

    if (canvas && ctx) {
      try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch (e) {
        console.error("[Canvas] ❌ 清除畫布失敗：", e);
      }
    }


    document.getElementById("save-button").classList.remove("d-none");
    document.getElementById("update-button").classList.add("d-none");
    updateTable();
    document.getElementById("menu-name").value = "";
  });

  document.getElementById("save-button")?.addEventListener("click", () => {
    const result = getCurrentReplyInput();
    if (!result || !result.item) {
      toast.warning("請選擇一個有效的回覆動作");
      return;
    }

    // 從 helper 建立標準化的 action 物件
    // 注意：imagemap 的 action 格式與 richmenu/flex 不同
    const newAction = createAction(result.item, 'imagemap');

    // 取得剛剛畫的那個區域的座標
    const targetArea = areas[areas.length - 1];
    if (!targetArea || !targetArea.area) {
      toast.error("找不到目標區域，請重試");
      return;
    }

    // 組合座標和新的 action
    const finalAreaAction = {
      area: targetArea.area,
      ...newAction
    };

    // 移除 action 中不屬於 imagemap action object 的屬性
    delete finalAreaAction.label;

    // 更新 areas 陣列中的最後一個元素
    areas[areas.length - 1] = finalAreaAction;

    // 同步更新到目前的 ImageMap 物件
    const currentImagemap = window.currentImagemap;
    if (currentImagemap) {
      currentImagemap.addArea(finalAreaAction);
    }

    const editModal = bootstrap.Modal.getInstance(document.getElementById("edit-modal"));
    editModal?.hide();

    updateTable();

    try {
      CanvasHelper.redrawCanvasWithAreas(areas);
    } catch (e) {
      console.error("[CanvasHelper] ❌ redrawCanvasWithAreas(save-button) 發生錯誤：", e);
    }
  });

  document.getElementById("update-button")?.addEventListener("click", () => {
    const index = parseInt(document.getElementById("update-button").getAttribute("data-index"), 10);
    if (isNaN(index) || index < 0 || index >= areas.length) {
      toast.error("無效的編輯索引");
      return;
    }

    const result = getCurrentReplyInput();
    if (!result || !result.item) {
      toast.warning("請選擇一個有效的回覆動作");
      return;
    }

    const newAction = createAction(result.item, 'imagemap');
    const originalArea = areas[index];

    const finalAreaAction = {
      area: originalArea.area,
      ...newAction
    };
    delete finalAreaAction.label;

    // 更新 areas 陣列中的指定元素
    areas[index] = finalAreaAction;

    // 同步更新到目前的 ImageMap 物件
    const currentImagemap = window.currentImagemap;
    if (currentImagemap) {
      currentImagemap.actions[index] = finalAreaAction;
      currentImagemap.isUpdated = true;
    }

    const editModal = bootstrap.Modal.getInstance(document.getElementById("edit-modal"));
    editModal?.hide();
    updateTable();

    try {
      CanvasHelper.redrawCanvasWithAreas(areas);
    } catch (e) {
      console.error("[CanvasHelper] ❌ redrawCanvasWithAreas(update-button) 發生錯誤：", e);
    }
  });

  document.getElementById("save-edited-imagemap")?.addEventListener("click", () => {
    // 在此區塊內補上同步 areas 到 currentImagemap.actions 的程式碼
    if (window.currentImagemap) {
      window.currentImagemap.actions = [...areas]; // 更新 actions
      window.currentImagemap.isUpdated = true;
      window.imagemaps = window.imagemaps || [];
      // 新增 alert 提示儲存/更新
      const message = window.imagemaps.includes(window.currentImagemap)
        ? "✅ 已更新 ImageMap！"
        : "✅ 已儲存新增的 ImageMap！";
      toast.warning(message);
      if (!window.imagemaps.includes(window.currentImagemap)) {
        window.imagemaps.push(window.currentImagemap);
      }
    }

    // 新增更新縮圖區的邏輯
    const thumbnailArea = document.getElementById("imagemap-thumbnails");
    if (thumbnailArea) {
      thumbnailArea.innerHTML = ""; // 清空
      window.imagemaps.forEach((imagemap, idx) => {
        const thumb = document.createElement("div");
        thumb.className = "mb-2 p-2 border rounded bg-light";
        thumb.innerText = `${idx + 1}. ${imagemap.altText}${imagemap.isNew ? "（新建）" : imagemap.isUpdated ? "（已修改）" : ""}`;
        const img = document.createElement("img");
        img.src = imagemap.baseUrl;
        img.alt = imagemap.altText;
        img.style.maxWidth = "100%";
        img.style.height = "auto";
        thumb.appendChild(img);

        thumb.addEventListener("click", () => {
          const selected = window.imagemaps[idx];
          if (!selected) {
            console.warn("⚠️ [DEBUG] 找不到 imagemap，索引:", idx);
            return;
          }

          areas = selected.actions.map(a => ({ ...a })); // 複製
          document.getElementById("menu-name").value = selected.altText;

          canvas.width = selected.baseSize.width;
          canvas.height = selected.baseSize.height;

          imagePreview.onload = () => {
            try {
              CanvasHelper.init(canvas, ctx, 1, imagePreview);
              CanvasHelper.redrawCanvasWithAreas(areas);
              updateTable();
            } catch (e) {
              console.error("⚠️ 畫布載入失敗：", e);
            }
          };
          imagePreview.src = selected.baseUrl;

          window.currentImagemap = selected;
        });

        thumbnailArea.appendChild(thumb);
      });
    }
  });

  // ✅ 綁定 Imagemap 搜尋功能
  const imagemapSearchInput = document.getElementById("imagemap-search");
  const clearImagemapSearchBtn = document.getElementById("clear-imagemap-search");

  imagemapSearchInput?.addEventListener("input", (e) => {
    filterImagemapList(e.target.value);
  });

  clearImagemapSearchBtn?.addEventListener("click", () => {
    if (imagemapSearchInput) {
      imagemapSearchInput.value = "";
      filterImagemapList("");
    }
  });
}
// 新增：上傳所有 imagemaps 到 Cloudflare Worker
document.getElementById("upload-imagemap")?.addEventListener("click", async () => {
  const userId = getUserId();
  if (!userId) return toast.error("無法取得使用者 ID");

  if (!window.imagemaps || !window.imagemaps.length) {
    return toast.warning("尚無任何 ImageMap 可上傳");
  }

  const uploadBtn = document.getElementById("upload-imagemap");
  await withButtonLoading(uploadBtn, async () => {
    // 檢查每個 imagemap 是否都有圖片來源（baseUrl 或 image.file）
    for (const imap of window.imagemaps) {
      if (!imap._markedForDelete) {
        // 必須至少有 baseUrl（網址）或 image.file（上傳的檔案）其中之一
        const hasImageSource = imap.baseUrl || (imap.image && imap.image.file);

        if (!hasImageSource) {
          toast.warning(`ImageMap "${imap.altText || '未命名'}" 缺少圖片來源，請上傳圖片或提供圖片網址`);
          return;
        }
      }
    }


    // 上傳圖片到伺服器 (處理所有 base64 圖片)
    for (const imap of window.imagemaps) {
      if (imap._markedForDelete) continue;

      // ✅ 檢查 baseUrl 是否為 base64，如果是就上傳
      if (imap.baseUrl && imap.baseUrl.startsWith('data:image/')) {
        try {

          // 從 image 屬性或直接從 baseUrl 取得 base64 資料
          const base64Data = (imap.image && imap.image.base64) || imap.baseUrl;
          const filename = (imap.image && imap.image.file && imap.image.file.name) || `${Date.now()}_imagemap.jpg`;

          const uploadedUrl = await uploadImage(base64Data, filename);

          // ✅ 將上傳後的 URL 設為 baseUrl
          imap.baseUrl = uploadedUrl;

          // ✅ 清除暫存的圖片資料（因為已經上傳完成）
          delete imap.image;

        } catch (err) {
          console.error(`❌ ImageMap "${imap.altText}" 圖片上傳失敗:`, err);
          toast.error(`上傳圖片失敗 (${imap.altText}): ${err.message || err}`);
          return; // 中斷上傳
        }
      }
    }

    // ✅ 最終檢查：確保所有 imagemap 的 baseUrl 都不是 base64
    for (const imap of window.imagemaps) {
      if (imap._markedForDelete) continue;

      if (imap.baseUrl && imap.baseUrl.startsWith('data:image/')) {
        console.error(`❌ ImageMap "${imap.altText}" 的 baseUrl 仍為 base64，上傳失敗`);
        toast.error(`錯誤：ImageMap "${imap.altText}" 的圖片上傳失敗，請重試`);
        return; // 中斷上傳
      }
    }

    // 過濾掉被標記刪除的 imagemap
    const filteredImagemaps = [];
    for (const imap of window.imagemaps) {
      if (!imap._markedForDelete) {
        filteredImagemaps.push(imap);
      }
    }

    try {
      const response = await fetch(`${apiBase}/imagemap/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": userId
        },
        body: JSON.stringify({ imagemaps: filteredImagemaps.map(i => i.toJSON()) })
      });

      const result = await response.json();
      if (response.ok) {
        toast.success("上傳成功：" + (result.message || ""));
      } else {
        toast.error("上傳失敗：" + (result.error || "未知錯誤"));
      }
    } catch (err) {
      console.error("[upload-imagemap] 上傳錯誤：", err);
      toast.error("上傳失敗：" + (err.message || JSON.stringify(err)));
    }
  }, '上傳中...');
});