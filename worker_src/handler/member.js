// routes/member.js
import { jsonResponse } from "../lib/utils.js";
import { addTagsToEntity, removeTagsFromEntity } from "../lib/tag_system.js";
import { syncMemberRichMenu } from "../lib/segmented_richmenu_logic.js";
import { applyTierRichMenu, getTierConfig } from "../lib/tier_system.js";

// 儲存或更新會員
export async function handleSaveMember(request, env, ownerId) {
  const data = await request.json();
  const {
    memberId: providedMemberId,
    lineUserId, // LIFF 註冊時使用
    name,
    email,
    lineName,
    pictureUrl,
    phone,
    gender,
    birthday,
    tags = [],
    note = "",
    temperature = "warm",
    status = "active",
    tier, // 🆕 新增等級欄位
    source = "manual"
  } = data;

  // 使用 lineUserId 或 memberId（LIFF 註冊優先使用 lineUserId）
  const memberId = lineUserId || providedMemberId;

  if (!memberId || typeof memberId !== "string") {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 memberId/lineUserId" }, 400);
  }

  const profileKey = `member_profile_${ownerId}_${memberId}`;
  const listKey = `member_list_${ownerId}`;

  // 取得現有 profile（如果存在）
  const existingProfile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");
  const oldTags = existingProfile.tags || [];

  const profile = {
    memberId,
    status: status || existingProfile.status || "active",
    source: source || existingProfile.source || "manual",
    name,
    email,
    lineName: lineName || existingProfile.lineName,
    pictureUrl: pictureUrl || existingProfile.pictureUrl || "",
    phone,
    gender,
    birthday,
    joinedAt: existingProfile.joinedAt || new Date().toISOString(),
    lastInteraction: new Date().toISOString(), // 更新最後互動時間
    totalInteractions: existingProfile.totalInteractions || 0,
    tier: tier !== undefined ? (typeof tier === 'string' ? parseInt(tier) : tier) : (existingProfile.tier || 0), // 🆕 儲存等級
    tags,
    note,
    temperature,
    temperatureScore: existingProfile.temperatureScore || 50
  };

  await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

  // 處理 Tag 變更（混合設計的核心）
  const tagsToAdd = tags.filter(t => !oldTags.includes(t));
  const tagsToRemove = oldTags.filter(t => !tags.includes(t));

  // 添加新 Tags（更新反向索引）
  if (tagsToAdd.length > 0) {
    await addTagsToEntity(env, ownerId, 'member', memberId, tagsToAdd);
  }

  // 移除舊 Tags（更新反向索引）
  if (tagsToRemove.length > 0) {
    await removeTagsFromEntity(env, ownerId, 'member', memberId, tagsToRemove);
  }

  // 加入 list（避免重複）
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  if (!list.includes(memberId)) {
    list.push(memberId);
    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(list));
  }

  // 🔄 同步圖文選單 (根據標籤自動切換 - 分眾)
  await syncMemberRichMenu(env, ownerId, memberId);

  // 🔄 同步圖文選單 (根據等級自動切換 - 分層)
  const tierConfig = await getTierConfig(env, ownerId);
  const isBenefitEnabled = !!tierConfig.benefits?.richMenu?.enabled;

  if (isBenefitEnabled) {
    try {
      // 獲取當前專案的 Access Token
      const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${ownerId}`, { type: 'json' }) || {};
      const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${ownerId}`);

      const currentData = tokenMap[currentProject];
      const accessToken = typeof currentData === 'string' ? currentData : currentData?.token;

      if (accessToken) {
        // 加上 await 確保 API 執行完畢
        await applyTierRichMenu(env, ownerId, memberId, profile.tier, accessToken);
      } else {
        console.warn(`⚠️ [Save] 無法取得有效 Access Token (專案: ${currentProject})`);
      }
    } catch (e) {
      console.error("❌ [Save] 同步等級 Rich Menu 失敗:", e);
    }
  } else {
  }

  return jsonResponse({ success: true, data: profile });
}

// 取得會員列表
export async function handleListMembers(env, ownerId) {
  const listKey = `member_list_${ownerId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  return jsonResponse({ success: true, data: list });
}

// 撈出所有會員詳細資料
export async function handleListFullMembers(env, ownerId) {
  const listKey = `member_list_${ownerId}`;
  const memberIds = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");

  const profiles = await Promise.all(
    memberIds.map(async memberId => {
      const key = `member_profile_${ownerId}_${memberId}`;
      const json = await env.KV_LINE_STORAGE.get(key);
      return JSON.parse(json || "null");
    })
  );

  return jsonResponse({
    success: true,
    data: profiles.filter(p => p !== null)
  });
}

// 取得單一會員資料
export async function handleGetMemberProfile(env, ownerId, memberId) {
  if (!memberId) {
    return jsonResponse({ success: false, error: "缺少 memberId" }, 400);
  }
  const key = `member_profile_${ownerId}_${memberId}`;
  const profile = await env.KV_LINE_STORAGE.get(key);
  return jsonResponse({ success: true, data: JSON.parse(profile || "null") });
}

// 刪除會員（含 profile, log, list 中移除）
export async function handleDeleteMember(request, env, ownerId) {
  const { memberId } = await request.json();
  if (!memberId) {
    return jsonResponse({ success: false, error: "缺少 memberId" }, 400);
  }

  const profileKey = `member_profile_${ownerId}_${memberId}`;
  const logKey = `member_log_${ownerId}_${memberId}`;
  const listKey = `member_list_${ownerId}`;

  // 移除 profile & log
  await env.KV_LINE_STORAGE.delete(profileKey);
  await env.KV_LINE_STORAGE.delete(logKey);

  // 更新列表
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  const updated = list.filter(id => id !== memberId);
  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));

  return jsonResponse({ success: true });
}

// 路由進入點
export function route(request, env, ownerId, pathname, url) {

  if (pathname === "/member/save") return handleSaveMember(request, env, ownerId);
  if (pathname === "/member/list") return handleListMembers(env, ownerId);
  if (pathname === "/member/delete") return handleDeleteMember(request, env, ownerId);
  if (pathname === "/member/list-full") return handleListFullMembers(env, ownerId);
  // 支援 /member/profile/:memberId
  const profileMatch = pathname.match(/^\/member\/profile\/(.+)$/);
  if (profileMatch) {
    return handleGetMemberProfile(env, ownerId, profileMatch[1]);
  }

  return jsonResponse({ success: false, error: "Invalid member route" }, 404);
}