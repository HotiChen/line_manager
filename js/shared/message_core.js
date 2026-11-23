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
export const LINE_MAX_BUTTON_LABEL_LENGTH = 20;
export const LINE_MAX_URI_LENGTH = 1000;
export const LINE_MAX_POSTBACK_DATA_LENGTH = 300;

/** Imagemap 圖片重導向（某些開發環境需要）；只套用在 http(s) 開頭的 baseUrl */
export const IMAGEMAP_REDIRECT_BASE = 'https://pinti-line-imagemap-url-redirect.hotichen.workers.dev/?uri=';

export function isHttpsUrl(url) {
    return /^https:\/\//i.test(String(url || ''));
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const clip = (v, max) => String(v ?? '').slice(0, max);

/**
 * 「連結」「訊息回傳」這類不是獨立訊息的東西，用一個帶單一按鈕的 Flex 氣泡送出。
 * altText 用說明文字（通知與聊天列表會看到）。
 */
function buttonBubble({ text, action }) {
    return {
        type: 'flex',
        altText: clip(text, LINE_MAX_ALT_TEXT_LENGTH),
        contents: {
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: clip(text, LINE_MAX_TEXT_LENGTH), wrap: true }] },
            footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action }] },
        },
    };
}
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

    // 連結：{ uri, text?（說明文字）, label? / buttonLabel?（按鈕文字） }
    // 舊版編輯器只存 { uri, label: 網址 }：標籤等於網址（太長、不是人話）時用預設按鈕文字
    uri: {
        label: '連結',
        validate: (r) => {
            const uri = String(r.uri || '');
            if (!/^https?:\/\/[^\s]+$/i.test(uri)) return '連結必須是 http:// 或 https:// 開頭的網址';
            if (uri.length > LINE_MAX_URI_LENGTH) return `連結超過 ${LINE_MAX_URI_LENGTH} 字`;
            return null;
        },
        toLine: (r) => {
            const named = r.buttonLabel || (r.label && r.label !== r.uri ? r.label : '');
            const label = clip(named || '開啟連結', LINE_MAX_BUTTON_LABEL_LENGTH);
            return buttonBubble({ text: r.text || '請點擊下方按鈕', action: { type: 'uri', label, uri: r.uri } });
        },
    },

    // 訊息回傳：{ data, label?, displayText?, text? }；使用者按下按鈕時 webhook 會收到 postback（例如 tag=VIP 會自動加標籤）
    postback: {
        label: '訊息回傳',
        validate: (r) => {
            if (!isNonEmptyString(r.data)) return '訊息回傳的「回傳資料」是空的';
            if (r.data.length > LINE_MAX_POSTBACK_DATA_LENGTH) return `回傳資料超過 ${LINE_MAX_POSTBACK_DATA_LENGTH} 字`;
            if (r.displayText && String(r.displayText).length > LINE_MAX_POSTBACK_DATA_LENGTH) return `顯示文字超過 ${LINE_MAX_POSTBACK_DATA_LENGTH} 字`;
            return null;
        },
        toLine: (r) => {
            const label = clip(r.label || '確認', LINE_MAX_BUTTON_LABEL_LENGTH);
            const action = { type: 'postback', label, data: r.data };
            if (r.displayText) action.displayText = String(r.displayText);
            return buttonBubble({ text: r.text || '請點擊下方按鈕', action });
        },
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
