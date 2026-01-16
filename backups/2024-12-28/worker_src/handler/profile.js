// lib/profile.js

import { jsonResponse } from "../lib/utils";

export async function handleSaveUserProfile(request, env, userId) {
  const { profile } = await request.json();
  if (!profile || typeof profile !== "object") {
    return jsonResponse({ error: "Invalid profile format" }, 400);
  }

  const key = `profile_${userId}`;
  await env.KV_LINE_STORAGE.put(key, JSON.stringify(profile));
  return jsonResponse({ success: true, message: "已儲存使用者資訊" });
}

export async function handleGetUserProfile(env, userId) {
  const key = `profile_${userId}`;
  const profile = await env.KV_LINE_STORAGE.get(key);
  return jsonResponse({ profile: profile ? JSON.parse(profile) : null });
}

export function route(request, env, userId, pathname) {
    if (pathname === "/profile/save") return handleSaveUserProfile(request, env, userId);
    if (pathname === "/profile/get") return handleGetUserProfile(env, userId);
    return jsonResponse({ success: false, error: "Invalid profile route" }, 404);
  }
  