import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import manifestJSON from "__STATIC_CONTENT_MANIFEST";
const assetManifest = JSON.parse(manifestJSON);

import { jsonResponse, getCorsHeaders } from "./lib/utils.js";
import { authenticate } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate_limiter.js";
import * as KeywordReplyHandler from "./handler/keyword_reply.js";
import * as TagHandler from "./handler/tag.js";
import * as routeMember from "./handler/member.js";
import * as imageHandler from "./handler/image_msg.js";
import * as QuickReplyHandler from "./handler/quick_reply.js";
import * as TeamHandler from "./handler/team.js";
import * as BotHandler from "./handler/bot.js";
import * as MigrationHandler from "./migration/migrate.js";
import { getMessageStats } from "./lib/message_stats.js";


import * as tokenHandlers from "./handler/token.js";
import * as richmenuHandlers from "./handler/richmenu.js";
import * as flexHandlers from "./handler/flex.js";
import * as imagemapHandlers from "./handler/imagemap.js";
import * as profileHandlers from "./handler/profile.js";
import * as pushMessageHandlers from "./handler/push_message.js";
import * as webhookHandlers from "./handler/webhook.js";
import * as segmentedRichMenuHandlers from "./handler/segmented_richmenu.js";
import { handleTagQueue } from "./queue/tag_consumer.js";
import * as TierHandler from "./handler/tier.js";
import * as FlowHandler from "./handler/flow.js";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 🔹 處理 CORS 預檢請求 (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...getCorsHeaders(request, env),
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 1️⃣ 靜態資源處理 (排除 API 路徑)
    const isApiRequest =
      pathname.startsWith("/token") ||
      pathname.startsWith("/richmenu") ||
      pathname.startsWith("/alias") ||
      pathname.startsWith("/flex") ||
      pathname.startsWith("/imagemap") ||
      pathname.startsWith("/profile") ||
      pathname.startsWith("/member") ||
      pathname.startsWith("/tag") ||
      pathname.startsWith("/keyword") ||
      pathname.startsWith("/image") ||
      pathname.startsWith("/team") ||
      pathname.startsWith("/user/bot") ||
      pathname.startsWith("/quickreply") ||
      pathname.startsWith("/quick_reply") ||
      pathname.startsWith("/admin") ||
      pathname.startsWith("/tier") ||
      pathname.startsWith("/flow") ||
      pathname.startsWith("/stats") ||
      pathname.startsWith("/debug") ||
      pathname.startsWith("/api") ||
      pathname === "/debug-ping" ||
      pathname === "/admin/migrate";

    if (!isApiRequest) {
      try {
        return await getAssetFromKV(
          { request, waitUntil: ctx.waitUntil.bind(ctx) },
          { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
        );
      } catch (e) {
        // 如果找不到靜態資源，且不是 API，則回傳 index.html (SPA routing)
        try {
          return await getAssetFromKV(
            { request: new Request(`${url.origin}/index.html`), waitUntil: ctx.waitUntil.bind(ctx) },
            { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
          );
        } catch (e2) {
          return new Response("Not Found", { status: 404 });
        }
      }
    }

    // 2️⃣ API 請求處理 — 使用 auth middleware 驗證身份
    // /team/invite/preview は公開エンドポイント（認証不要）、それ以外の /team/* は認証必須（SEC-001）
    const requiresAuth = pathname.startsWith("/token") || pathname.startsWith("/richmenu") || pathname.startsWith("/alias") ||
      pathname.startsWith("/flex") || pathname.startsWith("/imagemap") || pathname.startsWith("/profile") ||
      pathname.startsWith("/member") || pathname.startsWith("/keyword") ||
      pathname.startsWith("/tag") || pathname.startsWith("/quickreply") || pathname.startsWith("/quick_reply") ||
      pathname.startsWith("/tier") || pathname.startsWith("/flow") || pathname.startsWith("/stats") ||
      pathname.startsWith("/user/bot") || pathname.startsWith("/image") ||
      // /team routes — exclude /team/invite/preview which is public
      (pathname.startsWith("/team") && pathname !== "/team/invite/preview");

    let userId;

    if (requiresAuth) {
      const auth = await authenticate(request, env);
      if (!auth.authenticated) {
        return jsonResponse({ error: auth.error || "Unauthorized" }, 401, request, env);
      }
      userId = auth.userId;

      // Rate limiting（已驗證的用戶）
      const rateLimitResponse = await rateLimitMiddleware(env, userId);
      if (rateLimitResponse) return rateLimitResponse;
    } else {
      // 非認證 API（如 webhook、debug、admin），從 header 取得 userId（可選）
      userId = request.headers.get("X-User-Id") || url.searchParams.get("userId");
    }

    // 🆕 等級系統 API (最優先處理)
    if (pathname.startsWith("/tier")) {
      if (request.method === "OPTIONS") return jsonResponse({}, 200);
      if (pathname === "/tier/config") {
        if (request.method === "GET") return TierHandler.handleGetTierConfig(request, env, userId);
        if (request.method === "POST") return TierHandler.handleUpdateTierConfig(request, env, userId);
      }
      if (pathname === "/tier/set") return TierHandler.handleSetMemberTier(request, env, userId);
      if (pathname === "/tier/stats") return TierHandler.handleGetTierStats(request, env, userId);
    }

    // 統計相關 API (Support legacy path and new path)
    if (pathname === "/stats" || pathname === "/stats/messages") {
      if (request.method === "OPTIONS") return jsonResponse({}, 200);
      const stats = await getMessageStats(env, userId);
      return jsonResponse({ success: true, stats });
    }

    // 將路由導向對應的模組
    if (pathname.startsWith("/token")) return tokenHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/richmenu/segmented")) return segmentedRichMenuHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/richmenu")) return richmenuHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/alias")) return richmenuHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/flex")) return flexHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/imagemap")) return imagemapHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/profile")) return profileHandlers.route(request, env, userId, pathname);
    if (pathname.startsWith("/keyword")) return KeywordReplyHandler.route(request, env, userId, pathname);
    if (pathname.startsWith("/tag")) return TagHandler.route(request, env, userId, pathname);
    if (pathname.startsWith("/member")) return routeMember.route(request, env, userId, pathname, url);
    if (pathname.startsWith("/image")) return imageHandler.route(request, env, userId, pathname, url);
    if (pathname.startsWith("/team")) return TeamHandler.route(request, env, userId, pathname);
    if (pathname.startsWith("/user/bot")) return BotHandler.route(request, env, userId, pathname);
    if (pathname.startsWith("/flow")) return FlowHandler.route(request, env, userId, pathname);
    if (pathname.startsWith("/quickreply")) return QuickReplyHandler.route(request, env, userId, pathname);
    if (pathname === "/api/webhook") return webhookHandlers.handleWebhookRequest(request, env, ctx);
    if (pathname.startsWith("/api")) return pushMessageHandlers.route(request, env, userId, pathname);

    if (pathname === "/debug-ping" || pathname === "/tier/ping") {
      return jsonResponse({ success: true, version: "V6_DEPLOY_RETRY" });
    }

    // 資料遷移 API (Admin Only)
    if (pathname === "/admin/migrate") {
      return MigrationHandler.handleMigrate(request, env);
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },

  // 🆕 Queue Consumer Handler
  async queue(batch, env) {
    return handleTagQueue(batch, env);
  }
};