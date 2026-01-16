// routes/member.js
import { jsonResponse } from "../lib/utils.js";

// 儲存或更新會員
export async function handleSaveMember(request, env, ownerId) {
  const data = await request.json();
  const {
    memberId,
    name,
    email,
    lineName,
    phone,
    gender,
    birthday,
    tags = [],
    note = "",
    temperature = "warm",
  } = data;

  if (!memberId || typeof memberId !== "string") {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 memberId" }, 400);
  }

  const profileKey = `member_profile_${ownerId}_${memberId}`;
  const listKey = `member_list_${ownerId}`;

  const profile = {
    memberId,
    name,
    email,
    lineName,
    phone,
    gender,
    birthday,
    joinedAt: new Date().toISOString(),
    tags,
    note,
    temperature,
  };

  await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
  console.log("✅ [Save] 已儲存會員:", memberId);

  // 加入 list（避免重複）
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  if (!list.includes(memberId)) {
    list.push(memberId);
    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(list));
    console.log("📋 [List] 已更新 member list");
  }

  return jsonResponse({ success: true });
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