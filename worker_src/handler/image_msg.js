import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";
 
/**
  * 處理讀取圖片訊息列表的請求。
  * 會從單一的 KV 鍵中讀取整個列表。
  */
export async function handleListImageMessages(env, userId) {
    const store = await openBotStore(env, userId);
    const imageMessages = await store.getOr('images', []);

    // 前端 helper 預期收到的 key 是 'images'
    return jsonResponse({ images: imageMessages });
    }

/**
  * 處理同步 (Sync) 圖片訊息列表的請求。
  * 會接收前端傳來的完整列表，並覆寫 KV 中儲存的舊列表。
  */
export async function handleSyncImageMessages(request, env, userId) {
    const { images } = await request.json();

    if (!Array.isArray(images)) {
        return jsonResponse({ error: "資料格式錯誤，'images' 必須是一個陣列。" }, 400);
    }

    // 為新項目指派唯一的 ID
    const processedImages = images.map(item => {
        if (!item.id) {
            item.id = `image_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        return item;
    });

    const store = await openBotStore(env, userId);
    await store.put('images', processedImages);

    return jsonResponse({ success: true, message: `成功同步 ${processedImages.length} 個圖片訊息。` });
}

/**
* 圖片訊息的 API 路由函式
*/
export function route(request, env, userId, pathname) {
    if (pathname === "/image/list") {
        return handleListImageMessages(env, userId);
    }
    if (pathname === "/image/sync") {
        return handleSyncImageMessages(request, env, userId);
    }

    return jsonResponse({ success: false, error: "無效的 image 路由" }, 404);
}