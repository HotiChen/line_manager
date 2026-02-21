// js/helper/message.helper.js

import { showLoader, hideLoader } from '../js/shared/loader.js';
import { apiBase } from "../env/config.js";
import { getUserId } from "./state.js";

// 🎯 版本資訊
export const HELPER_VERSION = "2.1.0"; // Bump version for refactoring

// 🔧 配置選項
export const HELPER_CONFIG = {
  enableCache: true,
  cacheTimeout: 5 * 60 * 1000, // 5分鐘
  maxRetries: 3,
  retryDelay: 1000
};

// 🗄️ 快取管理
class MessageCache {
  constructor() {
    this.cache = new Map();
    this.timestamps = new Map();
  }
  set(key, value) {
    if (!HELPER_CONFIG.enableCache) return;
    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());
  }
  get(key) {
    if (!HELPER_CONFIG.enableCache) return null;
    const timestamp = this.timestamps.get(key);
    if (!timestamp || (Date.now() - timestamp > HELPER_CONFIG.cacheTimeout)) {
      this.clear(key);
      return null;
    }
    return this.cache.get(key);
  }
  clear(key) {
    if (key) {
      this.cache.delete(key);
      this.timestamps.delete(key);
    } else {
      this.cache.clear();
      this.timestamps.clear();
    }
  }
  has(key) {
    return this.get(key) !== null;
  }
}

const messageCache = new MessageCache();

// =================================================================
// ✨ NEW: UNIFIED API AND CACHING LOGIC
// =================================================================

/**
 * Generic API client to handle all fetch requests.
 * @param {string} endpoint - The API endpoint (e.g., '/flex/list').
 * @param {object} options - Fetch options (method, body, headers, responseType).
 * @returns {Promise<any>} The response data.
 */
async function apiClient(endpoint, options = {}) {
  const { method = 'GET', body = null, headers = {}, responseType = 'json' } = options;

  const defaultHeaders = { 'X-User-Id': getUserId() };
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  const config = {
    method,
    headers: { ...defaultHeaders, ...headers },
  };

  if (body) {
    config.body = defaultHeaders['Content-Type'] === 'application/json' ? JSON.stringify(body) : body;
  }

  const response = await fetch(`${apiBase}${endpoint}`, config);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Server returned non-JSON error response' }));
    throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
  }

  if (responseType === 'json') return response.json();
  if (responseType === 'blob') return response.blob();
  if (responseType === 'text') return response.text();
  return response;
}

const inflightRequests = new Map();

/**
 * Wrapper function to handle caching logic for API calls.
 * 
 * Why:
 * - 加入 `inflightRequests` 鎖定機制，防止同時間多個 UI 元件要求相同的 API 資源時（例如同時打開多個標籤下拉選單），引發網路請求風暴。
 * 
 * @param {string} cacheKey - The key to use for caching.
 * @param {Function} apiCallFunction - An async function that performs the API call.
 * @returns {Promise<any>} Cached or fresh data.
 */
async function fetchWithCache(cacheKey, apiCallFunction) {
  const cachedData = messageCache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const data = await retryOperation(apiCallFunction);
      messageCache.set(cacheKey, data);
      return data;
    } catch (err) {
      console.error(`❌ [API] Failed to fetch ${cacheKey}:`, err);
      return []; // Return empty array on failure for consistency
    } finally {
      inflightRequests.delete(cacheKey);
    }
  })();

  inflightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// 🔄 重試機制 (unchanged)
async function retryOperation(operation, maxRetries = HELPER_CONFIG.maxRetries) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`[retryOperation] 第 ${i + 1} 次嘗試失敗:`, error.message);
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, HELPER_CONFIG.retryDelay * (i + 1)));
    }
  }
}

// =================================================================
// ☁️ REFACTORED: PUBLIC API FUNCTIONS
// =================================================================

