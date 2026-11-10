// routes/tag.js
import { jsonResponse } from "../lib/utils.js";
import {
  getAllTagsWithStats,
  deleteTag,
  renameTag,
  ensureTagExists
} from "../lib/tag_system.js";
import { openBotStore } from "../lib/bot_store.js";

// 建立或更新 tag
export async function handleSaveTag(request, env, userId) {
  const { name } = await request.json();
  if (!name || typeof name !== 'string') {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 tag 名稱" }, 400);
  }

  const store = await openBotStore(env, userId);
  await ensureTagExists(store, name);

  return jsonResponse({ success: true });
}

// 取得所有 tags (包含統計資訊)
export async function handleListTags(env, userId) {
  const store = await openBotStore(env, userId);
  try {
    const tagsWithStats = await getAllTagsWithStats(store);
    return jsonResponse({ success: true, data: tagsWithStats });
  } catch (error) {
    console.error("❌ 取得標籤列表失敗:", error);
    // fallback 到純清單
    const list = await store.getOr('tags', []);
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

  const store = await openBotStore(env, userId);
  for (const tag of tagsToDelete) {
    if (tag) {
      await deleteTag(store, tag);
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

  const store = await openBotStore(env, userId);
  await renameTag(store, oldName, newName);

  return jsonResponse({ success: true });
}

// 路由進入點
export function route(request, env, userId, pathname) {

  if (pathname === "/tag/save") return handleSaveTag(request, env, userId);
  if (pathname === "/tag/list") return handleListTags(env, userId);
  if (pathname === "/tag/delete") return handleDeleteTag(request, env, userId);
  if (pathname === "/tag/rename") return handleRenameTag(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid tag route" }, 404);
}