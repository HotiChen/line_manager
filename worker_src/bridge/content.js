/**
 * 通知內容的驗證與組裝（LM-3B 抽出，LM-4B 的事件回覆與備用內容共用）
 *
 * 所有「產品給的內容」進 LINE 之前都要經過這裡：
 *   - action.url：https、443、非 IP、非 localhost，主機等於或是產品登記 url_domains 的子網域
 *   - title／body／label：不可含 http:// 或 https://、不可含控制字元
 *   - 外觀：固定的 Flex bubble（buildFlexMessage），使用者文字只進 text／label／altText，網址只進 uri action
 */
/** 呼叫端產生的不透明代號（external_contact_ref） */
export const CONTACT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

const MAX_TITLE = 40;
const MAX_BODY = 300;
const MAX_LABEL = 20;
const MAX_URL = 1000;
const ALT_TEXT_MAX = 400;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ALLOWED_FIELDS = ["external_contact_ref", "event_type", "title", "body", "action"];
const REQUIRED_FIELDS = ["external_contact_ref", "event_type", "title", "body"];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_RE = /[\s\u0000-\u001f\u007f-\u009f]/;

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** 以 code point 計長度（emoji 算 1 個字元，與 LINE 的計法一致） */
const charLength = (s) => Array.from(s).length;


// ── 驗證 ──

/**
 * action.url 白名單。通過條件全部成立：https、無帳號密碼、長度 ≤ 1000、無空白與控制字元、埠為空或 443、
 * 主機名稱不是 IP／localhost，且（小寫、去尾端點後）等於某個登記網域或是它的子網域。
 *
 * @param {unknown} raw
 * @param {unknown} urlDomains 產品登記的 url_domains
 * @returns {{ok: true, url: string} | {ok: false}} ok 時 url 是正規化後的網址（真正送給 LINE 的就是它）
 */
export function checkActionUrl(raw, urlDomains) {
  const fail = { ok: false };
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_URL || URL_FORBIDDEN_RE.test(raw)) return fail;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fail;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return fail;
  if (u.port !== "" && u.port !== "443") return fail;
  if (u.href.length > MAX_URL) return fail;

  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.startsWith("[") || !HOSTNAME_RE.test(host)) return fail; // IPv6、空標籤
  if (IPV4_RE.test(host) || /^\d+$/.test(host.split(".").pop())) return fail; // IPv4（含 URL 正規化後的怪寫法）
  if (host === "localhost" || host.endsWith(".localhost")) return fail;

  const domains = Array.isArray(urlDomains) ? urlDomains : [];
  const matched = domains.some((d) => {
    if (typeof d !== "string") return false;
    const domain = d.toLowerCase().replace(/\.$/, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
  return matched ? { ok: true, url: u.href } : fail;
}

const hasLink = (s) => {
  const lower = s.toLowerCase();
  return lower.includes("http://") || lower.includes("https://");
};

function validateText(name, value, max, { allowNewline = false } = {}) {
  if (typeof value !== "string") return `${name} must be a string`;
  const len = charLength(value);
  if (len < 1 || len > max) return `${name} must be 1-${max} characters`;
  if (value.trim() === "") return `${name} must not be blank`;
  if ((allowNewline ? CONTROL_EXCEPT_NEWLINE_RE : CONTROL_RE).test(value)) return `${name} must not contain control characters`;
  if (hasLink(value)) return `${name} must not contain links; put the URL in action.url`;
  return null;
}

/**
 * 驗證請求本體（不含網址白名單）。
 *
 * @param {unknown} body
 * @returns {{error: string} | {value: {ref: string, eventType: string, title: string, body: string, action: null | {label: string, url: string}}}}
 */
export function validateNotification(body) {
  if (!isPlainObject(body)) return { error: "Body must be a JSON object" };
  for (const k of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(k)) return { error: `Unknown field: ${k.slice(0, 40)}` };
  }
  for (const k of REQUIRED_FIELDS) {
    if (body[k] === undefined) return { error: `${k} is required` };
  }
  if (typeof body.external_contact_ref !== "string" || !CONTACT_REF_RE.test(body.external_contact_ref)) {
    return { error: "external_contact_ref must match ^[A-Za-z0-9_-]{8,64}$" };
  }
  if (typeof body.event_type !== "string" || !EVENT_TYPE_RE.test(body.event_type)) {
    return { error: "event_type must match ^[a-z][a-z0-9_.]{0,63}$" };
  }
  const titleErr = validateText("title", body.title, MAX_TITLE);
  if (titleErr) return { error: titleErr };
  const bodyErr = validateText("body", body.body, MAX_BODY, { allowNewline: true });
  if (bodyErr) return { error: bodyErr };

  let action = null;
  if (body.action !== undefined) {
    const a = body.action;
    if (!isPlainObject(a)) return { error: "action must be an object" };
    for (const k of Object.keys(a)) {
      if (k !== "label" && k !== "url") return { error: `Unknown field: action.${k.slice(0, 40)}` };
    }
    const labelErr = validateText("action.label", a.label, MAX_LABEL);
    if (labelErr) return { error: labelErr };
    if (typeof a.url !== "string" || a.url === "") return { error: "action.url must be a non-empty string" };
    action = { label: a.label, url: a.url };
  }

  return { value: { ref: body.external_contact_ref, eventType: body.event_type, title: body.title, body: body.body, action } };
}

// ── 訊息組裝（LM 專屬，產品不能帶 message object）──

/**
 * 固定外觀的 Flex bubble：標題（粗體）、內文、（有 action 時）一顆按鈕。
 * 使用者文字只進 `text`／`label`（LINE 不解析成標記）與 altText（= 標題）；網址只進 uri action。
 *
 * @param {{title: string, body: string, action: null | {label: string, url: string}}} content url 必須已通過 checkActionUrl
 * @returns {object} LINE flex message object
 */
export function buildFlexMessage({ title, body, action }) {
  const bubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: title, weight: "bold", size: "lg", wrap: true },
        { type: "text", text: body, size: "md", wrap: true },
      ],
    },
  };
  if (action) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "button", style: "primary", height: "sm", action: { type: "uri", label: action.label, uri: action.url } },
      ],
    };
  }
  return { type: "flex", altText: title.slice(0, ALT_TEXT_MAX), contents: bubble };
}