// ☁️ 根據訊息類型載入清單
export async function fetchMessageListByType(msgType, userId) {
  if (["text", "uri", "message", "postback"].includes(msgType)) {
    return [];
  }
  const cacheKey = `${msgType}_${userId}`;
  const data = await fetchWithCache(cacheKey, async () => {
    const result = await apiClient(`/${msgType}/list`);
    return result[msgType + "s"] || result.data || [];
  });
  return data;
}

// ☁️ 載入關鍵字回覆清單
export async function fetchKeywordReplies(userId) {
  const cacheKey = `keyword_replies_${userId}`;
  const data = await fetchWithCache(cacheKey, async () => {
    const result = await apiClient('/keyword/list');
    return result.data || [];
  });
  return data;
}

// ☁️ 載入歡迎訊息
export async function fetchWelcomeMessage(userId) {
  const cacheKey = `welcome_message_${userId}`;
  // Welcome message is a single object, handle potential null response
  const cachedData = messageCache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const message = await retryOperation(() => apiClient('/welcome/get'));
      messageCache.set(cacheKey, message.data || null);
      return message.data || null;
    } catch (err) {
      console.error(`❌ 讀取歡迎訊息發生錯誤:`, err);
      return null;
    } finally {
      inflightRequests.delete(cacheKey);
    }
  })();

  inflightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// ☁️ 載入總標籤列表
export async function fetchMasterTags(userId) {
  const cacheKey = `master_tags_${userId}`;
  const data = await fetchWithCache(cacheKey, async () => {
    const result = await apiClient('/tag/list');
    return result.success && Array.isArray(result.data) ? result.data : [];
  });
  return data;
}

// ☁️ 載入單一 Rich Menu 的詳細資料
export async function fetchRichMenuDetails(richmenuData, userId) {
  const { richMenuId } = richmenuData;
  try {
    const [blob, metadata] = await Promise.all([
      apiClient(`/richmenu/image/${richMenuId}`, { responseType: 'blob' }),
      apiClient(`/richmenu/metadata/${richMenuId}`).catch(() => ({})) // Gracefully fail on metadata
    ]);

    const imageUrl = URL.createObjectURL(blob);
    return {
      ...richmenuData,
      imageUrl,
      diamention: metadata.size ? [metadata.size.width, metadata.size.height] : richmenuData.diamention || [2500, 1686],
      areas: metadata.areas || richmenuData.areas || [],
      chatBarText: metadata.chatBarText || richmenuData.chatBarText || "Tap to open",
      selected: metadata.selected || richmenuData.selected || false,
    };
  } catch (error) {
    console.error(`Failed to fetch details for richmenu ${richMenuId}:`, error);
    return { ...richmenuData, imageUrl: null, diamention: null, areas: richmenuData.areas || [] };
  }
}

// ☁️ 儲存訊息清單到 Cloudflare Worker
export async function saveRemoteMessages(msgType, messages, userId) {
  return apiClient('/message/save', {
    method: 'POST',
    body: { type: msgType, messages },
  });
}

// ☁️ 上傳圖片到 WordPress (接收 base64)
export async function uploadImage(base64, filename) {
  showLoader('上傳圖片中...');
  try {
    // This API is external and doesn't use the standard apiClient headers/base_url
    const response = await fetch("https://uploadimage2wordpress.hotichen.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64, filename }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Server returned non-JSON error response' }));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.url) {
      throw new Error(data.error || "未知的上傳錯誤。");
    }

    return data.url;
  } catch (error) {
    console.error("[uploadImage] 上傳過程中發生錯誤:", error);
    throw error;
  } finally {
    hideLoader();
  }
}


// =================================================================
//  untouched helper functions
// =================================================================

// 🔍 偵測當前 builder 頁面類型
export function detectBuilder() {
  const path = window.location.pathname;
  if (path.includes("imagemap")) return "imagemap";
  if (path.includes("flex")) return "flex";
  if (path.includes("richmenu")) return "richmenu";
  if (path.includes("keyword")) return "keyword";
  if (path.includes("welcome")) return "welcome";
  return "unknown";
}

