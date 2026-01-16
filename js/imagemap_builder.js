
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
} from "../helper/message.helper.js?v=1763312843";
import { getUserId } from '../helper/state.js';
import { api } from '../helper/api.client.js';
import { setInnerHTML } from '../helper/security.js';

import { showLoader, hideLoader } from './shared/loader.js';
import { setUserId, apiBase } from "../helper/state.js";

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
    return {
      type: this.type,
      baseUrl: this.baseUrl,
      altText: this.altText,
      baseSize: this.baseSize,
      actions: this.actions,
      ...(this.video ? { video: this.video } : {}),
      ...(this.deletehash ? { deletehash: this.deletehash } : {})
    };
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

  // 監聽圖片上傳
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
      alert(error.message);
      e.target.value = '';
      previewAreaImagePreview.src = "";
      previewAreaImagePreview.style.display = "none";
      processedImageFile = null;
      window.latestBase64Image = null;
    } finally {
      hideLoader();
    }
  });

  // 綁定新增加的「選擇檔案」按鈕
  document.getElementById("trigger-image-upload")?.addEventListener("click", () => {
    imageInput?.click(); // 觸發隱藏的檔案輸入框點擊事件
  });


  // 更新區域資料表格
  function updateTable() {
    setInnerHTML(areasTable, '');

    areas.forEach((a, idx) => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.style.transition = 'background-color 0.2s';

      // Hover 效果
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = '#f8f9fa';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = '';
      });

      // 第1欄: 序號
      const cell1 = document.createElement('td');
      cell1.className = 'text-center';
      cell1.textContent = idx + 1;

      // 第2欄: 座標與尺寸
      const cell2 = document.createElement('td');
      cell2.style.fontSize = '0.85rem';
      const x = a.area?.x ?? 0;
      const y = a.area?.y ?? 0;
      const width = a.area?.width ?? 0;
      const height = a.area?.height ?? 0;

      // 第一行: X, Y
      const line1 = document.createElement('div');
      const xLabel = document.createElement('strong');
      xLabel.textContent = 'X:';
      line1.appendChild(xLabel);
      line1.appendChild(document.createTextNode(` ${x}, `));
      const yLabel = document.createElement('strong');
      yLabel.textContent = 'Y:';
      line1.appendChild(yLabel);
      line1.appendChild(document.createTextNode(` ${y}`));

      // 第二行: W, H
      const line2 = document.createElement('div');
      line2.className = 'text-muted';
      const wLabel = document.createElement('strong');
      wLabel.textContent = 'W:';
      line2.appendChild(wLabel);
      line2.appendChild(document.createTextNode(` ${width}, `));
      const hLabel = document.createElement('strong');
      hLabel.textContent = 'H:';
      line2.appendChild(hLabel);
      line2.appendChild(document.createTextNode(` ${height}`));

      cell2.appendChild(line1);
      cell2.appendChild(line2);

      // 第3欄: 類型
      const cell3 = document.createElement('td');
      const typeConfig = {
        uri: { icon: '🔗', label: '網址', color: 'primary' },
        message: { icon: '💬', label: '文字訊息', color: 'success' },
        postback: { icon: '📦', label: '回傳', color: 'info' }
      };
      const config = typeConfig[a.type] || { icon: '❓', label: a.type, color: 'secondary' };
      const badge = document.createElement('span');
      badge.className = `badge bg-${config.color}`;
      badge.style.fontSize = '0.85rem';
      badge.textContent = `${config.icon} ${config.label}`;
      cell3.appendChild(badge);

      // 第4欄: 內容
      const cell4 = document.createElement('td');
      cell4.style.maxWidth = '300px';
      cell4.style.overflow = 'hidden';
      cell4.style.textOverflow = 'ellipsis';
      cell4.style.whiteSpace = 'nowrap';

      let contentDisplay = '';
      if (a.type === 'uri') {
        contentDisplay = a.linkUri || a.uri || '';
      } else if (a.type === 'message') {
        contentDisplay = a.text || '';
      } else {
        contentDisplay = a.text || a.data || '';
      }
      cell4.title = contentDisplay;
      cell4.textContent = contentDisplay;

      // 第5欄: 操作按鈕
      const cell5 = document.createElement('td');
      cell5.className = 'text-center';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-outline-primary me-1';
      editBtn.title = '編輯';
      editBtn.textContent = '✏️';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editArea(idx);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-outline-danger';
      deleteBtn.title = '刪除';
      deleteBtn.textContent = '🗑️';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeArea(idx);
      });

      cell5.appendChild(editBtn);
      cell5.appendChild(deleteBtn);

      // 組裝
      row.appendChild(cell1);
      row.appendChild(cell2);
      row.appendChild(cell3);
      row.appendChild(cell4);
      row.appendChild(cell5);

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
    setInnerHTML(replyContainer, '<p class="text-muted">載入中...</p>'); // 顯示載入狀態

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

    setInnerHTML(replyContainer, '');
    replyContainer.appendChild(ui);

    // 隱藏「儲存」按鈕，顯示「更新」按鈕
    document.getElementById("save-button").classList.add("d-none");
    document.getElementById("update-button").classList.remove("d-none");
    document.getElementById("update-button").setAttribute("data-index", index);
  };



  let previewURL = "";

  document.getElementById("preview-image-url")?.addEventListener("click", () => {
    previewURL = document.getElementById("new-image-url").value.trim();
    if (!previewURL) return alert("請輸入圖片網址");


    let imagePreview1 = document.getElementById("image-preview");
    imagePreview.onload = () => {
      imagePreview1.style.display = "block"
      imagePreview1.src = previewURL;


      // //   canvas.width = imagePreview.width;
      // //   canvas.height = imagePreview.height;

      // //   try {
      // //     CanvasHelper.init(canvas, ctx, 1, imagePreview);
      // //     CanvasHelper.redrawCanvasWithAreas([]);
      // //   } catch (e) {
      // //     console.error("[CanvasHelper] ❌ Canvas 操作失敗：", e);
      // //   }
    };
    imagePreview.src = previewURL;
  });

  document.getElementById("confirm-new-imagemap")?.addEventListener("click", () => {

    const name = document.getElementById("new-menu-name").value.trim();
    if (!name) {
      return alert("請輸入圖文訊息名稱");
    }

    const previewAreaImagePreview = document.getElementById("image-preview");
    const baseUrl = previewAreaImagePreview.src;

    if (!baseUrl || baseUrl === window.location.href) {
      return alert("請先上傳圖片或提供圖片網址");
    }

    // --- NEW LOGIC: Directly use the preview image's properties ---
    const imageWidth = previewAreaImagePreview.naturalWidth;
    const imageHeight = previewAreaImagePreview.naturalHeight;

    if (!imageWidth || !imageHeight) {
      console.error("[Confirm Click] 錯誤：無法從預覽圖片取得尺寸 (naturalWidth/naturalHeight)。");
      alert("錯誤：無法讀取圖片尺寸，請嘗試重新上傳圖片。");
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
      alert("Canvas 操作失敗，請查看控制台。");
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
      previewBox = { area: { x: startX, y: startY, width, height }, type: "message", data: "預設文字" };
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
          alert("新框框與既有區塊重疊，已取消新增。");
        } else {
          areas.push(normalizedBox);
          updateTable();
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
    const newImagemapModal = bootstrap.Modal.getInstance(document.getElementById("new-imagemap-modal"));
    if (newImagemapModal) {
      newImagemapModal.hide();
      setTimeout(() => {
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
      }, 300);
    }

    // --- Create new ImageMap object ---
    const altText = name;
    const baseSize = { width: imageWidth, height: imageHeight };
    const actions = [...areas];
    const newImagemap = new ImageMap({ baseUrl, altText, baseSize, actions });
    window.currentImagemap = newImagemap;
  });

  document.getElementById("delete-selected-imagemap")?.addEventListener("click", function () {
    const btn = this;
    if (!window.currentImagemap) return;

    window.currentImagemap._markedForDelete = !window.currentImagemap._markedForDelete;

    // 更新按鈕文字
    btn.innerText = window.currentImagemap._markedForDelete ? "恢復刪除" : "刪除選單";

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
      alert("請選擇一個有效的回覆動作");
      return;
    }

    // 從 helper 建立標準化的 action 物件
    // 注意：imagemap 的 action 格式與 richmenu/flex 不同
    const newAction = createAction(result.item, 'imagemap');

    // 取得剛剛畫的那個區域的座標
    const targetArea = areas[areas.length - 1];
    if (!targetArea || !targetArea.area) {
      alert("找不到目標區域，請重試");
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
    if (editModal) {
      editModal.hide();
      setTimeout(() => {
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
      }, 300);
    }

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
      alert("無效的編輯索引");
      return;
    }

    const result = getCurrentReplyInput();
    if (!result || !result.item) {
      alert("請選擇一個有效的回覆動作");
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
    if (editModal) {
      editModal.hide();
      setTimeout(() => {
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
      }, 300);
    }
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
      alert(message);
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
          if (!selected) return;

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
  // === 插入訊息選擇 UI ===
  // 顯示訊息選擇欄位（插入至 #reply-dynamic-fields）
  const replyFieldsContainer = document.getElementById("reply-dynamic-fields");
  if (replyFieldsContainer) {
    const builder = "imagemap";//detectBuilder();
    const dseadfa = generateReplyInputUI({
      builder,
      userId: getUserId(),
      onSelect: (type, item) => {
        // 預設將文字帶入下方表單欄位
        const input = document.getElementById("data-input");
        if (input && item.text) {
          input.value = item.text;
        }
      }
    }).then((ui) => {
      replyFieldsContainer.appendChild(ui);
    });
  }
}
// 新增：上傳所有 imagemaps 到 Cloudflare Worker
document.getElementById("upload-imagemap")?.addEventListener("click", async () => {
  const userId = getUserId();
  if (!userId) return alert("⚠️ 無法取得使用者 ID");

  if (!window.imagemaps || !window.imagemaps.length) {
    return alert("⚠️ 尚無任何 ImageMap 可上傳");
  }

  // 1. 先檢查 baseUrl 是否為 base64，若是則上傳到 WordPress Worker 並替換
  for (const imap of window.imagemaps) {
    if (typeof imap.baseUrl === "string" && imap.baseUrl.startsWith("data:image/")) {
      try {
        // 優先使用 window.latestBase64Image 作為上傳來源
        const rawBase64 = window.latestBase64Image || imap.baseUrl;
        const newUrl = await uploadImage(rawBase64, `${Date.now()}_imagemap.jpg`);
        imap.baseUrl = newUrl;
      } catch (err) {
        console.error("❌ WordPress Worker 上傳失敗，跳過此圖像：", err);
        alert("❌ 上傳圖片失敗：" + (err.message || err));
        return;
      }
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
    const formData = { imagemaps: filteredImagemaps.map(i => i.toJSON()) };
    const result = await api.post('/imagemap/save', formData);

    if (result.success) {
      alert("✅ 上傳成功：" + (result.message || ""));
    } else {
      alert("❌ 上傳失敗：" + (result.error || "未知錯誤"));
    }
  } catch (err) {
    console.error("[upload-imagemap] 上傳錯誤：", err);
    alert("❌ 上傳失敗：" + (err.message || JSON.stringify(err)));
  }
});