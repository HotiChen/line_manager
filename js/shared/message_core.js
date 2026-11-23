// js/shared/message_core.js
// 訊息類型的共用核心：純函式，不碰 DOM / KV / 網路（前端與 Worker 都能 import）。
//
// 一則「回覆物件」（reply）的形狀與 LINE Messaging API 的訊息相同：
//   { type: 'text', text }
//   { type: 'image', originalContentUrl, previewImageUrl? }
//   { type: 'flex', altText?, contents }            （Flex 只存 id 的情形由 line_client 先查回 contents）
//   { type: 'imagemap', baseUrl, baseSize, actions, altText? }
//
// 單一事實來源：新增訊息類型只要在 MESSAGE_TYPES 加一筆（validate + toLine），
// 發布檢查、關鍵字回覆、歡迎訊息、流程、推播就都認得。

/** LINE 單次 reply / push 最多 5 則 */
export const LINE_MAX_MESSAGES = 5;
export const LINE_MAX_TEXT_LENGTH = 5000;
export const LINE_MAX_ALT_TEXT_LENGTH = 400;

/** Imagemap 圖片重導向（某些開發環境需要）；只套用在 http(s) 開頭的 baseUrl */
export const IMAGEMAP_REDIRECT_BASE = 'https://pinti-line-imagemap-url-redirect.hotichen.workers.dev/?uri=';

export function isHttpsUrl(url) {
    return /^https:\/\//i.test(String(url || ''));
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 每種類型：validate(reply) → 錯誤訊息或 null；toLine(reply) → LINE 訊息（呼叫前已通過 validate） */
export const MESSAGE_TYPES = Object.freeze({
    text: {
        label: '文字訊息',
        validate: (r) => {
            if (!isNonEmptyString(r.text)) return '文字訊息是空的';
            if (r.text.length > LINE_MAX_TEXT_LENGTH) return `文字訊息超過 ${LINE_MAX_TEXT_LENGTH} 字`;
            return null;
        },
        toLine: (r) => ({ type: 'text', text: r.text }),
    },

    image: {
        label: '圖片訊息',
        validate: (r) => {
            if (!isHttpsUrl(r.originalContentUrl)) return '圖片網址必須以 https:// 開頭';
            if (r.previewImageUrl && !isHttpsUrl(r.previewImageUrl)) return '預覽圖網址必須以 https:// 開頭';
            return null;
        },
        toLine: (r) => ({
            type: 'image',
            originalContentUrl: r.originalContentUrl,
            previewImageUrl: r.previewImageUrl || r.originalContentUrl,
        }),
    },

    flex: {
        label: 'Flex 訊息',
        validate: (r) => (isPlainObject(r.contents) ? null : '尚未選擇 Flex 訊息（內容缺失）'),
        toLine: (r) => ({
            type: 'flex',
            altText: String(r.altText || '您收到了一則 Flex 訊息').slice(0, LINE_MAX_ALT_TEXT_LENGTH),
            contents: r.contents,
        }),
    },

    imagemap: {
        label: 'Imagemap 訊息',
        validate: (r) => (isNonEmptyString(r.baseUrl) && Array.isArray(r.actions) ? null : '尚未選擇 Imagemap（缺少圖片或區域）'),
        toLine: (r) => {
            const baseUrl = String(r.baseUrl);
            return {
                type: 'imagemap',
                baseUrl: baseUrl.startsWith('http')
                    ? IMAGEMAP_REDIRECT_BASE + baseUrl.replace(/\.jpg$/, '')
                    : baseUrl,
                altText: String(r.altText || '您收到了一則圖卡訊息').slice(0, LINE_MAX_ALT_TEXT_LENGTH),
                baseSize: r.baseSize,
                actions: r.actions,
            };
        },
    },
});

function typeOf(reply) {
    return reply && typeof reply === 'object' && Object.hasOwn(MESSAGE_TYPES, reply.type) ? MESSAGE_TYPES[reply.type] : null;
}

/** @returns {string|null} 錯誤訊息；合法回 null */
export function validateMessage(reply) {
    const t = typeOf(reply);
    if (!t) return `不支援的訊息類型：${reply && reply.type}`;
    return t.validate(reply);
}

/** 回覆物件 → LINE 訊息；不支援或不合法回 null（交給呼叫端丟掉，不讓一則壞訊息拖垮整次回覆） */
export function toLineMessage(reply) {
    const t = typeOf(reply);
    return t && !t.validate(reply) ? t.toLine(reply) : null;
}

/** Imagemap 的 action 只能是 message / uri：keyword 轉成 message */
export function normalizeImagemapActions(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'imagemap' || !Array.isArray(msg.actions)) return msg;
    return {
        ...msg,
        actions: msg.actions.map((action) => (action.type === 'keyword'
            ? { ...action, type: 'message', text: action.text || action.keyword }
            : action)),
    };
}

/** 設定物件（關鍵字 / 歡迎訊息）的 Quick Reply id：自己的優先，否則取 replies 裡第一個有設定的 */
export function pickQuickReplyId(config) {
    if (!config) return null;
    if (config.quickReplyId) return config.quickReplyId;
    const withQr = Array.isArray(config.replies) ? config.replies.find((r) => r && r.quickReplyId) : null;
    return withQr ? withQr.quickReplyId : null;
}

/** 訊息裡有沒有 (@xxx) 變數（決定要不要多花一次 LINE profile 查詢） */
export function usesVariables(messages) {
    return (messages || []).some((m) => /\(@/.test(`${(m && m.text) || ''}${(m && m.altText) || ''}`));
}
