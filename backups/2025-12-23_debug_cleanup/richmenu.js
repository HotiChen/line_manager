

import { showLoader, hideLoader } from './shared/loader.js';
import { setInnerHTML } from "../helper/security.js";
import { processImageFor } from './image.helper.js';
import { getUserId, setUserId, apiBase } from "../helper/state.js";
import {
  detectBuilder,
  getSupportedMsgTypes,
  getSavedMessages,
  formatMessagePreview,
  messageTypeLabels,
  fetchMessageListByType,
  generateMessagePreviewHTML,
  getMessageTypeIcon,
  createAction,
  generateReplyInputUI,
  getCurrentReplyInput,
  clearMessageCache,
  refreshMessageType,
  searchMessages,
  fetchRichMenuDetails,
  MessageFactory
} from "../helper/message.helper.js";

import { toast, withButtonLoading } from "../helper/toast.js";

// ====== 🌐 全域變數區 ======
const canvas = document.getElementById('uploaded-image-canvas');
const ctx = canvas.getContext('2d');
const imageUpload = document.getElementById('image-upload');



let allRichmenus = [];
let currentRichmenu = null; // 👈 目前選中的 Richmenu（供編輯時使用）
let img = new Image();
let currentArea = null;
let drawing = false;
let startPoint = null;
let endPoint = null;
let selectedAreas = [];
let imgDiamenions = [];
let defaultRichmenuId = null;


let isCloningRichmenu = false;
let cloneSourceRichmenu = null;
let cloningRichmenuAreas = [];
let processedImageFile = null; // To store the processed image file

const scaleFactor = 0.3; // 根據實際圖片大小和顯示大小計算縮放比例

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

class Richmenu {
  constructor(name, diamention, imageUrl, imageID, alias, areas, chatBarText, selected, imageFile = null) {
    this.name = name;
    this.diamention = diamention;
    this.imageUrl = imageUrl;
    this.imageID = imageID;
    this.alias = alias;
    this.areas = areas;
    this.chatBarText = chatBarText;
    this.selected = selected;
    this.imageFile = imageFile;

    this.isDefault = false;
    this.isUpdated = false;
    this.isNew = false;
    this.isDeleted = false;
  }
}

// ====== 🌐 全域變數區結束 ======

function resetUIState() {
  selectedAreas = [];
  currentArea = null;

  sessionStorage.removeItem("areas");
  sessionStorage.setItem("currentAreas", "[]");
  sessionStorage.setItem("currentImage", "");
  sessionStorage.setItem("selectedIndex", "-1");

  document.getElementById("menu-name").value = "";
  clearCanvas();

  const cloneIndicatorEl = document.getElementById("clone-indicator");
  if (cloneIndicatorEl) {
    cloneIndicatorEl.classList.add("d-none");
    cloneIndicatorEl.textContent = "複製";
  }
  isCloningRichmenu = false;
  cloneSourceRichmenu = null;
  cloningRichmenuAreas = [];

  const areasTableBody = document.getElementById("areas-table").querySelector("tbody");
  areasTableBody.innerHTML = "";

  document.querySelectorAll(".richmenu-thumbnail-container").forEach(container => {
    container.setAttribute("data-selected", "false");
    container.style.backgroundColor = "#00000022";
  });
}

