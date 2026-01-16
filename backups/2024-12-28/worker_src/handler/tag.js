// routes/tag.js
import { jsonResponse } from "../lib/utils.js";

// 建立或更新 tag
export async function handleSaveTag(request, env, userId) {
  const { name } = await request.json();
  if (!name || typeof name !== 'string') {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 tag 名稱" }, 400);
  }

  const listKey = `tag_list_${userId}`;
  const existing = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");

  const exists = existing.find(tag => tag === name);
  if (!exists) {
    existing.push(name);
    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(existing));
    console.log("✅ [Save] 新增 tag:", name);
  } else {
    console.log("🔁 [Save] 已存在的 tag，不重複儲存:", name);
  }

  return jsonResponse({ success: true });
}

// 取得所有 tags
export async function handleListTags(env, userId) {
  const listKey = `tag_list_${userId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  return jsonResponse({ success: true, data: list });
}

// 刪除 tag（單筆或多筆）
export async function handleDeleteTag(request, env, userId) {
  const { name, names } = await request.json();

  const toDelete = [];
  if (name) toDelete.push(name);
  if (Array.isArray(names)) toDelete.push(...names);

  if (toDelete.length === 0) {
    return jsonResponse({ success: false, error: "缺少 name 或 names" }, 400);
  }

  const listKey = `tag_list_${userId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  const updated = list.filter(tag => !toDelete.includes(tag));

  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));
  console.log("🗑️ [Delete] 已刪除 tags:", toDelete);

  return jsonResponse({ success: true, deleted: toDelete });
}

// 路由進入點
export function route(request, env, userId, pathname) {
  console.log("📡 [TagRoute] 處理路由：", pathname);

  if (pathname === "/tag/save") return handleSaveTag(request, env, userId);
  if (pathname === "/tag/list") return handleListTags(env, userId);
  if (pathname === "/tag/delete") return handleDeleteTag(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid tag route" }, 404);
}