// 🧾 各訊息類型說明
export const messageTypeDescriptions = {
  text: "文字訊息: 最基礎的訊息類型，可以傳送文字內容.",
  message: "文字訊息: 最基礎的訊息類型，可以傳送文字內容.",
  keyword: "從已儲存的關鍵字裡選擇",
  uri: "網址連結",
  image: "圖片訊息: 傳送單張圖片.",
  sticker: "貼圖訊息: 傳送LINE 貼圖.",
  video: "影片訊息: 傳送影片.",
  location: "位置訊息: 傳送地理位置.",
  imagemap: "Imagemap訊息: 傳送圖片，使用者點擊圖片的特定區域會觸發不同的動作，例如發送不同的文字訊息.",
  flex: "圖文訊息: 傳送包含圖片、文字和按鈕的訊息，使用者點擊按鈕會向官方帳號發送指定的訊息.",
  carousel: "多頁訊息: 傳送包含多個頁面的訊息，使用者可以左右滑動瀏覽，每個頁面可以包含文字、圖片和按鈕.",
  audio: "音訊訊息: 傳送音訊檔.",
  coupon: "優惠券: 傳送優惠券訊息.",
  postback: "Postback訊息: 當使用者點擊按鈕時，會向您的伺服器發送指定的資料.",
  datetimepicker: "日期時間選擇器: 讓使用者選擇日期和時間.",
  camera: "相機: 開啟使用者的相機.",
  cameraRoll: "相簿: 開啟使用者的相簿.",
  richmenuswitch: "Rich Menu切換: 切換到指定的Rich Menu."
};

// 🏷️ 訊息類型與中文標籤對照
export const messageTypeLabels = {
  text: "文字訊息",
  message: "文字訊息",
  keyword: "關鍵字",
  uri: "連結",
  postback: "訊息回傳",
  flex: "Flex訊息",
  imagemap: "圖文訊息",
  location: "位置訊息",
  audio: "音訊訊息",
  video: "影片訊息",
  coupon: "優惠券",
  carousel: "多頁訊息",
  image: "圖片",
  sticker: "貼圖",
  datetimepicker: "日期時間選擇器",
  camera: "相機",
  cameraRoll: "相簿",
  richmenuswitch: "Rich Menu切換"
};

// 🔗 各訊息類型對應支援的 action type
export const messageTypeActionSupport = {
  flex: ["postback", "message", "uri", "keyword", "datetimepicker", "camera", "cameraRoll", "location", "richmenuswitch"],
  imagemap: ["uri", "message", "keyword", "postback"],
  richmenu: ["message", "uri", "keyword", "richmenuswitch"],
  quickReply: ["postback", "message", "uri", "keyword", "datetimepicker", "camera", "cameraRoll", "location"],
};

// 📋 各 builder 支援的訊息類型清單
const supportMap = {
  keywords: ["text", "imagemap", "flex", "image", "uri", "postback"],
  imagemap: ["uri", "keyword", "imagemap", "postback"],
  richmenu: ["message", "keyword", "uri", "postback", "richmenuswitch"],
  flex: ["message", "keyword", "uri", "postback", "imagemap", "datetimepicker", "camera", "cameraRoll", "location"],
  welcome: ["message", "imagemap", "flex", "image", "uri", "postback"],
  default: ["message", "uri", "postback"]
};

// 📌 查詢當前頁面支援的訊息類型
export function getSupportedMsgTypes(builder) {
  return supportMap[builder] || [];
}

