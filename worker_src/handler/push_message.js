import { jsonResponse } from "../lib/utils.js";
import { pushMessage } from "../lib/line_api.js";
import { getAccessTokenForStore } from "../lib/token_store.js";
import { incrementMessageCount } from "../lib/message_stats.js";
import { openBotStore } from "../lib/bot_store.js";

export async function handleSendPushMessage(request, env, userId) {
    try {
        const { to, messages } = await request.json();

        if (!to || !messages || !Array.isArray(messages)) {
            return jsonResponse({ success: false, error: "Missing 'to' or 'messages' (array)" }, 400);
        }

        // store 先開：token 要跟著資料所屬的 bot 走，不是跟著 current_token。
        // 兩者錯開時推播會送到別的官方帳號，LINE 回 400 Invalid user id，
        // 而收件人名單（同一個 store）看起來完全正常。
        const store = await openBotStore(env, userId);

        const token = await getAccessTokenForStore(store);
        if (!token) {
            return jsonResponse({ success: false, error: "No active LINE token found" }, 401);
        }

        // 🔹 變數替換邏輯 (Variable Replacement)
        // 取得會員資料
        const profile = await store.get('member', to);
        const memberName = profile ? (profile.name || profile.lineName || "朋友") : "朋友";

        const now = new Date();
        const dateStr = now.toLocaleDateString('zh-TW');
        const timeStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
        const days = ['日', '一', '二', '三', '四', '五', '六'];
        const dayStr = days[now.getDay()];

        // 處理每一則訊息
        const processedMessages = messages.map(msg => {
            const newMsg = { ...msg };

            // 替換函數
            const replaceVars = (str) => {
                if (typeof str !== 'string') return str;
                return str
                    .replace(/\(@name\)/g, memberName)
                    .replace(/\(@date\)/g, dateStr)
                    .replace(/\(@time\)/g, timeStr)
                    .replace(/\(@day\)/g, dayStr);
            };

            // 文字訊息
            if (newMsg.type === 'text') {
                newMsg.text = replaceVars(newMsg.text);
            }
            // Flex / Imagemap / 其他類型的 altText
            if (newMsg.altText) {
                newMsg.altText = replaceVars(newMsg.altText);
            }

            return newMsg;
        });

        const result = await pushMessage(token, to, processedMessages);

        // Track the message cost
        await incrementMessageCount(store, 'push');

        return jsonResponse({ success: true, result });
    } catch (error) {
        console.error("[PushHandler] Error:", error);
        return jsonResponse({ success: false, error: error.message }, 500);
    }
}

export function route(request, env, userId, pathname) {
    if (pathname === "/api/send-message" && request.method === "POST") {
        return handleSendPushMessage(request, env, userId);
    }
    return jsonResponse({ success: false, error: "Not Found" }, 404);
}
