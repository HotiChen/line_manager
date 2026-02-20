// routes/member.js
import { jsonResponse } from "../lib/utils.js";
import { addTagsToEntity, removeTagsFromEntity } from "../lib/tag_system.js";
import { syncMemberRichMenu } from "../lib/segmented_richmenu_logic.js";
import { applyTierRichMenu, getTierConfig } from "../lib/tier_system.js";

/**
 * handleSaveMember
 * 儲存或更新會員資料，並同步標籤與等級相關的 Rich Menu
 * 
 * Pre-conditions:
 * - request: 包含 memberId/lineUserId, name 等資料的 JSON 請求
 * - env: Cloudflare Worker 環境物件
 * - ownerId: 專案擁有者的唯一識別碼
 * 
 * Post-conditions:
 * - 若資料格式正確，更新 KV 儲存中的會員 Profile 與 List
 * - 自動同步分眾 (Tag) 與分層 (Tier) 的 Rich Menu
 * - 回傳包含更新後 Profile 的 JSON Response
 */
export async function handleSaveMember(request, env, ownerId) {
  const data = await request.json();
  const {
    memberId: providedMemberId,
    lineUserId,
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
    tier,
    source = "manual"
  } = data;

  const memberId = lineUserId || providedMemberId;

  if (!memberId || typeof memberId !== "string") {
    return jsonResponse({ success: false, error: "缺少或格式錯誤的 memberId/lineUserId" }, 400);
  }

  const profileKey = `member_profile_${ownerId}_${memberId}`;
  const listKey = `member_list_${ownerId}`;

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
    lastInteraction: new Date().toISOString(),
    totalInteractions: existingProfile.totalInteractions || 0,
    tier: tier !== undefined ? (typeof tier === 'string' ? parseInt(tier) : tier) : (existingProfile.tier || 0),
    tags,
    note,
    temperature,
    temperatureScore: existingProfile.temperatureScore || 50
  };

  await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

  // 處理 Tag 變更
  const tagsToAdd = tags.filter(t => !oldTags.includes(t));
  const tagsToRemove = oldTags.filter(t => !tags.includes(t));

  if (tagsToAdd.length > 0) {
    await addTagsToEntity(env, ownerId, 'member', memberId, tagsToAdd);
  }

  if (tagsToRemove.length > 0) {
    await removeTagsFromEntity(env, ownerId, 'member', memberId, tagsToRemove);
  }

  // 加入 list (避免重複)
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  if (!list.includes(memberId)) {
    list.push(memberId);
    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(list));
  }

  // 同步分眾 Rich Menu
  await syncMemberRichMenu(env, ownerId, memberId);

  // 同步等級 Rich Menu
  await handleTierRichMenuSync(env, ownerId, memberId, profile.tier);

  return jsonResponse({ success: true, data: profile });
}

/**
 * handleTierRichMenuSync
 * 內部輔助函數：根據等級同步 Rich Menu
 * 
 * Pre-conditions:
 * - env, ownerId, memberId: 基礎參數
 * - tier: 會員目前的等級
 */
async function handleTierRichMenuSync(env, ownerId, memberId, tier) {
  const tierConfig = await getTierConfig(env, ownerId);
  const isBenefitEnabled = !!tierConfig.benefits?.richMenu?.enabled;

  if (!isBenefitEnabled) return;

  try {
    const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${ownerId}`, { type: 'json' }) || {};
    const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${ownerId}`);
    const currentData = tokenMap[currentProject];
    const accessToken = typeof currentData === 'string' ? currentData : currentData?.token;

    if (accessToken) {
      await applyTierRichMenu(env, ownerId, memberId, tier, accessToken);
    } else {
      console.warn(`⚠️ [Save] 無法取得有效 Access Token (專案: ${currentProject})`);
    }
  } catch (e) {
    console.error("❌ [Save] 同步等級 Rich Menu 失敗:", e);
  }
}

/**
 * handleListMembers
 * 取得會員 ID 列表
 * 
 * Pre-conditions: env, ownerId 必須存在
 * Post-conditions: 回傳包含會員 ID 陣列的 Response
 */
export async function handleListMembers(env, ownerId) {
  const listKey = `member_list_${ownerId}`;
  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  return jsonResponse({ success: true, data: list });
}

/**
 * handleListFullMembers
 * 取得所有會員的詳細 Profile 列表
 * 
 * Pre-conditions: env, ownerId 必須存在
 * Post-conditions: 回傳包含所有有效 Profile 對象的陣列
 */
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

/**
 * handleGetMemberProfile
 * 取得單個會員的詳細資料
 * 
 * Pre-conditions: memberId 必須存在
 * Post-conditions: 回傳會員 Profile 對象，若不存在則為 null
 */
export async function handleGetMemberProfile(env, ownerId, memberId) {
  if (!memberId) {
    return jsonResponse({ success: false, error: "缺少 memberId" }, 400);
  }
  const key = `member_profile_${ownerId}_${memberId}`;
  const profile = await env.KV_LINE_STORAGE.get(key);
  return jsonResponse({ success: true, data: JSON.parse(profile || "null") });
}

/**
 * handleDeleteMember
 * 刪除會員相關的所有資料
 * 
 * Pre-conditions: 請求 body 包含 memberId
 * Post-conditions: 從 KV 中刪除 profile, log 並更新 list
 */
export async function handleDeleteMember(request, env, ownerId) {
  const { memberId } = await request.json();
  if (!memberId) {
    return jsonResponse({ success: false, error: "缺少 memberId" }, 400);
  }

  const profileKey = `member_profile_${ownerId}_${memberId}`;
  const logKey = `member_log_${ownerId}_${memberId}`;
  const listKey = `member_list_${ownerId}`;

  await Promise.all([
    env.KV_LINE_STORAGE.delete(profileKey),
    env.KV_LINE_STORAGE.delete(logKey)
  ]);

  const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");
  const updated = list.filter(id => id !== memberId);
  await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));

  return jsonResponse({ success: true });
}

/**
 * route
 * 路由分發進入點
 */
export function route(request, env, ownerId, pathname, url) {
  if (pathname === "/member/save") return handleSaveMember(request, env, ownerId);
  if (pathname === "/member/list") return handleListMembers(env, ownerId);
  if (pathname === "/member/delete") return handleDeleteMember(request, env, ownerId);
  if (pathname === "/member/list-full") return handleListFullMembers(env, ownerId);

  const profileMatch = pathname.match(/^\/member\/profile\/(.+)$/);
  if (profileMatch) {
    return handleGetMemberProfile(env, ownerId, profileMatch[1]);
  }

  return jsonResponse({ success: false, error: "Invalid member route" }, 404);
}