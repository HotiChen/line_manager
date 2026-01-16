import { jsonResponse } from "../lib/utils.js";

// 儲存一組 keyword + replies
export async function handleSaveKeywordReply(request, env, userId) {
  const { keyword, replies } = await request.json();
  console.log("📝 [Save] 收到資料：", { keyword, replies });

  if (!keyword || !Array.isArray(replies)) {
    console.warn("❌ [Save] 缺少必要欄位");
    return jsonResponse({ success: false, error: "缺少必要欄位" }, 400);
  }

  const listKey = `keyword_reply_list_${userId}`;
  const existing = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");

  console.log("📦 [Save] 現有資料：", existing);

  const index = existing.findIndex(item => item.keyword === keyword);
  if (index >= 0) {
    console.log("🔄 [Save] 覆蓋已存在的 keyword");
    existing[index] = { keyword, replies };
  } else {
    console.log("➕ [Save] 新增新 keyword");
    existing.push({ keyword, replies });
  }

  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(existing));
  console.log("✅ [Save] 已儲存至 KV");
  return jsonResponse({ success: true });
}

// 取得所有 keyword replies
export async function handleListKeywordReplies(env, userId) {
  const listKey = `keyword_reply_list_${userId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  console.log("📋 [List] 所有關鍵字回覆：", list);
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

  console.log("🗑️ [Delete] 要刪除的 keyword(s)：", keywordsToDelete);

  // 1️⃣ 刪除 keyword_reply_list
  const listKey = `keyword_reply_list_${userId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");

  const updated = list.filter(item => !keywordsToDelete.includes(item.keyword));
  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));
  console.log("✅ [Delete] 已更新 keyword_reply_list");

  // 2️⃣ 同時刪除 keyword_stats 中對應的統計
  const statsKey = `keyword_stats_${userId}`;
  const stats = await env.KV_LINE_STORAGE.get(statsKey, { type: "json" }) || {};

  let statsModified = false;
  for (const k of keywordsToDelete) {
    if (stats[k]) {
      delete stats[k];
      statsModified = true;
    }
  }
  if (statsModified) {
    await env.KV_LINE_STORAGE.put(statsKey, JSON.stringify(stats));
    console.log("📉 [Delete] 已刪除對應的統計資料");
  }

  return jsonResponse({ success: true, deleted: keywordsToDelete });
}

// export async function handleDeleteKeywordReply(request, env, userId) {
//   const { keyword } = await request.json();
//   console.log("🗑️ [Delete] 要刪除的 keyword：", keyword);

//   if (!keyword) return jsonResponse({ success: false, error: "缺少 keyword" }, 400);

//   // 1️⃣ 刪除 keyword_reply_list
//   const listKey = `keyword_reply_list_${userId}`;
//   const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
//   const updated = list.filter(item => item.keyword !== keyword);

//   console.log("🧹 [Delete] 更新後清單：", updated);
//   await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));

//   // 2️⃣ 同時刪除 keyword_stats
//   const statsKey = `keyword_stats_${userId}`;
//   const stats = await env.KV_LINE_STORAGE.get(statsKey, { type: "json" }) || {};
//   if (stats[keyword]) {
//     console.log("📉 [Delete] 同時刪除統計資料");
//     delete stats[keyword];
//     await env.KV_LINE_STORAGE.put(statsKey, JSON.stringify(stats));
//   }

//   console.log("✅ [Delete] 刪除成功");
//   return jsonResponse({ success: true });
// }

// 取得單一 keyword 的統計資料
async function handleKeywordStats(request, env, userId) {
  const { keyword } = await request.json();
  console.log("📊 [Stats] 查詢 keyword：", keyword);

  if (!keyword) {
    console.warn("❌ [Stats] 缺少 keyword");
    return jsonResponse({ success: false, error: "缺少 keyword" }, 400);
  }

  const statsKey = `keyword_stats_${userId}`;
  const stats = await env.KV_LINE_STORAGE.get(statsKey, { type: "json" }) || {};
  const stat = stats[keyword] || { total: 0, monthly: {} };

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const thisMonth = stat.monthly?.[currentMonthKey] || 0;
  const lastMonth = stat.monthly?.[lastMonthKey] || 0;

  console.log("📈 [Stats] 回傳資料：", {
    total: stat.total || 0,
    thisMonth,
    lastMonth
  });

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
  console.log("📡 [Route] 處理路由：", pathname);

  if (pathname === "/keyword/save") return handleSaveKeywordReply(request, env, userId);
  if (pathname === "/keyword/list") return handleListKeywordReplies(env, userId);
  if (pathname === "/keyword/delete") return handleDeleteKeywordReply(request, env, userId);
  if (pathname === "/keyword/stats") return handleKeywordStats(request, env, userId);

  console.warn("❌ [Route] 找不到路由：", pathname);
  return jsonResponse({ success: false, error: "Invalid keyword route" }, 404);
}