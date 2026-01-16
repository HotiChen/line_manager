// routes/member.js
import { jsonResponse } from "../lib/utils.js";
import { addTagsToEntity, removeTagsFromEntity } from "../lib/tag_system.js";

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
    tags,
    note,
    temperature,
    temperatureScore: existingProfile.temperatureScore || 50
  };

  await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
  console.log("✅ [Save] 已儲存會員:", memberId);

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
    console.log("📋 [List] 已更新 member list");
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
  console.log("🗑️ [Delete] 已刪除 profile & log:", memberId);

  // 更新列表
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  const updated = list.filter(id => id !== memberId);
  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));

  return jsonResponse({ success: true });
}

// 路由進入點
export function route(request, env, ownerId, pathname, url) {
  console.log("📡 [MemberRoute] 處理路由：", pathname);

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