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
