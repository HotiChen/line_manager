import { jsonResponse } from "../lib/utils.js";
import { getAccessToken, pushMessage } from "../lib/line_api.js";
import { incrementMessageCount } from "../lib/message_stats.js";
import { openBotStore } from "../lib/bot_store.js";
import { replaceMessageVariables } from "../lib/message_variables.js";
import { getMemberTier } from "../lib/tier_system.js";

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

        const store = await openBotStore(env, userId);

        // 🔹 變數替換：與關鍵字回覆、歡迎訊息、流程共用同一份（js: message_variables.js）
        //    以前這裡有自己的一套，只支援 4 種變數、用伺服器時區（UTC），(@day) 也少了「星期」
        const profile = await store.get('member', to);
        const memberName = profile ? (profile.name || profile.lineName || "朋友") : "朋友";
        const tierInfo = await getMemberTier(store, to).catch(() => null);

        // 複製每一則再替換，不改到呼叫端傳進來的物件
        const processedMessages = replaceMessageVariables(
            messages.map((msg) => ({ ...msg })),
            { userName: memberName, tierInfo }
        );

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
