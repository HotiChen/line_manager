// worker_src/lib/message_variables.js
// 訊息變數替換（關鍵字回覆與 flow 共用）
//
// 內建：(@name) (@tier) (@tier_name) (@tier_icon) (@date) (@time) (@day) (@year) (@month)
// 額外（flow 的 API 節點）：(@api.欄位路徑)，由 variables.extra 帶入，鍵為不含 (@ ) 的名稱

import { getLineUserProfile } from './line_client.js';
import { getMemberTier } from './tier_system.js';

const MAX_EXTRA_LENGTH = 500;

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 替換 text 訊息的 text 與 flex 的 altText；用函式當替換值，避免值裡的 $& 之類被當成特殊符號 */
export function replaceMessageVariables(messages, variables) {
    const { userName, tierInfo, extra } = variables;

    // 台灣時間 UTC+8
    const twTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const year = twTime.getUTCFullYear();
    const month = twTime.getUTCMonth() + 1;
    const date = twTime.getUTCDate();
    const hours = String(twTime.getUTCHours()).padStart(2, '0');
    const minutes = String(twTime.getUTCMinutes()).padStart(2, '0');
    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][twTime.getUTCDay()];

    const replacements = {
        '(@name)': String(userName || '用戶'),
        '(@tier)': String(tierInfo?.tierTitle || '親愛的'),
        '(@tier_name)': String(tierInfo?.tierName || '新手'),
        '(@tier_icon)': String(tierInfo?.tierIcon || '🌱'),
        '(@date)': `${year}/${month}/${date}`,
        '(@time)': `${hours}:${minutes}`,
        '(@day)': `星期${dayOfWeek}`,
        '(@year)': String(year),
        '(@month)': String(month),
    };
    for (const [name, value] of Object.entries(extra || {})) {
        replacements[`(@${name})`] = String(value ?? '').slice(0, MAX_EXTRA_LENGTH);
    }

    const apply = (text) => {
        let out = text;
        for (const [key, value] of Object.entries(replacements)) {
            out = out.replace(new RegExp(escapeRegExp(key), 'gi'), () => value);
        }
        // 沒有值的 (@api.xxx)（API 失敗或欄位不存在）換成空字串，不要把變數原樣送給使用者
        return out.replace(/\(@api\.[\w.[\]-]*\)/gi, '');
    };

    for (const msg of messages) {
        if (msg.type === 'text' && msg.text) msg.text = apply(msg.text);
        if (msg.type === 'flex' && msg.altText) msg.altText = apply(msg.altText);
    }
    return messages;
}

/** 取得 (@name) / (@tier) 需要的資料；LINE profile 2 秒逾時，失敗用預設值 */
export async function loadVariableContext(store, lineUserId, accessToken) {
    const [lineProfile, tierData] = await Promise.all([
        Promise.race([
            getLineUserProfile(lineUserId, accessToken).catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
        ]),
        getMemberTier(store, lineUserId).catch(() => null),
    ]);
    return {
        userName: lineProfile?.displayName || '用戶',
        tierInfo: tierData || { tierName: '新手', tierTitle: '親愛的' },
    };
}