// 📦 取得某個訊息類型的儲存清單（localStorage）
export function getSavedMessages(msgType) {
  const key = `${msgType}_list`;
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

// 💾 儲存一筆訊息（若有 id 則更新）
export function saveMessageItem(msgType, item) {
  const key = `${msgType}_list`;
  const list = getSavedMessages(msgType);
  const existingIndex = list.findIndex(i => i.id === item.id);

  if (existingIndex >= 0) {
    list[existingIndex] = item;
  } else {
    item.id = item.id || `${msgType}_${Date.now()}`;
    list.push(item);
  }

  localStorage.setItem(key, JSON.stringify(list));
  return item.id;
}

// 🗑️ 刪除一筆訊息
export function deleteMessageItem(msgType, id) {
  const key = `${msgType}_list`;
  const list = getSavedMessages(msgType);
  const newList = list.filter(item => item.id !== id);
  localStorage.setItem(key, JSON.stringify(newList));
}

// 👁️ 將訊息轉成簡易預覽文字
export function formatMessagePreview(msgType, item) {
  const tagsHtml = (item.tags && item.tags.length > 0)
    ? ` <span style="color: #0d6efd; font-size: 0.8em;">${item.tags.join(' ')}</span>`
    : '';

  switch (msgType) {
    case "text":
    case "message":
      return `💬 ${item.text?.slice(0, 20)}...${tagsHtml}`;
    case "uri":
      return `🔗 ${item.label || "未命名"} → ${item.uri}${tagsHtml}`;
    case "postback":
      return `📦 ${item.label || "Postback"}${tagsHtml}`;
    case "flex":
      return `📱 ${item.title || "Flex"}${tagsHtml}`;
    case "imagemap":
      return `🗺️ ${item.title || "Imagemap"}${tagsHtml}`;
    default:
      return `❓ ${item.id}${tagsHtml}`;
  }
}

// 📊 一次取得所有訊息類型的儲存資料
export function getAllSavedMessages() {
  const types = ["text", "uri", "postback", "flex", "imagemap"];
  const result = {};
  types.forEach(type => {
    result[type] = getSavedMessages(type);
  });
  return result;
}

// ✅ 驗證訊息內容格式是否正確（可選用）
export function validateMessageItem(msgType, item) {
  if (!item) return false;
  switch (msgType) {
    case "text":
    case "message":
      return typeof item.text === "string";
    case "uri": return !!item.uri;
    case "postback": return !!item.data;
    case "flex": return typeof item.contents === "object";
    case "imagemap": return !!item.imageUrl;
    default: return false;
  }
}

// 等待全域變數載入的輔助函式
export function waitForGlobalVar(varName, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (window[varName]) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`${varName} library did not load in time.`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// 🧩 產生動態訊息輸入 UI 區塊
export async function generateReplyInputUI({ builder, userId, onSelect, initialReply = null, customData = {} }) {
  const types = getSupportedMsgTypes(builder);
  const defaultType = initialReply ? initialReply.type : types[0];

  const container = document.createElement("div");
  container.id = "reply-dynamic-fields";

  const typeSelect = document.createElement("select");
  typeSelect.className = "form-select mb-2";
  types.forEach((type) => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = messageTypeLabels[type] || type;
    typeSelect.appendChild(opt);
  });
  if (initialReply) {
    typeSelect.value = initialReply.type;
  }
  container.appendChild(typeSelect);

  const inputContainer = document.createElement("div");
  container.appendChild(inputContainer);

  async function renderInputByType(selectedType, initialValue = null) {
    inputContainer.innerHTML = "";

    if (["text", "uri", "message"].includes(selectedType)) {
      const input = document.createElement("input");
      input.className = "form-control main-reply-input"; // Add main class
      input.placeholder = (selectedType === "text" || selectedType === "message") ? "請輸入文字" : "請輸入網址";
      if (initialValue) {
        input.value = initialValue.text || initialValue.uri || "";
      }
      input.addEventListener("input", () => {
        const value = input.value;
        const payload = (selectedType === "text" || selectedType === "message") ? { text: value } : { uri: value, label: value };
        if (typeof onSelect === "function") onSelect(selectedType, payload);
      });
      inputContainer.appendChild(input);

      // 🆕 加入變數工具提示 (僅文字訊息)
      if (selectedType === "text" || selectedType === "message") {
        const helperDiv = document.createElement("div");
        helperDiv.className = "mt-2";
        helperDiv.innerHTML = `
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <small class="text-muted">
              <i class="bi bi-lightning-charge"></i> 插入變數：
            </small>
            <button type="button" class="btn btn-sm btn-outline-secondary var-btn" data-var="(@name)">(@name) 名稱</button>
            <button type="button" class="btn btn-sm btn-outline-secondary var-btn" data-var="(@date)">(@date) 日期</button>
            <button type="button" class="btn btn-sm btn-outline-secondary var-btn" data-var="(@time)">(@time) 時間</button>
            <button type="button" class="btn btn-sm btn-outline-secondary var-btn" data-var="(@day)">(@day) 星期</button>
          </div>
        `;

        // 點擊變數按鈕時插入到輸入框
        helperDiv.querySelectorAll('.var-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const varText = btn.dataset.var;
            const cursorPos = input.selectionStart;
            const textBefore = input.value.substring(0, cursorPos);
            const textAfter = input.value.substring(cursorPos);
            input.value = textBefore + varText + textAfter;
            input.focus();
            input.setSelectionRange(cursorPos + varText.length, cursorPos + varText.length);

            // 觸發 input 事件更新狀態
            const event = new Event('input', { bubbles: true });
            input.dispatchEvent(event);
          });
        });

        inputContainer.appendChild(helperDiv);
      }

      return;
    } else if (selectedType === 'richmenuswitch') {
      const pageSelector = document.createElement("select");
      pageSelector.className = "form-select main-reply-input"; // Add main class
      pageSelector.id = "page-selector";
      const validMenus = (customData.richmenus || []).filter(m => m.alias && m.name !== customData.currentMenuName);

      if (validMenus.length === 0) {
        const option = document.createElement("option");
        option.textContent = "沒有其他可切換的選單";
        option.disabled = true;
        pageSelector.appendChild(option);
      } else {
        validMenus.forEach((richmenu) => {
          const option = document.createElement("option");
          option.value = richmenu.alias;
          option.textContent = richmenu.name;
          pageSelector.appendChild(option);
        });
      }
      if (initialValue && initialValue.richMenuAliasId) {
        pageSelector.value = initialValue.richMenuAliasId;
      }
      inputContainer.appendChild(pageSelector);
      return;
    }

    const messageList = await fetchMessageListByType(selectedType, userId);

    if (["imagemap", "flex", "postback", "keyword"].includes(selectedType)) {
      if (!messageList.length) {
        inputContainer.innerHTML = `<div class="alert alert-warning small">尚無可用的「${messageTypeLabels[selectedType]}」訊息。</div>`;
        return;
      }
      const select = document.createElement("select");
      select.className = "form-select main-reply-input"; // Add main class
      // Store the list directly on the element for later retrieval
      select.dataset.messageList = JSON.stringify(messageList);

      // Add the default, disabled "Please select" option
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "請選擇內容";
      defaultOption.disabled = true;
      defaultOption.selected = true;
      select.appendChild(defaultOption);


      messageList.forEach((item) => {
        const opt = document.createElement("option");
        const value = item.id || item.altText || item.title || item.label || item.keyword;
        opt.value = value;
        opt.textContent = item.altText || item.title || item.label || item.id || item.keyword || "未命名";
        select.appendChild(opt);
      });

      if (initialValue) {
        select.value = initialValue.id || initialValue.altText || initialValue.title || initialValue.label || initialValue.keyword;
      }
      select.addEventListener("change", () => {
        const selectedId = select.value;
        const selectedItem = messageList.find((i) =>
          i.id === selectedId ||
          i.altText === selectedId ||
          i.title === selectedId ||
          i.label === selectedId ||
          i.keyword === selectedId
        );
        if (selectedItem && typeof onSelect === "function") {
          onSelect(selectedType, selectedItem);
        }
      });
      inputContainer.appendChild(select);
    } else {
      inputContainer.textContent = "⚠️ 尚未支援此訊息類型的輸入欄位";
    }

    const masterTags = await fetchMasterTags(userId);
    const tagInputContainer = document.createElement("div");
    tagInputContainer.className = "mt-2";

    const tagLabel = document.createElement("label");
    tagLabel.className = "form-label small text-muted";
    tagLabel.textContent = "標籤 (用逗號分隔)";

    const tagInput = document.createElement("input");
    tagInput.type = "text";
    tagInput.className = "form-control form-control-sm";
    tagInput.id = "message-tags-input";
    tagInput.placeholder = "例如：#promo, #event";
    tagInput.setAttribute("list", "master-tags-datalist");

    const dataList = document.createElement("datalist");
    dataList.id = "master-tags-datalist";
    masterTags.forEach(tag => {
      const option = document.createElement("option");
      option.value = tag;
      dataList.appendChild(option);
    });

    if (initialValue && initialValue.tags) {
      tagInput.value = initialValue.tags.join(', ');
    }

    tagInputContainer.appendChild(tagLabel);
    tagInputContainer.appendChild(tagInput);
    tagInputContainer.appendChild(dataList);
    inputContainer.appendChild(tagInputContainer);
    await waitForGlobalVar('Tagify');
  }

  renderInputByType(defaultType, initialReply);

  typeSelect.addEventListener("change", (e) => {
    renderInputByType(e.target.value, null);
  });

  return container;
}

