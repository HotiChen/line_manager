/**
 * Segmented Rich Menu Handler
 * 處理分眾規則的 CRUD
 */
import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";

export async function handleSaveSegmentedRules(request, env, ownerId) {
    try {
        const { rules } = await request.json();
        if (!Array.isArray(rules)) {
            return jsonResponse({ success: false, error: "Rules 必須是陣列" }, 400);
        }

        // 簡單驗證結構
        for (const rule of rules) {
            if (!rule.tag || !rule.richMenuId) {
                return jsonResponse({ success: false, error: "規則缺少 tag 或 richMenuId" }, 400);
            }
        }

        const store = await openBotStore(env, ownerId);
        await store.put('segmentedRichMenuRules', rules);

        return jsonResponse({ success: true, rules });
    } catch (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
}

export async function handleGetSegmentedRules(env, ownerId) {
    const store = await openBotStore(env, ownerId);
    const rules = await store.getOr('segmentedRichMenuRules', []);
    return jsonResponse({ success: true, rules });
}

export function route(request, env, ownerId, pathname) {
    if (pathname === "/richmenu/segmented/save" && request.method === "POST") {
        return handleSaveSegmentedRules(request, env, ownerId);
    }
    if (pathname === "/richmenu/segmented/list" && request.method === "GET") {
        return handleGetSegmentedRules(env, ownerId);
    }
    return null;
}
