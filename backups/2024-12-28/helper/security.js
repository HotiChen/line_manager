/**
 * Security helper for sanitizing HTML content.
 * Relies on DOMPurify being loaded globally via CDN in index.html.
 */

/**
 * Sanitizes a string of HTML to prevent XSS attacks.
 * @param {string} dirtyHTML - The potentially unsafe HTML string.
 * @returns {string} - The sanitized HTML string.
 */
export function safeHTML(dirtyHTML) {
  if (typeof window.DOMPurify === 'undefined') {
    console.warn('DOMPurify is not loaded. Returning unsanitized content. Please ensure DOMPurify is included in index.html.');
    return dirtyHTML;
  }
  return window.DOMPurify.sanitize(dirtyHTML);
}

/**
 * Safely sets the innerHTML of an element.
 * @param {HTMLElement} element - The target DOM element.
 * @param {string} html - The HTML content to set.
 */
export function setInnerHTML(element, html) {
  if (!element) return;
  element.innerHTML = safeHTML(html);
}

/**
 * Validates a URL to prevent XSS attacks via malicious protocols.
 * Only allows http: and https: protocols.
 * 
 * @param {string} url - The URL to validate.
 * @param {Object} options - Validation options.
 * @param {boolean} options.allowRelative - Whether to allow relative URLs (default: true).
 * @param {boolean} options.allowLocalhost - Whether to allow localhost URLs (default: false in production).
 * @returns {Object} - { isValid: boolean, sanitizedUrl: string|null, error: string|null }
 */
export function validateUrl(url, options = {}) {
  const {
    allowRelative = true,
    allowLocalhost = window.location.hostname === 'localhost'
  } = options;

  // Result object
  const result = {
    isValid: false,
    sanitizedUrl: null,
    error: null
  };

  // Check for empty/null
  if (!url || typeof url !== 'string') {
    result.error = 'URL 不可為空';
    return result;
  }

  // Trim whitespace
  const trimmedUrl = url.trim();

  // Allow relative URLs if option enabled
  if (allowRelative && (trimmedUrl.startsWith('/') || trimmedUrl.startsWith('.') || trimmedUrl.startsWith('#'))) {
    result.isValid = true;
    result.sanitizedUrl = trimmedUrl;
    return result;
  }

  // Check for dangerous protocols (XSS vectors)
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
  const lowerUrl = trimmedUrl.toLowerCase();

  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      result.error = `不允許的 URL 協議: ${protocol}`;
      console.warn(`🛡️ [Security] Blocked dangerous URL protocol: ${protocol}`);
      return result;
    }
  }

  // Try to parse as URL
  try {
    const parsedUrl = new URL(trimmedUrl, window.location.origin);

    // Only allow http and https
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      result.error = `不支援的 URL 協議: ${parsedUrl.protocol}`;
      return result;
    }

    // Check for localhost/127.0.0.1 if not allowed
    if (!allowLocalhost) {
      const localHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
      if (localHosts.includes(parsedUrl.hostname)) {
        result.error = '不允許本地位址';
        return result;
      }
    }

    // All checks passed
    result.isValid = true;
    result.sanitizedUrl = parsedUrl.href;
    return result;

  } catch (e) {
    result.error = '無效的 URL 格式';
    return result;
  }
}

/**
 * Simple URL check - returns boolean only.
 * Use this for quick validation in conditionals.
 * 
 * @param {string} url - The URL to check.
 * @returns {boolean} - Whether the URL is safe.
 */
export function isUrlSafe(url) {
  return validateUrl(url).isValid;
}

