import { jsonResponse } from "../lib/utils.js";

/**
* (新) 處理讀取 Flex Message 列表的請求。
* 現在會從單一的 KV 鍵中讀取整個列表。
*/
export async function handleListFlexMessages(env, userId) {
  const key = `flex_list_${userId}`;
  const value = await env.KV_LINE_STORAGE.get(key);

  // 如果沒有值，回傳一個空陣列
  const flexMessages = value ? JSON.parse(value) : [];

  // 為了符合前端 helper 的預期，我們回傳的物件 key 是 'flexs'
  return jsonResponse({ success: true, flexs: flexMessages });
}



export async function handleSyncFlexMessages(request, env, userId) {
  const { flexs } = await request.json();

  if (!Array.isArray(flexs)) {
    return jsonResponse({ error: "資料格式錯誤，'flexs' 必須是一個陣列。" }, 400);
  }

  // --- 新增 ID 指派邏輯 ---
  const processedFlexs = flexs.map(item => {
    // 如果項目沒有 ID (代表是從前端來的新項目)，則在後端為其指派一個唯一的 ID
    if (!item.id) {
      item.id = `flex_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return item;
  });
  // --- 邏輯結束 ---

  const key = `flex_list_${userId}`;
  // 儲存處理過的列表
  await env.KV_LINE_STORAGE.put(key, JSON.stringify(processedFlexs));

  return jsonResponse({ success: true, message: `成功同步 ${processedFlexs.length} 個 Flex Message。` });

}


/**
  * (更新) API 路由函式
  * 更新路由以對應新的處理函式。
*/
export function route(request, env, userId, pathname) {
  if (pathname === "/flex/list") {
    return handleListFlexMessages(env, userId);
  }
  // 為了語意更清晰，我們將 /save 改名為 /sync
  if (pathname === "/flex/sync") {
    return handleSyncFlexMessages(request, env, userId);
  }

  // 在這個新的工作流程中，舊的 /save 和 /delete 路由已不再需要。
  return jsonResponse({ success: false, error: "無效的 flex 路由" }, 404);
}