// 🔍 取得目前 UI 所選的回覆類型與內容
export function getCurrentReplyInput() {
  const container = document.getElementById("reply-dynamic-fields");
  if (!container) return null;

  const typeSelect = container.querySelector("select.form-select.mb-2");
  const inputContainer = typeSelect?.nextElementSibling;

  const type = typeSelect?.value;
  if (!type || !inputContainer) return null;

  const input = inputContainer.querySelector("input.main-reply-input");
  const select = inputContainer.querySelector("select.main-reply-input");
  const textarea = inputContainer.querySelector("textarea.main-reply-input");

  let value = "";
  let item = null;

  if (input) {
    value = input.value;
    if (type === "text" || type === "message") {
      item = { type: 'message', text: value };
    }
    if (type === "uri") {
      const isValidUrl = /^https?:\/\/[\w\-]+(\.[\w\-]+)+[/#?]?.*$/.test(value);
      if (!isValidUrl) {
        alert("無效網址格式", value);
        console.warn("[getCurrentReplyInput] 無效網址格式:", value);
        return null;
      }
      item = { type: 'uri', uri: value, label: value };
    }
  } else if (textarea) {
    value = textarea.value;
    if (type === "text" || type === "message") {
      item = { type: 'message', text: value };
    } else if (type === "uri") {
      const isValidUrl = /^https?:\/\/[\w\-]+(\.[\w\-]+)+[/#?]?.*$/.test(value);
      if (!isValidUrl) {
        alert("無效網址格式", value);
        console.warn("[getCurrentReplyInput] 無效網址格式:", value);
        return null;
      }
      item = { type: 'uri', uri: value, label: value };
    }
  } else if (select) {
    value = select.value;
    if (type === 'richmenuswitch') {
      const selectedOption = select.options[select.selectedIndex];
      item = {
        type: 'richmenuswitch',
        richMenuAliasId: value,
        data: `richmenu-switch-to-${value}`,
        label: selectedOption ? selectedOption.text : value
      };
    } else {
      // NEW: Read the list directly from the select element's dataset
      const list = select.dataset.messageList ? JSON.parse(select.dataset.messageList) : [];
      const selected = list.find(i =>
        i.id === value ||
        i.altText === value ||
        i.title === value ||
        i.label === value ||
        i.keyword === value
      );
      if (type === 'flex') {
        if (selected) {
          item = { type: 'flex', flexId: selected.id, title: selected.title || selected.name || 'Flex Message' };
        } else {
          item = { type: 'flex', flexId: value, title: value };
        }
      } else if (selected) {
        item = { ...selected, type: type };
      } else {
        // Fallback for cases where the value might not be in the list (e.g. initial value)
        item = { type: type, id: value, label: value };
      }
    }
  }

  if (item) {
    const tagsInput = container.querySelector("#message-tags-input");
    if (tagsInput && tagsInput.value) {
      item.tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag);
    } else {
      item.tags = [];
    }
  }

  return { type, value, item };
}

export function createAction(reply, builderType) {
  if (!reply || !reply.type) {
    console.warn("createAction called with invalid reply object:", reply);
    return { type: 'uri', uri: '#' };
  }

  const action = {
    type: reply.type,
    label: reply.label || reply.text || reply.data
  };

  switch (reply.type) {
    case 'uri':
      const uriValue = reply.uri || reply.data || '#';
      if (builderType === 'imagemap') {
        action.linkUri = uriValue;
      } else {
        action.uri = uriValue;
      }
      break;
    case 'message':
    case 'text':
      action.type = 'message';
      action.text = reply.text || reply.data || '';
      break;
    case 'keyword':
      // 關鍵字類型轉換為 message 類型，使用 keyword 作為文字內容
      action.type = 'message';
      action.text = reply.keyword || reply.text || reply.data || '';
      action.label = reply.keyword || reply.label || '';
      break;
    case 'postback':
      action.data = reply.data || '';
      break;
    case 'richmenuswitch':
      action.richMenuAliasId = reply.richMenuAliasId || '';
      action.data = reply.data || `richmenu-switch-to-${reply.richMenuAliasId}`;
      // 保留 label 以便顯示 richmenu 名稱而非 alias ID
      if (reply.label) {
        action.label = reply.label;
      }
      break;
    case 'datetimepicker':
      action.data = reply.data || '';
      action.mode = reply.mode || 'datetime';
      break;
    default:
      break;
  }

  if (['camera', 'cameraRoll', 'location'].includes(action.type)) {
    delete action.label;
  }

  return action;
}

// 🧹 清除快取
export function clearMessageCache() {
  messageCache.clear();
}

// 📊 取得快取統計
export function getCacheStats() {
  return {
    size: messageCache.cache.size,
    keys: Array.from(messageCache.cache.keys())
  };
}

// 🔄 重新載入特定類型的訊息
export async function refreshMessageType(msgType, userId) {
  const cacheKey = `${msgType}_${userId}`;
  messageCache.clear(cacheKey);
  return await fetchMessageListByType(msgType, userId);
}

// 🎨 生成訊息預覽 HTML
export function generateMessagePreviewHTML(msgType, item) {
  const preview = formatMessagePreview(msgType, item);
  const icon = getMessageTypeIcon(msgType);
  return `<div class="message-preview">
    <span class="message-icon">${icon}</span>
    <span class="message-text">${preview}</span>
  </div>`;
}

// 🎯 取得訊息類型圖示
export function getMessageTypeIcon(msgType) {
  const icons = {
    text: "💬",
    message: "💬",
    uri: "🔗",
    postback: "📦",
    flex: "📱",
    imagemap: "🗺️",
    image: "🖼️",
    video: "🎥",
    audio: "🎵",
    sticker: "😊",
    location: "📍",
    keyword: "🔑",
    datetimepicker: "📅",
    camera: "📷",
    cameraRoll: "📸",
    richmenuswitch: "🔄"
  };
  return icons[msgType] || "❓";
}

// 🔍 搜尋訊息
export function searchMessages(messages, query) {
  if (!query || !messages) return messages;

  const lowerQuery = query.toLowerCase();
  return messages.filter(item => {
    const searchableText = [
      item.title,
      item.label,
      item.text,
      item.altText,
      item.keyword,
      item.id
    ].filter(Boolean).join(' ').toLowerCase();

    return searchableText.includes(lowerQuery);
  });
}

// 📋 批量操作
export async function batchSaveMessages(msgType, messages, userId) {
  try {
    const results = [];
    for (const message of messages) {
      const result = await saveMessageItem(msgType, message);
      results.push(result);
    }
    return results;
  } catch (error) {
    console.error(`[batchSaveMessages] 批量儲存失敗:`, error);
    throw error;
  }
}

// 🗑️ 批量刪除
export function batchDeleteMessages(msgType, ids) {
  try {
    ids.forEach(id => deleteMessageItem(msgType, id));
  } catch (error) {
    console.error(`[batchDeleteMessages] 批量刪除失敗:`, error);
    throw error;
  }
}

// =================================================================
// 🏭 MessageFactory - 統一訊息對象創建
// =================================================================

/**
 * MessageFactory
 * 用於統一創建各種訊息對象的工廠函數
 * 
 * 優點：
 * 1. 統一格式，避免直接創建時出錯
 * 2. 提供預設值，減少重複代碼
 * 3. 易於維護，集中管理訊息格式
 * 4. IDE 自動補全，提升開發效率
 * 
 * @example
 * // 創建 URI 訊息
 * const action = MessageFactory.uri("https://example.com");
 * 
 * // 創建文字訊息
 * const action = MessageFactory.text("你好");
 * 
 * // 創建空的 URI（用於初始化）
 * const action = MessageFactory.empty('uri');
 */
export const MessageFactory = {
  /**
   * 創建文字訊息
   * @param {string} text - 訊息文字內容
   * @returns {object} 文字訊息對象
   */
  text(text) {
    return {
      type: 'message',
      text: text || ''
    };
  },

  /**
   * 創建訊息（text 的別名）
   * @param {string} text - 訊息文字內容
   * @returns {object} 文字訊息對象
   */
  message(text) {
    return this.text(text);
  },

  /**
   * 創建 URI 連結訊息
   * @param {string} uri - 連結網址
   * @param {string|null} label - 連結顯示文字（可選）
   * @returns {object} URI 訊息對象
   */
  uri(uri, label = null) {
    return {
      type: 'uri',
      uri: uri || '',
      label: label || uri || '連結'
    };
  },

  /**
   * 創建 Flex 訊息
   * @param {string} flexId - Flex 訊息 ID
   * @param {string} title - Flex 訊息標題
   * @returns {object} Flex 訊息對象
   */
  flex(flexId, title) {
    return {
      type: 'flex',
      flexId: flexId || '',
      title: title || 'Flex Message'
    };
  },

  /**
   * 創建 Imagemap 訊息
   * @param {string} imagemapId - Imagemap 訊息 ID
   * @param {string} altText - 替代文字
   * @returns {object} Imagemap 訊息對象
   */
  imagemap(imagemapId, altText) {
    return {
      type: 'imagemap',
      imagemapId: imagemapId || '',
      altText: altText || 'Imagemap'
    };
  },

  /**
   * 創建 Postback 訊息
   * @param {string} data - Postback 資料
   * @param {string} label - 按鈕顯示文字
   * @returns {object} Postback 訊息對象
   */
  postback(data, label) {
    return {
      type: 'postback',
      data: data || '',
      label: label || 'Postback'
    };
  },

  /**
   * 創建 Richmenu Switch 訊息
   * @param {string} richMenuAliasId - Richmenu 別名 ID
   * @param {string} label - 選單顯示名稱
   * @returns {object} Richmenu Switch 訊息對象
   */
  richmenuswitch(richMenuAliasId, label) {
    return {
      type: 'richmenuswitch',
      richMenuAliasId: richMenuAliasId || '',
      data: `richmenu-switch-to-${richMenuAliasId || ''}`,
      label: label || richMenuAliasId || 'Rich Menu'
    };
  },

  /**
   * 創建關鍵字訊息
   * @param {string} keyword - 關鍵字
   * @returns {object} 關鍵字訊息對象
   */
  keyword(keyword) {
    return {
      type: 'keyword',
      keyword: keyword || '',
      text: keyword || ''
    };
  },

  /**
   * 創建空的訊息對象（用於初始化）
   * @param {string} type - 訊息類型
   * @returns {object} 空的訊息對象
   */
  empty(type = 'message') {
    const defaults = {
      message: { type: 'message', text: '' },
      text: { type: 'message', text: '' },
      uri: { type: 'uri', uri: '', label: '連結' },
      flex: { type: 'flex', flexId: '', title: '' },
      imagemap: { type: 'imagemap', imagemapId: '', altText: '' },
      postback: { type: 'postback', data: '', label: '' },
      richmenuswitch: { type: 'richmenuswitch', richMenuAliasId: '', data: '', label: '' },
      keyword: { type: 'keyword', keyword: '', text: '' }
    };
    return defaults[type] || defaults.message;
  }
};