/**
 * 驗證「只有內容」的 Notification：`{title, body, action?}`（事件回覆與備用內容用；沒有 ref 與 event_type）。
 * 網址白名單由呼叫端再用 checkActionUrl 檢查。
 *
 * @param {unknown} obj
 * @returns {{error: string} | {value: {title: string, body: string, action: null | {label: string, url: string}}}}
 */
export function validateContent(obj) {
  if (!isPlainObject(obj)) return { error: "Content must be a JSON object" };
  for (const k of Object.keys(obj)) {
    if (k !== "title" && k !== "body" && k !== "action") return { error: `Unknown field: ${k.slice(0, 40)}` };
  }
  if (obj.title === undefined) return { error: "title is required" };
  if (obj.body === undefined) return { error: "body is required" };
  const titleErr = validateText("title", obj.title, MAX_TITLE);
  if (titleErr) return { error: titleErr };
  const bodyErr = validateText("body", obj.body, MAX_BODY, { allowNewline: true });
  if (bodyErr) return { error: bodyErr };
  let action = null;
  if (obj.action !== undefined) {
    const a = obj.action;
    if (!isPlainObject(a)) return { error: "action must be an object" };
    for (const k of Object.keys(a)) {
      if (k !== "label" && k !== "url") return { error: `Unknown field: action.${k.slice(0, 40)}` };
    }
    const labelErr = validateText("action.label", a.label, MAX_LABEL);
    if (labelErr) return { error: labelErr };
    if (typeof a.url !== "string" || a.url === "") return { error: "action.url must be a non-empty string" };
    action = { label: a.label, url: a.url };
  }
  return { value: { title: obj.title, body: obj.body, action } };
}

/**
 * 內容 → 要送給 LINE 的 Flex message；網址不在白名單回 null。
 *
 * @param {{title: string, body: string, action: null | {label: string, url: string}}} content
 * @param {unknown} urlDomains
 * @returns {object|null}
 */
export function contentToMessage(content, urlDomains) {
  let action = null;
  if (content.action) {
    const checked = checkActionUrl(content.action.url, urlDomains);
    if (!checked.ok) return null;
    action = { label: content.action.label, url: checked.url };
  }
  return buildFlexMessage({ title: content.title, body: content.body, action });
}
