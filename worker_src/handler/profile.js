// lib/profile.js

import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";

export async function handleSaveUserProfile(request, env, userId) {
  const data = await request.json();

  // 支援兩種格式：{ profile: {...} } 或直接 { userName, userEmail, ... }
  const profile = data.profile || data;

  if (!profile || typeof profile !== "object") {
    return jsonResponse({ error: "Invalid profile format" }, 400);
  }

  const store = await openBotStore(env, userId);
  await store.putUser('profile', profile);
  return jsonResponse({ ok: true, success: true, message: "已儲存使用者資訊", userId });
}

export async function handleCheckUserProfile(env, userId) {
  const store = await openBotStore(env, userId);
  const profile = await store.getUser('profile');
  return jsonResponse({
    exists: !!profile,
    profile: profile || null
  });
}

export function route(request, env, userId, pathname) {
  if (pathname === "/profile/save" || pathname === "/profile/register") {
    return handleSaveUserProfile(request, env, userId);
  }
  if (pathname === "/profile/check" || pathname === "/profile/get") {
    return handleCheckUserProfile(env, userId);
  }
  return jsonResponse({ success: false, error: "Invalid profile route" }, 404);
}
