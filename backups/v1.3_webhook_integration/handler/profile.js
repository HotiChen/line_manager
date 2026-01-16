// lib/profile.js

import { jsonResponse } from "../lib/utils.js";

export async function handleSaveUserProfile(request, env, userId) {
  const data = await request.json();

  // 支援兩種格式：{ profile: {...} } 或直接 { userName, userEmail, ... }
  const profile = data.profile || data;

  if (!profile || typeof profile !== "object") {
    return jsonResponse({ error: "Invalid profile format" }, 400);
  }

  const key = `profile_${userId}`;
  await env.KV_LINE_STORAGE.put(key, JSON.stringify(profile));
  return jsonResponse({ ok: true, success: true, message: "已儲存使用者資訊", userId });
}

export async function handleCheckUserProfile(env, userId) {
  const key = `profile_${userId}`;
  const profile = await env.KV_LINE_STORAGE.get(key, { type: "json" });
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
