// routes/tag.js
import { jsonResponse } from "../lib/utils.js";
import {
  getAllTagsWithStats,
  deleteTag,
  renameTag,
  ensureTagExists
} from "../lib/tag_system.js";

// 建立或更新 tag
export async function handleSaveTag(request, env, userId) {
  const { name } = await request.json();
  if (!name || typeof name !== 'string') {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 tag 名稱" }, 400);
  }

  await ensureTagExists(env, userId, name);
  console.log("✅ [Save] 確保 tag 存在:", name);

  return jsonResponse({ success: true });
}

// 取得所有 tags (包含統計資訊)
export async function handleListTags(env, userId) {
  try {
    const tagsWithStats = await getAllTagsWithStats(env, userId);
    return jsonResponse({ success: true, data: tagsWithStats });
  } catch (error) {
    console.error("❌ 取得標籤列表失敗:", error);
    // fallback 到純清單
    const listKey = `tag_list_${userId}`;
    const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
    return jsonResponse({ success: true, data: list.map(name => ({ name, total: 0 })) });
  }
}

// 刪除 tag
export async function handleDeleteTag(request, env, userId) {
  const { name, names } = await request.json();

  if (!name && (!names || !Array.isArray(names))) {
    return jsonResponse({ success: false, error: "缺少 name 或 names" }, 400);
  }

  const tagsToDelete = names || [name];

  for (const tag of tagsToDelete) {
    if (tag) {
      await deleteTag(env, userId, tag);
      console.log("🗑️ [Delete] 已全面刪除 tag:", tag);
    }
  }

  return jsonResponse({ success: true });
}

// 重命名 tag
export async function handleRenameTag(request, env, userId) {
  const { oldName, newName } = await request.json();

  if (!oldName || !newName) {
    return jsonResponse({ success: false, error: "缺少 oldName 或 newName" }, 400);
  }

  await renameTag(env, userId, oldName, newName);
  console.log(`📝 [Rename] 已更名 tag: ${oldName} -> ${newName}`);

  return jsonResponse({ success: true });
}

// 路由進入點
export function route(request, env, userId, pathname) {
  console.log("📡 [TagRoute] 處理路由：", pathname);

  if (pathname === "/tag/save") return handleSaveTag(request, env, userId);
  if (pathname === "/tag/list") return handleListTags(env, userId);
  if (pathname === "/tag/delete") return handleDeleteTag(request, env, userId);
  if (pathname === "/tag/rename") return handleRenameTag(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid tag route" }, 404);
}