function convertImageToDataURL(image) {
  return new Promise((resolve, reject) => {
    if (!image || !(image instanceof File)) {
      reject(new Error('Invalid image file'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.onerror = (error) => {
      reject(new Error('Failed to read image file: ' + error.message));
    };
    reader.readAsDataURL(image);
  });
}

function isOverlap(rect1, rect2) {
  const getPoints = (rect) => {
    if (rect.bounds) {
      const { x, y, width, height } = rect.bounds;
      return {
        startPoint: { x: x * scaleFactor, y: y * scaleFactor },
        endPoint: { x: (x + width) * scaleFactor, y: (y + height) * scaleFactor }
      };
    } else if (rect.startPoint && rect.endPoint) {
      return {
        startPoint: rect.startPoint,
        endPoint: rect.endPoint
      };
    } else {
      console.error("無效的區域數據結構:", rect);
      return null;
    }
  };

  const points1 = getPoints(rect1);
  const points2 = getPoints(rect2);

  if (!points1 || !points2) {
    return false;
  }

  return (
    points1.startPoint.x < points2.endPoint.x &&
    points1.endPoint.x > points2.startPoint.x &&
    points1.startPoint.y < points2.endPoint.y &&
    points1.endPoint.y > points2.startPoint.y
  );
}

function isValidArea(newArea) {
  if (
    newArea.startPoint.x < 0 ||
    newArea.startPoint.y < 0 ||
    newArea.endPoint.x > canvas.width ||
    newArea.endPoint.y > canvas.height
  ) {
    return false;
  }

  for (const area of selectedAreas) {
    if (isOverlap(area, newArea)) {
      return false;
    }
  }

  return true;
}

function isMouseInsideCanvas(point) {
  return (
    point.x >= 0 &&
    point.x <= canvas.width &&
    point.y >= 0 &&
    point.y <= canvas.height
  );
}

async function openEditModal(area, index) {
  const modalEl = document.getElementById("edit-modal");
  const modal = new bootstrap.Modal(modalEl);
  const container = document.getElementById("richmenu-action-editor-container");
  const saveBtn = document.getElementById("save-action-button");
  const deleteBtn = document.getElementById("delete-button");

  // 取得 userId
  const userId = getUserId();

  // 1. 準備並產生 UI
  setInnerHTML(container, `<p class="text-muted">載入中...</p>`);
  modal.show();

  const initialReply = (index !== -1 && area.action) ? area.action : null;

  // 使用 helper 產生動態 UI
  const ui = await generateReplyInputUI({
    builder: 'richmenu',
    userId,
    initialReply,
    customData: {
      richmenus: allRichmenus,
      currentMenuName: currentRichmenu?.name || ''
    }
  });
  setInnerHTML(container, '');
  container.appendChild(ui);

  // 2. 處理儲存按鈕點擊事件
  // 透過複製再取代的方式，移除所有舊的監聽器，避免重複綁定
  saveBtn.replaceWith(saveBtn.cloneNode(true));
  const newSaveBtn = document.getElementById("save-action-button");

  newSaveBtn.onclick = () => {
    const reply = getCurrentReplyInput(); // 從 helper 取得輸入結果
    if (!reply || !reply.item) {
      toast.warning("請輸入或選擇有效的動作內容。");
      return;
    }

    // 即時輸入驗證
    if (reply.type === 'uri') {
      try {
        // 使用 new URL() 來驗證是否為一個合法的絕對路徑網址
        new URL(reply.item.uri);
      } catch (e) {
        toast.warning("您輸入的連結不是一個有效的網址，請確認包含 https://");
        return;
      }
    }

    const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");

    if (index === -1) { // 新增區域
      area.action = reply.item;
      currentAreas.push(area);
    } else { // 更新現有區域
      if (currentAreas[index]) {
        currentAreas[index].action = reply.item;
      }
    }

    sessionStorage.setItem("currentAreas", JSON.stringify(currentAreas));
    redrawCanvasWithAreas();
    updateAreasTable();
    modal.hide();
  };

  // 3. 處理刪除按鈕點擊事件
  deleteBtn.replaceWith(deleteBtn.cloneNode(true));
  const newDeleteBtn = document.getElementById("delete-button");

  if (index === -1) {
    // 如果是新增區域，沒有什麼可以刪的，隱藏按鈕
    newDeleteBtn.style.display = 'none';
  } else {
    newDeleteBtn.style.display = 'inline-block';
    newDeleteBtn.onclick = () => {
      // 使用 Modal 確認刪除
      const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");
      const areaInfo = currentAreas[index];
      const areaNum = index + 1;


      // 設定 Modal 內容
      const deleteAreaInfo = document.getElementById('delete-area-info');

      // 取得動作資訊
      const action = areaInfo.action || {};
      let actionText = '無動作';
      let contentText = '-';

      // 根據動作類型設定顯示文字
      switch (action.type) {
        case 'uri':
          actionText = '🔗 開啟網址';
          contentText = action.uri || '-';
          break;
        case 'message':
          actionText = '💬 發送訊息';
          contentText = action.text || '-';
          break;
        case 'postback':
          actionText = '📤 Postback';
          contentText = '不顯示';
          break;
        case 'richmenuswitch':
          actionText = '📱 切換選單';
          // 優先顯示 label（richmenu 名稱）
          if (action.label) {
            contentText = action.label;
          } else if (action.richMenuAliasId) {
            // 如果沒有 label，嘗試從 allRichmenus 中查找對應的名稱
            const targetMenu = allRichmenus.find(m => m.alias === action.richMenuAliasId);
            contentText = targetMenu ? targetMenu.name : action.richMenuAliasId;
          } else if (action.data) {
            // 最後嘗試用 data 查找
            const targetRichmenu = allRichmenus.find(rm => rm.richMenuId === action.data);
            contentText = targetRichmenu ? targetRichmenu.name : action.data;
          } else {
            contentText = action.richMenuId || '-';
          }
          break;
        default:
          actionText = '無動作';
          contentText = '-';
      }

      // 組合顯示內容
      const infoText = `區域 ${areaNum}
座標：(${areaInfo.bounds.x}, ${areaInfo.bounds.y})
尺寸：${areaInfo.bounds.width} x ${areaInfo.bounds.height}
功能：${actionText}
內容：${contentText}`;

      deleteAreaInfo.textContent = infoText;
      deleteAreaInfo.style.whiteSpace = 'pre-line';


      // 顯示 Modal
      const deleteModal = new bootstrap.Modal(document.getElementById('confirm-delete-area-modal'));

      // 移除舊的事件監聽器
      const confirmBtn = document.getElementById('confirm-delete-area-btn');
      const newConfirmBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

      // 綁定確認刪除事件
      document.getElementById('confirm-delete-area-btn').addEventListener('click', function () {
        currentAreas.splice(index, 1);
        sessionStorage.setItem("currentAreas", JSON.stringify(currentAreas));

        redrawCanvasWithAreas();
        updateAreasTable();
        modal.hide();
        deleteModal.hide();

        // 顯示成功通知
        toast.success(`已刪除區域 ${areaNum}`);
      });

      deleteModal.show();
    };
  }
}

canvas.addEventListener('mousedown', (e) => {
  const clickPoint = getMousePos(e);
  const areas = JSON.parse(sessionStorage.getItem("currentAreas")) || [];

  for (let index = 0; index < areas.length; index++) {
    const area = areas[index];
    let startX, startY, width, height;

    if (area.bounds) {
      startX = area.bounds.x * scaleFactor;
      startY = area.bounds.y * scaleFactor;
      width = area.bounds.width * scaleFactor;
      height = area.bounds.height * scaleFactor;
    } else if (area.startPoint && area.endPoint) {
      startX = area.startPoint.x;
      startY = area.startPoint.y;
      width = area.endPoint.x - area.startPoint.x;
      height = area.endPoint.y - area.startPoint.y;
    } else {
      console.error("無效的區域數據結構:", area);
      continue;
    }

    if (
      clickPoint.x >= startX &&
      clickPoint.x <= startX + width &&
      clickPoint.y >= startY &&
      clickPoint.y <= startY + height
    ) {
      openEditModal(area, index);
      return;
    }
  }

  drawing = true;
  startPoint = clickPoint;
});

const mouseCoordsEl = document.getElementById("mouse-coords");
canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;

  const mousePos = getMousePos(e);

  mouseCoordsEl.style.display = "block";
  mouseCoordsEl.style.left = (e.clientX + 10) + "px";
  mouseCoordsEl.style.top = (e.clientY + 10) + "px";
  mouseCoordsEl.textContent = `(${Math.round(mousePos.x)}, ${Math.round(mousePos.y)})`;

  if (!isMouseInsideCanvas(mousePos)) return;

  const rectStartPoint = {
    x: Math.min(startPoint.x, mousePos.x),
    y: Math.min(startPoint.y, mousePos.y),
  };
  const rectWidth = Math.abs(mousePos.x - startPoint.x);
  const rectHeight = Math.abs(mousePos.y - startPoint.y);

  const tempArea = {
    startPoint: rectStartPoint,
    endPoint: {
      x: rectStartPoint.x + rectWidth,
      y: rectStartPoint.y + rectHeight,
    },
  };

  if (!isValidArea(tempArea)) return;

  redrawCanvasWithAreas();

  ctx.beginPath();
  ctx.setLineDash([6]);
  ctx.rect(rectStartPoint.x, rectStartPoint.y, rectWidth, rectHeight);
  ctx.strokeStyle = "red";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
});

canvas.addEventListener('mouseup', (e) => {
  mouseCoordsEl.style.display = "none";
  drawing = false;

  endPoint = getMousePos(e);

  const existingAreas = JSON.parse(sessionStorage.getItem("currentAreas")) || [];

  if (existingAreas.length >= 20) {
    toast.warning('最多只能選取20個區域');
    return;
  }

  const rectStartPoint = {
    x: Math.round(Math.min(startPoint.x, endPoint.x)),
    y: Math.round(Math.min(startPoint.y, endPoint.y)),
  };
  const rectWidth = Math.round(Math.abs(endPoint.x - startPoint.x));
  const rectHeight = Math.round(Math.abs(endPoint.y - startPoint.y));

  if (rectWidth < 100 || rectHeight < 10) {
    toast.warning("您的框框太小囉 ");
    return;
  }

  const newArea = {
    bounds: {
      x: Math.round(rectStartPoint.x / scaleFactor),
      y: Math.round(rectStartPoint.y / scaleFactor),
      width: Math.round(rectWidth / scaleFactor),
      height: Math.round(rectHeight / scaleFactor)
    },
    action: MessageFactory.empty('uri')  // ✅ 使用 MessageFactory 統一格式

  };

  let hasOverlap = false;
  for (const area of existingAreas) {
    if (isOverlap(area, newArea)) {
      hasOverlap = true;
      break;
    }
  }

  if (hasOverlap) {
    toast.warning('區域不能重疊');
    return;
  }

  ctx.beginPath();
  ctx.rect(rectStartPoint.x, rectStartPoint.y, rectWidth, rectHeight);
  ctx.strokeStyle = 'red';
  ctx.lineWidth = 2;
  ctx.stroke();

  currentArea = newArea;

  openEditModal(newArea, -1);
});

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function clearCanvas() {
  const canvas = document.getElementById("uploaded-image-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}



function drawRectangles(areas = null) {
  const canvas = document.getElementById("uploaded-image-canvas");
  const ctx = canvas.getContext("2d");

  if (!areas) {
    areas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");
  }

  areas.forEach((area, index) => {
    let startX, startY, width, height;

    if (area.bounds) {
      startX = area.bounds.x * scaleFactor;
      startY = area.bounds.y * scaleFactor;
      width = area.bounds.width * scaleFactor;
      height = area.bounds.height * scaleFactor;
    } else if (area.startPoint && area.endPoint) {
      startX = area.startPoint.x;
      startY = area.startPoint.y;
      width = area.endPoint.x - area.startPoint.x;
      height = area.endPoint.y - area.startPoint.y;

      area.bounds = {
        x: Math.round(startX / scaleFactor),
        y: Math.round(startY / scaleFactor),
        width: Math.round(width / scaleFactor),
        height: Math.round(height / scaleFactor)
      };
      delete area.startPoint;
      delete area.endPoint;
    } else {
      console.error(`[drawRectangles] 無效的區域數據結構:`, area);
      return;
    }

    ctx.fillStyle = "rgba(255, 0, 0, 0.3)";
    ctx.fillRect(startX, startY, width, height);

    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, startY, width, height);

    ctx.fillStyle = "#ff0000";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      index + 1,
      startX + width / 2,
      startY + height / 2
    );
  });

  sessionStorage.setItem("currentAreas", JSON.stringify(areas));
}

function redrawCanvasWithAreas(areas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  drawRectangles(areas);
}

function updateAreasTable() {
  const tableBody = document.querySelector('#areas-table tbody');
  setInnerHTML(tableBody, '');

  const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");

  // 定義類型的圖示和顏色配置
  const typeConfig = {
    uri: { icon: '🔗', label: '網址', color: 'primary' },
    message: { icon: '💬', label: '文字', color: 'success' },
    postback: { icon: '📦', label: '回傳', color: 'info' },
    richmenuswitch: { icon: '🔄', label: '切換選單', color: 'warning' },
    keyword: { icon: '🔑', label: '關鍵字', color: 'secondary' }
  };

  currentAreas.forEach((area, index) => {
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

    // 點擊整行編輯
    row.addEventListener('click', (e) => {
      if (!e.target.closest('button')) {
        openEditModal(area, index);
      }
    });

    // 獲取座標資訊
    let x, y, width, height;
    if (area.bounds) {
      x = Math.round(area.bounds.x);
      y = Math.round(area.bounds.y);
      width = Math.round(area.bounds.width);
      height = Math.round(area.bounds.height);
    } else if (area.startPoint && area.endPoint) {
      x = Math.round(area.startPoint.x / scaleFactor);
      y = Math.round(area.startPoint.y / scaleFactor);
      width = Math.round((area.endPoint.x - area.startPoint.x) / scaleFactor);
      height = Math.round((area.endPoint.y - area.startPoint.y) / scaleFactor);
    }

    // 獲取動作資訊
    const action = area.action || {};
    const actionType = action.type || "uri";
    const config = typeConfig[actionType] || { icon: '❓', label: actionType, color: 'secondary' };

    let actionDisplay = "";
    switch (actionType) {
      case "uri":
        actionDisplay = action.uri || action.data || "";
        break;
      case "message":
        actionDisplay = action.text || action.data || "";
        break;
      case "keyword":
        actionDisplay = action.keyword || action.text || action.data || "";
        break;
      case "postback":
        actionDisplay = "不顯示";
        break;
      case "richmenuswitch":
        // 優先顯示 label（richmenu 名稱）
        if (action.label) {
          actionDisplay = action.label;
        } else if (action.richMenuAliasId) {
          // 如果沒有 label，嘗試從 allRichmenus 中查找對應的名稱
          const targetMenu = allRichmenus.find(m => m.alias === action.richMenuAliasId);
          actionDisplay = targetMenu ? targetMenu.name : action.richMenuAliasId;
        } else {
          actionDisplay = action.richMenuId || "";
        }
        break;
      default:
        actionDisplay = action.data || action.uri || action.text || "";
    }

    // 截斷過長的內容
    const maxLength = 40;
    const displayText = actionDisplay.length > maxLength
      ? actionDisplay.substring(0, maxLength) + '...'
      : actionDisplay;

    // 建立表格內容
    row.innerHTML = `
      <td class="text-center" style="width: 40px;">
        <span class="badge bg-secondary rounded-circle">${index + 1}</span>
      </td>
      <td style="width: 140px; font-size: 0.85rem; color: #6c757d;">
        <div>📍 (${x}, ${y})</div>
        <div style="font-size: 0.75rem;">📐 ${width} × ${height}</div>
      </td>
      <td style="width: 120px;">
        <span class="badge bg-${config.color}" style="font-size: 0.85rem;">
          ${config.icon} ${config.label}
        </span>
      </td>
      <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" 
          title="${actionDisplay}">
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

    // 重新綁定按鈕事件（因為使用了 innerHTML）
    const editBtn = row.querySelector('.btn-outline-primary');
    const deleteBtn = row.querySelector('.btn-outline-danger');

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(area, index);
    });


    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();

      // 使用 Modal 確認刪除
      const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");
      const areaInfo = currentAreas[index];
      const areaNum = index + 1;

      // 設定 Modal 內容
      const deleteAreaInfo = document.getElementById('delete-area-info');

      // 取得動作資訊
      const action = areaInfo.action || {};
      let actionText = '無動作';
      let contentText = '-';

      // 根據動作類型設定顯示文字
      switch (action.type) {
        case 'uri':
          actionText = '🔗 開啟網址';
          contentText = action.uri || '-';
          break;
        case 'message':
          actionText = '💬 發送訊息';
          contentText = action.text || '-';
          break;
        case 'postback':
          actionText = '📤 Postback';
          contentText = '不顯示';
          break;
        case 'richmenuswitch':
          actionText = '📱 切換選單';
          // 優先顯示 label（richmenu 名稱）
          if (action.label) {
            contentText = action.label;
          } else if (action.richMenuAliasId) {
            // 如果沒有 label，嘗試從 allRichmenus 中查找對應的名稱
            const targetMenu = allRichmenus.find(m => m.alias === action.richMenuAliasId);
            contentText = targetMenu ? targetMenu.name : action.richMenuAliasId;
          } else if (action.data) {
            // 最後嘗試用 data 查找
            const targetRichmenu = allRichmenus.find(rm => rm.richMenuId === action.data);
            contentText = targetRichmenu ? targetRichmenu.name : action.data;
          } else {
            contentText = action.richMenuId || '-';
          }
          break;
        default:
          actionText = '無動作';
          contentText = '-';
      }

      // 組合顯示內容
      const infoText = `區域 ${areaNum}
座標：(${areaInfo.bounds.x}, ${areaInfo.bounds.y})
尺寸：${areaInfo.bounds.width} x ${areaInfo.bounds.height}
功能：${actionText}
內容：${contentText}`;

      deleteAreaInfo.textContent = infoText;
      deleteAreaInfo.style.whiteSpace = 'pre-line';

      // 顯示 Modal
      const deleteModal = new bootstrap.Modal(document.getElementById('confirm-delete-area-modal'));

      // 移除舊的事件監聽器
      const confirmBtn = document.getElementById('confirm-delete-area-btn');
      const newConfirmBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

      // 綁定確認刪除事件
      document.getElementById('confirm-delete-area-btn').addEventListener('click', function () {
        const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");
        currentAreas.splice(index, 1);
        sessionStorage.setItem("currentAreas", JSON.stringify(currentAreas));
        redrawCanvasWithAreas();
        updateAreasTable();
        deleteModal.hide();

        // 顯示成功通知
        toast.success(`已刪除區域 ${areaNum}`);
      });

      deleteModal.show();
    });


    tableBody.appendChild(row);
  });
}

function displayRichmenuThumbnails(richmenus) {
  const container = document.getElementById("richmenu-thumbnails");
  setInnerHTML(container, "");

  richmenus.forEach((richmenu, index) => {
    const thumbnail = createRichmenuThumbnail(richmenu, index);
    container.appendChild(thumbnail);
  });
}

function createRichmenuThumbnail(richmenu, index) {
  const richmenuContainer = document.createElement("div");
  richmenuContainer.classList.add("richmenu-thumbnail-container");
  richmenuContainer.setAttribute("data-index", index);
  richmenuContainer.setAttribute("data-selected", "false");
  richmenuContainer.style.position = "relative";
  richmenuContainer.style.margin = "10px";
  richmenuContainer.style.cursor = "pointer";
  richmenuContainer.style.padding = "10px";
  richmenuContainer.style.borderRadius = "10px";
  richmenuContainer.style.backgroundColor = "#00000022";

  const isUpdated = richmenu.isUpdated || false;
  const isNew = richmenu.isNew || false;
  const isDefault = richmenu.isDefault || false;

  richmenuContainer.addEventListener("click", () => {
    document.querySelectorAll(".richmenu-thumbnail-container").forEach(container => {
      container.setAttribute("data-selected", "false");
      container.style.backgroundColor = "#00000022";
    });
    richmenuContainer.setAttribute("data-selected", "true");
    richmenuContainer.style.backgroundColor = "#A58A7B";
    loadRichmenuData(richmenu);
    redrawCanvasWithAreas();
    highlightThumbnail(richmenuContainer.querySelector("img"));
  });

  richmenuContainer.addEventListener("mouseover", () => {
    if (richmenuContainer.getAttribute("data-selected") !== "true") {
      richmenuContainer.style.backgroundColor = "#0000ff22";
    }
  });

  richmenuContainer.addEventListener("mouseout", () => {
    if (richmenuContainer.getAttribute("data-selected") !== "true") {
      richmenuContainer.style.backgroundColor = "#00000022";
    }
  });

  const richmenuName = document.createElement("div");
  richmenuName.innerText = richmenu.name;
  richmenuName.style.fontWeight = "bold";
  richmenuName.style.textAlign = "center";
  richmenuName.style.marginBottom = "5px";

  const richmenuThumbnail = document.createElement("img");
  richmenuThumbnail.src = richmenu.imageUrl;
  richmenuThumbnail.style.width = "110px";
  richmenuThumbnail.style.height = "auto";
  richmenuThumbnail.style.border = "1px solid #ccc";

  // if (richmenu.alias) {
  //   const aliasBadge = document.createElement("span");
  //   aliasBadge.textContent = `alias: ${richmenu.alias}`;
  //   aliasBadge.title = "Richmenu Alias ID";
  //   aliasBadge.style.position = "absolute";
  //   aliasBadge.style.bottom = "5px";
  //   aliasBadge.style.left = "50%";
  //   aliasBadge.style.transform = "translateX(-50%)";
  //   aliasBadge.style.backgroundColor = "#6c757d";
  //   aliasBadge.style.color = "white";
  //   aliasBadge.style.padding = "2px 6px";
  //   aliasBadge.style.borderRadius = "3px";
  //   aliasBadge.style.fontSize = "11px";
  //   richmenuContainer.appendChild(aliasBadge);
  // }

  if (isNew || isUpdated) {
    const unsyncedBadge = document.createElement("span");
    unsyncedBadge.textContent = "未同步";
    unsyncedBadge.title = "此選單有未同步的變更";
    unsyncedBadge.style.position = "absolute";
    unsyncedBadge.style.bottom = "5px";
    unsyncedBadge.style.right = "5px";
    unsyncedBadge.style.backgroundColor = "#ffc107"; // Orange/Yellow
    unsyncedBadge.style.color = "black";
    unsyncedBadge.style.padding = "2px 6px";
    unsyncedBadge.style.borderRadius = "3px";
    unsyncedBadge.style.fontSize = "12px";
    richmenuContainer.appendChild(unsyncedBadge);
  }

  if (richmenu.isDeleted) {
    const deletedBadge = document.createElement("span");
    deletedBadge.textContent = "已刪除";
    deletedBadge.title = "這是已標記為刪除的選單";
    deletedBadge.style.position = "absolute";
    deletedBadge.style.bottom = "5px";
    deletedBadge.style.left = "5px";
    deletedBadge.style.backgroundColor = "#dc3545";
    deletedBadge.style.color = "white";
    deletedBadge.style.padding = "2px 6px";
    deletedBadge.style.borderRadius = "3px";
    deletedBadge.style.fontSize = "12px";
    richmenuContainer.appendChild(deletedBadge);
  }

  if (isDefault) {
    const defaultBadge = document.createElement("span");
    defaultBadge.textContent = "預設";
    defaultBadge.title = "這是預設選單";
    defaultBadge.style.position = "absolute";
    defaultBadge.style.top = "5px";
    defaultBadge.style.left = "5px";
    defaultBadge.style.backgroundColor = "#007bff";
    defaultBadge.style.color = "white";
    defaultBadge.style.padding = "2px 6px";
    defaultBadge.style.borderRadius = "3px";
    defaultBadge.style.fontSize = "12px";
    richmenuContainer.appendChild(defaultBadge);
  }

  richmenuContainer.appendChild(richmenuName);
  richmenuContainer.appendChild(richmenuThumbnail);
  return richmenuContainer;
}

function loadRichmenuData(richmenu) {
  const cloneIndicatorEl = document.getElementById("clone-indicator");
  if (cloneIndicatorEl) {
    cloneIndicatorEl.classList.add("d-none");
    cloneIndicatorEl.textContent = "複製";
  }
  isCloningRichmenu = false;
  cloneSourceRichmenu = null;
  cloningRichmenuAreas = [];

  currentRichmenu = richmenu;

  selectedAreas = richmenu.areas.map(area => {
    if (area.bounds) {
      return {
        bounds: area.bounds,
        action: area.action || { type: "uri", uri: "" }
      };
    }
    return {
      bounds: {
        x: Math.round(area.startPoint.x / scaleFactor),
        y: Math.round(area.startPoint.y / scaleFactor),
        width: Math.round((area.endPoint.x - area.startPoint.x) / scaleFactor),
        height: Math.round((area.endPoint.y - area.startPoint.y) / scaleFactor)
      },
      action: {
        type: area.linkType || "uri",
        uri: area.data || ""
      }
    };
  });


  sessionStorage.setItem("currentAreas", JSON.stringify(selectedAreas));

  const menuNameInput = document.getElementById("menu-name");
  menuNameInput.value = richmenu.name;

  const newImg = new Image();
  newImg.onload = function () {
    if (richmenu.diamention && Array.isArray(richmenu.diamention)) {
      canvas.width = richmenu.diamention[0] * scaleFactor;
      canvas.height = richmenu.diamention[1] * scaleFactor;
    } else {
      canvas.width = newImg.width * scaleFactor;
      canvas.height = newImg.height * scaleFactor;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(newImg, 0, 0, canvas.width, canvas.height);

    img = newImg;

    redrawCanvasWithAreas();
  };

  newImg.src = richmenu.imageUrl;

  updateAreasTable();
}

function getSelectedRichmenuIndex() {
  const selected = document.querySelector("[data-selected='true']");

  if (selected) {
    return parseInt(selected.getAttribute("data-index"));
  }
  return -1;
}

function generateClonedName(baseName) {
  const existingNames = new Set(allRichmenus.map(menu => menu.name));
  let clonedName = `${baseName}-複製`;
  let counter = 1;
  while (existingNames.has(clonedName)) {
    clonedName = `${baseName}-複製${counter}`;
    counter += 1;
  }
  return clonedName;
}

export function generateDeterministicAlias(userId, suffix = "1") {
  const hash = Array.from(userId)
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 1000000, 0)
    .toString(36);
  const timestamp = Date.now();
  return `alias_${hash}_${timestamp}`;
}

function createUniqueAlieasID() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `alias-${userId}-${timestamp}-${random}`;
}


async function saveEditedRichmenu() {
  const richmenuName = document.getElementById("menu-name").value;
  if (!richmenuName) {
    toast.warning("請輸入 Richmenu 名稱");
    return;
  }

  const currentAreas = JSON.parse(sessionStorage.getItem("currentAreas") || "[]");

  const canvas = document.getElementById("uploaded-image-canvas");
  const file = document.getElementById("new-image-upload").files[0];
  const imageUrl = file ? await convertImageToDataURL(file) : canvas.toDataURL();

  const chatBarInputField = document.getElementById("new-chat-bar-text");
  const chatBarTextInput = (chatBarInputField && chatBarInputField.value.trim())
    ? chatBarInputField.value.trim()
    : (currentRichmenu?.chatBarText || "Tap to open");

  const existingIndex = allRichmenus.findIndex(menu => menu.name === currentRichmenu?.name);

  if (existingIndex !== -1) {
    const updatedMenu = allRichmenus[existingIndex];
    updatedMenu.areas = currentAreas;
    updatedMenu.isUpdated = true;

  } else {

    currentRichmenu.name = richmenuName;
    currentRichmenu.diamention = [2500, 1686];
    currentRichmenu.imageUrl = imageUrl;
    currentRichmenu.areas = currentAreas;
    currentRichmenu.chatBarText = chatBarTextInput;
    currentRichmenu.isNew = true;
    currentRichmenu.isUpdated = true;

    allRichmenus.push(currentRichmenu);
  }

  redrawCanvasWithAreas();
  displayRichmenuThumbnails(allRichmenus);

  const cloneIndicatorEl = document.getElementById("clone-indicator");
  if (cloneIndicatorEl) {
    cloneIndicatorEl.classList.add("d-none");
    cloneIndicatorEl.textContent = "複製";
  }
  isCloningRichmenu = false;
  cloneSourceRichmenu = null;
  cloningRichmenuAreas = [];

  toast.success(`Richmenu 儲存成功！\n名稱: ${richmenuName}\n區域數量: ${currentAreas.length}`);
}


async function fetchRichMenuList() {
  try {
    showLoader();

    const response = await fetch(`${apiBase}/richmenu/list`, {
      method: "GET",
      headers: { "X-User-Id": getUserId() }
    });

    if (!response.ok) {
      throw new Error("無法取得 Richmenu 列表");
    }

    const data = await response.json();

    allRichmenus = data.richmenus || [];

    if (allRichmenus.length === 0) {
      document.getElementById("richmenu-thumbnails").innerHTML = "<p class='text-muted'>目前沒有設定任何 Richmenu，請新增</p>";
      hideLoader();
      return;
    }

    defaultRichmenuId = await getDefaultRichMenuId();

    const fragment = document.createDocumentFragment();
    await Promise.all(
      allRichmenus.map(async richmenu => {
        const isDefault = (richmenu.richMenuId === defaultRichmenuId);
        const richmenuElement = await fetchRichMenuImage(richmenu, isDefault);
        if (richmenuElement) {
          fragment.appendChild(richmenuElement);
        }
      })
    );

    const thumbnailsContainer = document.getElementById("richmenu-thumbnails");
    thumbnailsContainer.innerHTML = "";
    thumbnailsContainer.appendChild(fragment);

  } catch (error) {
    console.error("❌ 取得 Richmenu 失敗:", error);
  } finally {
    hideLoader();
  }
}

async function fetchRichMenuImage(richmenuData, isDefault = false) {
  const { richMenuId, name: richMenuName } = richmenuData;
  try {
    // Call the new shared helper function
    const richmenuDetails = await fetchRichMenuDetails(richmenuData, getUserId());

    // Check if the fetch failed (indicated by a null imageUrl)
    if (!richmenuDetails.imageUrl) {
      throw new Error(`無法取得 Richmenu (${richMenuId}) 的圖片資料`);
    }

    // Re-create a Richmenu class instance to be safe and match original behavior.
    const richmenu = new Richmenu(
      richmenuDetails.name,
      richmenuDetails.diamention,
      richmenuDetails.imageUrl,
      richmenuDetails.richMenuId,
      richmenuDetails.richMenuAliasId,
      richmenuDetails.areas,
      richmenuDetails.chatBarText,
      richmenuDetails.selected,
      null // imageFile is null when fetching from server
    );

    richmenu.isDefault = isDefault;
    richmenu.isNew = false;
    richmenu.isUpdated = false;
    // The `metadata` property is no longer available, but its contents are flattened onto the object.

    const richmenuIndex = allRichmenus.findIndex(menu => menu.richMenuId === richMenuId);
    if (richmenuIndex !== -1) {
      allRichmenus[richmenuIndex] = richmenu;
    } else {
      allRichmenus.push(richmenu);
    }

    return createRichmenuThumbnail(richmenu, richmenuIndex);

  } catch (error) {
    console.error(`❌ 無法取得 Richmenu ${richMenuName} (${richMenuId}) 的縮圖與資料:`, error);
    return null;
  }
}

function highlightThumbnail(selectedImg) {
  document.querySelectorAll(".richmenu-thumbnail").forEach(img => {
    img.classList.remove("selected-thumbnail");
  });
  selectedImg.classList.add("selected-thumbnail");
}


async function getDefaultRichMenuId() {
  try {
    const response = await fetch(`${apiBase}/richmenu/default`, {
      method: "GET",
      headers: { "X-User-Id": getUserId() }
    });

    if (!response.ok) {
      console.warn("⚠️ 無法取得 Default Richmenu");
      return null;
    }

    const data = await response.json();
    return data.richMenuId || null;
  } catch (error) {
    console.error("❌ 取得 Default Richmenu 失敗:", error);
    return null;
  }
}

document.getElementById("show-default-richmenu").addEventListener("click", async function () {
  if (!defaultRichmenuId) {
    toast.info("目前沒有設定 Default Richmenu");
    return;
  }

  const thumbnail = document.querySelector(`img[data-richmenu-id="${defaultRichmenuId}"]`);
  if (thumbnail) {
    thumbnail.scrollIntoView({ behavior: "smooth", block: "center" });
    thumbnail.click();
  }
});

function clearRichMenuDisplay() {
  document.getElementById("richmenu-thumbnails").innerHTML = "";

  const canvas = document.getElementById("uploaded-image-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  document.querySelector("#areas-table tbody").innerHTML = "";

  document.getElementById("status").innerText = "";

}

const deleteButton = document.getElementById("delete-selected-richmenu");
if (deleteButton) {
  deleteButton.addEventListener("click", function () {
    const selectedIndex = getSelectedRichmenuIndex();
    if (selectedIndex !== -1) {
      const richmenuName = allRichmenus[selectedIndex].name;

      // 顯示 Modal 確認對話框
      const deleteModal = new bootstrap.Modal(document.getElementById('confirm-delete-modal'));
      const deleteNameEl = document.getElementById('delete-richmenu-name');
      const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

      // 設定要刪除的 richmenu 名稱
      deleteNameEl.textContent = richmenuName;

      // 移除舊的事件監聽器（避免重複綁定）
      const newConfirmBtn = confirmDeleteBtn.cloneNode(true);
      confirmDeleteBtn.parentNode.replaceChild(newConfirmBtn, confirmDeleteBtn);

      // 綁定確認刪除事件
      document.getElementById('confirm-delete-btn').addEventListener('click', function () {
        // 標記為已刪除
        allRichmenus[selectedIndex].isDeleted = true;

        // 重新渲染縮略圖（顯示「已刪除」標籤）
        displayRichmenuThumbnails(allRichmenus);

        // 清空編輯區
        document.getElementById("menu-name").value = "";
        clearCanvas();
        const areasTableBody = document.getElementById("areas-table").querySelector("tbody");
        areasTableBody.innerHTML = "";

        // 重新選中這個項目，讓用戶看到「已刪除」標籤
        const containers = document.querySelectorAll(".richmenu-thumbnail-container");
        if (containers[selectedIndex]) {
          containers[selectedIndex].setAttribute("data-selected", "true");
          containers[selectedIndex].style.backgroundColor = "#A58A7B";
        }

        // 關閉 Modal
        deleteModal.hide();

        // 顯示成功訊息
        toast.success(`已標記「${richmenuName}」為刪除\n請點擊「同步所有變更至 Line@」來套用變更`);
      });

      // 顯示 Modal
      deleteModal.show();
    } else {
      toast.warning("請先選擇一個要刪除的 Richmenu");
    }
  });
}

async function syncRichmenusToServer() {
  showLoader("同步中請稍候...");

  const log = document.getElementById("upload-task-log");
  if (log) log.innerHTML = "";

  function addLog(msg, isSuccess = true) {
    if (!log) return;
    const li = document.createElement("li");
    li.textContent = msg;
    li.style.color = isSuccess ? "green" : "red";
    log.appendChild(li);
  }


  const removeList = allRichmenus.filter(menu => menu.isDeleted && menu.imageID).map(menu => menu.imageID);
  if (removeList.length > 0) {
    addLog(`🗑️ 刪除 ${removeList.length} 個 Richmenu...`);
    const res = await fetch(`${apiBase}/richmenu/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
      body: JSON.stringify({ add: [], update: [], remove: removeList, setDefault: null })
    });
    const result = await res.json();
    if (!res.ok || result.errors?.length) {
      addLog("❌ 刪除失敗，停止後續同步", false);
      console.error("❌ 刪除失敗", result.errors);
      return;
    }
    addLog("✅ 刪除成功");
  }

  for (const richmenu of allRichmenus) {
    if (richmenu.isNew && !richmenu.isDeleted) {
      const formData = new FormData();
      formData.append("userId", getUserId());

      formData.append("name", richmenu.name);
      formData.append("diamention", JSON.stringify(richmenu.diamention));
      formData.append("areas", JSON.stringify(richmenu.areas.map(area => ({
        ...area,
        action: createAction(area.action, 'richmenu')
      }))));
      formData.append("alias", richmenu.alias);
      formData.append("chatBarText", richmenu.chatBarText || "Tap to open");
      if (richmenu.imageFile) {
        formData.append("imageFile", richmenu.imageFile);
      }

      try {
        const res = await fetch(apiBase + "/richmenu/sync", {
          method: "POST",
          body: formData,
        });
        const json = await res.json();
        if (json.added?.length > 0 && (!json.errors || json.errors.length === 0)) {

          addLog(`✅ 成功新增 Richmenu: ${richmenu.name}`);
          continue;
        } else {
          addLog(`❌ 新增失敗: ${richmenu.name}`, false);
          toast.error("新增失敗：" + JSON.stringify(json));
          return;
        }
      } catch (err) {
        console.error("❌ 新增 Richmenu 發生錯誤", err);
        addLog(`❌ 新增失敗: ${richmenu.name}`, false);
        toast.error("新增失敗：" + err);
        return;
      }
    }
  }

  const defaultMenu = allRichmenus.find(menu => menu.isDefault);

  if (defaultMenu) {
    addLog(`🌟 設定預設選單：${defaultMenu.name}`);
    const res = await fetch(`${apiBase}/richmenu/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": getUserId() },
      body: JSON.stringify({ add: [], update: [], remove: [], setDefault: { name: defaultMenu.name, richMenuId: defaultMenu.imageID } })
    });
    const result = await res.json();
    if (!res.ok || result.errors?.length) {
      addLog("❌ 設定預設選單失敗", false);
      console.error("❌ 預設選單設定失敗", result.errors);
      return;
    }
    addLog("✅ 預設選單已設定");
  }

  addLog("🎉 所有步驟同步完成！");
  await fetchRichMenuList();
  await fetchRichMenuList();
}

// 搜尋篩選 Richmenu 列表
function filterRichmenuList(searchTerm) {
  const thumbnails = document.querySelectorAll("#richmenu-thumbnails > div");
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
  const resultCount = document.getElementById("richmenu-search-result-count");
  if (resultCount) {
    if (term) {
      resultCount.textContent = `找到 ${visibleCount} 個符合的 Richmenu`;
    } else {
      resultCount.textContent = "";
    }
  }
}

export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();

  // Directly fetch the rich menu list as the project is now set globally.
  await fetchRichMenuList();

  // 🆕 检查 URL 参数（从 Flow Designer 跳转过来）
  const urlParams = new URLSearchParams(window.location.search);
  const editRichmenuId = urlParams.get('edit');
  const createNew = urlParams.get('new');

  if (editRichmenuId) {
    // 编辑模式：自动载入指定的 Richmenu
    const richmenu = allRichmenus.find(rm => rm.richMenuId === editRichmenuId);
    if (richmenu) {
      // 找到对应的缩图并点击
      setTimeout(() => {
        const thumbnail = document.querySelector(`[data-richmenu-id="${editRichmenuId}"]`);
        if (thumbnail) {
          thumbnail.click();
        }
      }, 500); // 等待 UI 渲染完成
    }
  } else if (createNew === 'true') {
    // 创建模式：打开创建 Modal
    setTimeout(() => {
      const createBtn = document.getElementById('create-new-richmenu');
      if (createBtn) {
        createBtn.click();
      }
    }, 500);
  }


  const updateAllBtn = document.getElementById("update-all-richmenus");
  const confirmUpdateBtn = document.getElementById("confirm-update-line");
  const defaultSelect = document.getElementById("select-default-richmenu");

  if (updateAllBtn && confirmUpdateBtn && defaultSelect) {
    updateAllBtn.addEventListener("click", function () {
      defaultSelect.innerHTML = "";

      const defaultMenu = allRichmenus.find(menu => menu.isDefault);
      if (defaultMenu) {
        const defaultOption = document.createElement("option");
        defaultOption.value = defaultMenu.richMenuId;
        defaultOption.textContent = `${defaultMenu.name}（預設）`;
        defaultOption.selected = true;
        defaultSelect.appendChild(defaultOption);
      }

      allRichmenus.forEach((menu, index) => {
        if (menu.richMenuId === defaultRichmenuId) return;
        const option = document.createElement("option");
        option.value = menu.richMenuId || `index-${index}`;
        option.textContent = menu.name;
        defaultSelect.appendChild(option);
      });

      const modal = new bootstrap.Modal(document.getElementById("confirm-update-modal"));
      modal.show();
    });

    confirmUpdateBtn.addEventListener("click", async function () {

      await withButtonLoading(confirmUpdateBtn, async () => {
        await syncRichmenusToServer();
      }, '同步中...');

      const modal = bootstrap.Modal.getInstance(document.getElementById("confirm-update-modal"));
      modal.hide();
    });

    const setDefaultButton = document.getElementById("set-default-richmenu");
    if (setDefaultButton) {
      setDefaultButton.addEventListener("click", async function () {
        const selectedIndex = getSelectedRichmenuIndex();
        if (selectedIndex === -1) {
          toast.warning("請先選擇一個 Richmenu");
          return;
        }

        const selectedRichmenu = allRichmenus[selectedIndex];
        try {
          allRichmenus.forEach(menu => (menu.isDefault = false));
          selectedRichmenu.isDefault = true;
          defaultRichmenuId = selectedRichmenu.richMenuId;
          displayRichmenuThumbnails(allRichmenus);
          toast.success(`${selectedRichmenu.name} 已設為預設 Richmenu`);
        } catch (error) {
          console.error("❌ 設定預設 Richmenu 發生錯誤:", error);
          toast.error("設定預設 Richmenu 發生錯誤");
        }
      });
    }
  }

  const imageUpload = document.getElementById("new-image-upload");
  const imagePreview = document.getElementById("image-preview");
  const menuNameInput = document.getElementById("new-menu-name");
  const chatBarInput = document.getElementById("new-chat-bar-text");
  const aliasInput = document.getElementById("new-richmenu-alias");
  const canvas = document.getElementById("uploaded-image-canvas");
  const ctx = canvas.getContext("2d");

  const newRichmenuModal = document.getElementById("new-richmenu-modal");
  const newRichmenuTitle = document.getElementById("newRichmenuLabel");

  const resetNewRichmenuForm = () => {
    if (newRichmenuTitle) newRichmenuTitle.textContent = "新增 Richmenu";
    isCloningRichmenu = false;
    cloneSourceRichmenu = null;
    cloningRichmenuAreas = [];
    menuNameInput.value = "";
    chatBarInput.value = "";
    aliasInput.value = "";
    if (imageUpload) imageUpload.value = "";
    if (imagePreview) {
      imagePreview.src = "";
      imagePreview.style.display = "none";
    }
    delete newRichmenuModal.dataset.cloneSourceIndex;
  };

  const createButton = document.getElementById("create-new-richmenu");
  if (createButton) {
    createButton.addEventListener("click", () => {
      resetNewRichmenuForm();
    });
  }

  const cloneIndicator = document.getElementById("clone-indicator");
  const cloneButton = document.getElementById("clone-richmenu-btn");
  if (cloneButton) {
    cloneButton.addEventListener("click", async () => {
      const selectedIndex = getSelectedRichmenuIndex();
      if (selectedIndex === -1) {
        toast.warning("請先選擇一個要複製的 Richmenu");
        return;
      }

      const source = allRichmenus[selectedIndex];
      if (!source) {
        toast.error("找不到要複製的 Richmenu");
        return;
      }

      document.getElementById("newRichmenuLabel").textContent = "複製 Richmenu";

      document.getElementById("new-menu-name").value = generateClonedName(source.name);
      document.getElementById("new-chat-bar-text").value = source.chatBarText || "";
      document.getElementById("new-richmenu-alias").value = generateDeterministicAlias(getUserId());
      document.getElementById("new-menu-selected").checked = source.selected || false;

      const imagePreview = document.getElementById("image-preview");
      imagePreview.src = source.imageUrl;
      imagePreview.style.display = "block";

      const modalEl = document.getElementById("new-richmenu-modal");
      modalEl.dataset.cloneSourceIndex = selectedIndex;

      const modal = new bootstrap.Modal(modalEl);
      modal.show();
    });
  }

  if (newRichmenuModal) {
    newRichmenuModal.addEventListener("shown.bs.modal", function () {

      const fileInput = document.getElementById("new-image-upload");
      const imagePreview = document.getElementById("image-preview");

      if (fileInput && imagePreview) {
        fileInput.addEventListener("change", function (event) {
          const file = event.target.files[0];
          if (!file) {
            console.warn("⚠️ 沒有選擇任何檔案");
            return;
          }

          const reader = new FileReader();
          reader.onload = function (e) {
            imagePreview.src = e.target.result;
            imagePreview.style.display = "block";
          };
          reader.readAsDataURL(file);
        }, { once: true });
      } else {
        console.warn("❌ 找不到圖片 input 或預覽元件");
      }
    });

    newRichmenuModal.addEventListener("hidden.bs.modal", () => {
      resetNewRichmenuForm();
    });
  }

  imageUpload.addEventListener("change", async function () {
    const file = this.files[0];
    const imagePreview = document.getElementById("image-preview");

    if (!file) {
      processedImageFile = null;
      imagePreview.src = "";
      imagePreview.style.display = "none";
      return;
    }

    showLoader('正在處理圖片...');
    try {
      const processedDataUrl = await processImageFor(file, 'richmenu');

      imagePreview.src = processedDataUrl;
      imagePreview.style.display = "block";

      // Convert the processed base64 back to a File object for the upload function
      const newFilename = file.name.replace(/\.\w+$/, '.jpg'); // Save as jpg because of compression
      processedImageFile = dataURLtoFile(processedDataUrl, newFilename);

    } catch (error) {
      toast.error(error.message);
      this.value = ''; // Reset file input
      imagePreview.src = "";
      imagePreview.style.display = "none";
      processedImageFile = null;
    } finally {
      hideLoader();
    }
  });

  document.getElementById("preview-richmenu").addEventListener("click", function () {
    const imageSrc = imagePreview.src;
    if (!imageSrc || imageSrc === window.location.href) {
      toast.warning("請選擇圖片或輸入圖片網址");
      return;
    }

    img = new Image();
    img.src = imageSrc;
    img.onload = function () {
      canvas.width = img.width * scaleFactor;
      canvas.height = img.height * scaleFactor;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
  });

  document.getElementById("save-new-richmenu").addEventListener("click", async function () {

    const modalEl = document.getElementById("new-richmenu-modal");
    const sourceIndex = modalEl.dataset.cloneSourceIndex;
    const isCloning = sourceIndex !== undefined && sourceIndex !== null;

    const menuName = document.getElementById("new-menu-name").value.trim();
    const imagePreview = document.getElementById("image-preview");
    const imageSrc = imagePreview.src;

    if (!menuName) {
      toast.warning("請輸入選單名稱");
      return;
    }
    if (!imageSrc || imageSrc === window.location.href) {
      toast.warning("請提供圖片");
      return;
    }

    let imageFile = processedImageFile;
    let areasForNewMenu = [];
    let sourceMenu = null;
    // Get dimensions from the preview image's intrinsic size, which reflects the original file dimensions
    let diamention = [imagePreview.naturalWidth, imagePreview.naturalHeight];

    if (isCloning) {
      sourceMenu = allRichmenus[sourceIndex];
      areasForNewMenu = (sourceMenu.areas || []).map(area => JSON.parse(JSON.stringify(area)));
      diamention = sourceMenu.diamention; // For cloning, use the source's dimension
    }

    if (!imageFile && !isCloning) {
      toast.error("圖片資料遺失或處理失敗，請重新選擇圖片。");
      return;
    }

    // If cloning and no new file was processed (e.g., just changing name), create a file from the source URL
    if (isCloning && !imageFile) {
      try {
        const response = await fetch(sourceMenu.imageUrl);
        const blob = await response.blob();
        imageFile = new File([blob], "cloned_image.png", { type: blob.type });
      } catch (err) {
        console.error("複製圖片時發生錯誤:", err);
        toast.error("處理來源圖片時發生錯誤。");
        return;
      }
    }

    selectedAreas = areasForNewMenu.map(area => JSON.parse(JSON.stringify(area)));
    sessionStorage.setItem("currentAreas", JSON.stringify(selectedAreas));
    updateAreasTable();

    document.getElementById("menu-name").value = menuName;

    img = new Image();
    img.src = imageSrc;
    img.onload = function () {
      canvas.width = img.width * scaleFactor;
      canvas.height = img.height * scaleFactor;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      redrawCanvasWithAreas(selectedAreas);
    };

    const aliasValue = document.getElementById("new-richmenu-alias").value.trim() || generateDeterministicAlias(getUserId());
    const chatBarText = document.getElementById("new-chat-bar-text").value.trim() || "Tap to open";
    const isSelected = document.getElementById("new-menu-selected").checked;

    currentRichmenu = new Richmenu(
      menuName,
      diamention,
      imageSrc,
      "",
      aliasValue,
      areasForNewMenu,
      chatBarText,
      isSelected,
      imageFile
    );

    currentRichmenu.isNew = true;
    currentRichmenu.isUpdated = true;

    allRichmenus.push(currentRichmenu);
    displayRichmenuThumbnails(allRichmenus);


    delete modalEl.dataset.cloneSourceIndex;
    document.getElementById("newRichmenuLabel").textContent = "新增 Richmenu";
    const modalInstance = bootstrap.Modal.getInstance(modalEl);
    modalInstance?.hide();
  });

  const saveButton = document.getElementById("save-edited-richmenu");
  if (saveButton) {
    saveButton.addEventListener("click", function (e) {
      saveEditedRichmenu();
    });
  } else {
    console.error("Save button not found!");
  }

  // ✅ 綁定 Richmenu 搜尋功能
  const richmenuSearchInput = document.getElementById("richmenu-search");
  const clearRichmenuSearchBtn = document.getElementById("clear-richmenu-search");

  richmenuSearchInput?.addEventListener("input", (e) => {
    filterRichmenuList(e.target.value);
  });

  clearRichmenuSearchBtn?.addEventListener("click", () => {
    if (richmenuSearchInput) {
      richmenuSearchInput.value = "";
      filterRichmenuList("");
    }
  });

};