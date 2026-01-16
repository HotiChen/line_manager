import { jsonResponse } from "../lib/utils.js";
import { getAccessToken, pushMessage } from "../lib/line_api.js";
import { incrementMessageCount } from "../lib/message_stats.js";

export async function handleSendPushMessage(request, env, userId) {
    try {
        const { to, messages } = await request.json();

        if (!to || !messages || !Array.isArray(messages)) {
            return jsonResponse({ success: false, error: "Missing 'to' or 'messages' (array)" }, 400);
        }

        const token = await getAccessToken(env, userId);
        if (!token) {
            return jsonResponse({ success: false, error: "No active LINE token found" }, 401);
        }

        // 🔹 變數替換邏輯 (Variable Replacement)
        // 取得會員資料
        const profileKey = `member_profile_${userId}_${to}`;
        const profileRaw = await env.KV_LINE_STORAGE.get(profileKey);
        const profile = profileRaw ? JSON.parse(profileRaw) : null;
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

            // 🔍 偵錯：如果是 Imagemap，印出其 baseUrl
            if (newMsg.type === 'imagemap') {
            }

            return newMsg;
        });

        const result = await pushMessage(token, to, processedMessages);

        // Track the message cost
        await incrementMessageCount(env, userId, 'push');

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
