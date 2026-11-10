import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";
import { ensureTagExists } from "../lib/tag_system.js";

// 儲存一組 keyword + replies
export async function handleSaveKeywordReply(request, env, userId) {
  const { keyword, replies, quickReplyId, addTags, removeTags } = await request.json();

  if (!keyword || !Array.isArray(replies)) {
    console.warn("❌ [Save] 缺少必要欄位");
    return jsonResponse({ success: false, error: "缺少必要欄位" }, 400);
  }

  const store = await openBotStore(env, userId);
  const existing = await store.getOr('keywords', []);

  // 建立新的 keyword 物件，包含所有欄位
  const keywordData = {
    keyword,
    replies,
    addTags: Array.isArray(addTags) ? addTags : [],
    removeTags: Array.isArray(removeTags) ? removeTags : []
  };

  if (quickReplyId) {
    keywordData.quickReplyId = quickReplyId;
  }

  // 🆕 立即註冊所有標籤到全域清單（讓管理員可立即在「標籤管理」與「分眾選單」使用）
  const allTags = [...(keywordData.addTags || []), ...(keywordData.removeTags || [])];
  const registeredTags = [];

  for (const tag of allTags) {
    if (tag && tag.trim()) {
      const trimmedTag = tag.trim();
      await ensureTagExists(store, trimmedTag);
      registeredTags.push(trimmedTag);
    }
  }

  const index = existing.findIndex(item => item.keyword === keyword);
  if (index >= 0) {
    existing[index] = keywordData;
  } else {
    existing.push(keywordData);
  }

  await store.put('keywords', existing);

  // 🆕 回傳更詳細的資訊
  return jsonResponse({
    success: true,
    newTagsRegistered: registeredTags.length > 0 ? registeredTags : null
  });
}

// 取得所有 keyword replies
export async function handleListKeywordReplies(env, userId) {
  const store = await openBotStore(env, userId);
  const list = await store.getOr('keywords', []);
  return jsonResponse({ success: true, data: list });
}

// 刪除指定 keyword
export async function handleDeleteKeywordReply(request, env, userId) {
  const { keyword, keywords } = await request.json();

  const keywordsToDelete = [];
  if (keyword) keywordsToDelete.push(keyword);
  if (Array.isArray(keywords)) keywordsToDelete.push(...keywords);

  if (keywordsToDelete.length === 0) {
    console.warn("❌ [Delete] 缺少 keyword 或 keywords");
    return jsonResponse({ success: false, error: "缺少 keyword 或 keywords" }, 400);
  }

  const store = await openBotStore(env, userId);

  // 1️⃣ 刪除 keyword_reply_list
  const list = await store.getOr('keywords', []);

  const updated = list.filter(item => !keywordsToDelete.includes(item.keyword));
  await store.put('keywords', updated);

  // 2️⃣ 同時刪除 keyword_stats 中對應的統計
  const stats = await store.getOr('keywordStats', {});

  let statsModified = false;
  for (const k of keywordsToDelete) {
    if (stats[k]) {
      delete stats[k];
      statsModified = true;
    }
  }
  if (statsModified) {
    await store.put('keywordStats', stats);
  }

  return jsonResponse({ success: true, deleted: keywordsToDelete });
}

// 取得單一 keyword 的統計資料
async function handleKeywordStats(request, env, userId) {
  const { keyword } = await request.json();

  if (!keyword) {
    console.warn("❌ [Stats] 缺少 keyword");
    return jsonResponse({ success: false, error: "缺少 keyword" }, 400);
  }

  const store = await openBotStore(env, userId);
  const stats = await store.getOr('keywordStats', {});
  const stat = stats[keyword] || { total: 0, monthly: {} };

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const thisMonth = stat.monthly?.[currentMonthKey] || 0;
  const lastMonth = stat.monthly?.[lastMonthKey] || 0;

  return jsonResponse({
    success: true,
    stats: {
      total: stat.total || 0,
      thisMonth,
      lastMonth
    }
  });
}

// 路由處理
export function route(request, env, userId, pathname) {

  if (pathname === "/keyword/save") return handleSaveKeywordReply(request, env, userId);
  if (pathname === "/keyword/list") return handleListKeywordReplies(env, userId);
  if (pathname === "/keyword/delete") return handleDeleteKeywordReply(request, env, userId);
  if (pathname === "/keyword/stats") return handleKeywordStats(request, env, userId);

  console.warn("❌ [Route] 找不到路由：", pathname);
  return jsonResponse({ success: false, error: "Invalid keyword route" }, 404);
}