/**
 * Security helper - 網頁安全防護工具
 * 負責過濾 HTML 內容預防 XSS 攻擊。
 */

/**
 * 清理 HTML 字串，防止惡意腳本執行。
 * 
 * @param {string} dirtyHTML - 未過濾的 HTML 字串
 * @returns {string} 安全的 HTML 字串
 * 
 * Pre-conditions: 
 * - 需在 index.html 載入 DOMPurify 
 * Post-conditions:
 * - 回傳已清除潛在 XSS 威脅的 HTML，若 DOMPurify 不存在則回傳原值並警告
 */
export function safeHTML(dirtyHTML) {
  if (typeof window.DOMPurify === 'undefined') {
    console.warn('🛡️ [Security] DOMPurify 未載入，將回傳原始內容。');
    return dirtyHTML;
  }
  return window.DOMPurify.sanitize(dirtyHTML);
}

/**
 * 安全地將 HTML 注入到 DOM 元素中
 * 
 * @param {HTMLElement} element - 目標 DOM 元素
 * @param {string} html - 欲注入的 HTML 字串
 * 
 * Pre-conditions:
 * - element 必須是存在的 DOM 節點
 * Post-conditions:
 * - element 的 innerHTML 被安全替換，防範 XSS
 */
export function setInnerHTML(element, html) {
  if (element) element.innerHTML = safeHTML(html);
}

/**
 * 驗證並過濾 URL，僅允許安全的協定 (http, https)
 * 
 * @param {string} url - 待檢驗的字串
 * @param {object} [options={}] - 驗證選項 (allowRelative, allowLocalhost)
 * @returns {object} { isValid, sanitizedUrl, error }
 * 
 * Pre-conditions:
 * - url 必須為字串
 * Post-conditions:
 * - 回傳包含 isValid (boolean) 與 sanitizedUrl (string|null) 的檢驗結果物件
 */
export function validateUrl(url, options = {}) {
  const { allowRelative = true, allowLocalhost = window.location.hostname === 'localhost' } = options;
  const result = { isValid: false, sanitizedUrl: null, error: null };

  if (!url || typeof url !== 'string') {
    result.error = 'URL 不可為空';
    return result;
  }

  const trimmedUrl = url.trim();
  if (allowRelative && (trimmedUrl.startsWith('/') || trimmedUrl.startsWith('.') || trimmedUrl.startsWith('#'))) {
    result.isValid = true;
    result.sanitizedUrl = trimmedUrl;
    return result;
  }

  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
  const lowerUrl = trimmedUrl.toLowerCase();
  if (dangerousProtocols.some(p => lowerUrl.startsWith(p))) {
    result.error = '不安全的 URL 協定';
    return result;
  }

  try {
    const parsedUrl = new URL(trimmedUrl, window.location.origin);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      result.error = '不支援的協定';
      return result;
    }
    if (!allowLocalhost && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
      result.error = '不允許本地位址';
      return result;
    }
    result.isValid = true;
    result.sanitizedUrl = parsedUrl.href;
    return result;
  } catch (e) {
    result.error = '格式錯誤';
    return result;
  }
}

/**
 * 簡單檢查 URL 是否安全，僅回傳 boolean。
 * 適合用在簡易邏輯判斷。
 * 
 * @param {string} url - The URL to check.
 * @returns {boolean} Whether the URL is safe.
 * 
 * Pre-conditions:
 * - 無特別限制
 * Post-conditions:
 * - 一律回傳 boolean
 */
export function isUrlSafe(url) {
  return validateUrl(url).isValid;
}

