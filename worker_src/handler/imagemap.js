// lib/imagemap.js

import { jsonResponse } from "../lib/utils.js";

export async function handleSaveImagemapData(request, env, userId) {
  const { imagemaps } = await request.json();
  if (!Array.isArray(imagemaps)) return jsonResponse({ error: "Invalid imagemap data" }, 400);

  await env.KV_LINE_STORAGE.put(`imagemap_${userId}`, JSON.stringify(imagemaps));
  return jsonResponse({ success: true, message: `已儲存 ${imagemaps.length} 筆 ImageMap` });
}

export async function handleListImagemaps(env, userId) {
  try {
    const key = `imagemap_${userId}`;
    const raw = await env.KV_LINE_STORAGE.get(key);
    if (!raw) return jsonResponse({ success: true, imagemaps: [] });
    return jsonResponse({ success: true, imagemaps: JSON.parse(raw) });
  } catch (err) {
    console.error("[handleListImagemaps] ❌", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

export function route(request, env, userId, pathname) {
  if (pathname === "/imagemap/save") return handleSaveImagemapData(request, env, userId);
  if (pathname === "/imagemap/list") return handleListImagemaps(env, userId);

  return jsonResponse({ success: false, error: "Invalid imagemap route" }, 404);
}