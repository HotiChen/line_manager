// lib/imagemap.js

import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";

export async function handleSaveImagemapData(request, env, userId) {
  const { imagemaps } = await request.json();
  if (!Array.isArray(imagemaps)) return jsonResponse({ error: "Invalid imagemap data" }, 400);

  const store = await openBotStore(env, userId);
  await store.put('imagemaps', imagemaps);
  return jsonResponse({ success: true, message: `已儲存 ${imagemaps.length} 筆 ImageMap` });
}

export async function handleListImagemaps(env, userId) {
  try {
    const store = await openBotStore(env, userId);
    return jsonResponse({ success: true, imagemaps: await store.getOr('imagemaps', []) });
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