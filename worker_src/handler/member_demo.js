/**
 * 測試會員：一鍵產生 10 筆假會員、一鍵清除
 *
 *   POST /member/demo/seed    產生（冪等：固定 ID，重按不會變多）
 *   POST /member/demo/clear   清除（只刪測試會員）
 *
 * 用途：正式站剛上線、還沒有會員時，讓 owner 看會員頁的版面。假資料放在正式 KV，
 * 所以「清除」的安全性比「產生」更重要：
 *   - 假會員 ID 以 Udemo 開頭。真實 LINE userId 是 U + 32 位十六進位，
 *     m、o 不是十六進位字元，所以真實會員不可能撞到這個前綴
 *   - 清除只刪「前綴符合 且 profile.isDemo === true」的；兩個條件缺一不可
 *   - 不呼叫 LINE API、不同步 Rich Menu（假 ID 打過去只會產生錯誤）
 *   - 不帶標籤，不去動標籤索引
 * 只有 owner 能操作（路由層用 withPermission，見 handler/member.js）。
 */
import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";

export const DEMO_COUNT = 10;
export const DEMO_ID_PREFIX = "Udemo";

const ID_LENGTH = 33; // 與 LINE userId 同長：U + 32
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const NAMES = ["王小明", "陳美玲", "林志豪", "黃雅婷", "張家豪", "李佩珊", "吳承恩", "劉思穎", "蔡宗翰", "鄭怡君"];
const GENDERS = ["male", "female", "female", "male", "male", "female", "male", "female", "male", "female"];
const TEMPERATURES = ["hot", "warm", "cold"];
const TEMPERATURE_SCORES = { hot: 85, warm: 55, cold: 25 };

function demoId(index) {
  return DEMO_ID_PREFIX + String(index + 1).padStart(ID_LENGTH - DEMO_ID_PREFIX.length, "0");
}

/**
 * 產生測試會員的 profile。純函式：相同的 now 得到相同的結果。
 * 欄位形狀比照 handleSaveMember 寫入的 profile，會員頁才讀得動。
 *
 * @param {number} now
 * @returns {object[]}
 */
export function buildDemoMembers(now) {
  return NAMES.slice(0, DEMO_COUNT).map((name, i) => {
    const temperature = TEMPERATURES[i % TEMPERATURES.length];
    return {
      memberId: demoId(i),
      status: "active",
      source: "demo",
      name: `[測試] ${name}`,
      lineName: `[測試] ${name}`,
      pictureUrl: "",
      phone: `0900-000-${String(i + 1).padStart(3, "0")}`,
      gender: GENDERS[i],
      birthday: `199${i % 10}-0${(i % 9) + 1}-15`,
      joinedAt: new Date(now - (i + 1) * DAY_MS).toISOString(),
      lastInteraction: new Date(now - (i + 1) * HOUR_MS).toISOString(),
      totalInteractions: (i + 1) * 3,
      tier: i % 3,
      tags: [],
      note: "測試資料，可在會員頁用「清除測試會員」一鍵刪除",
      temperature,
      temperatureScore: TEMPERATURE_SCORES[temperature],
      isDemo: true,
    };
  });
}

function internalError(label, err) {
  // 只記訊息，不記 stack，也不回給呼叫端
  console.error(`[MemberDemo] ${label}:`, err && err.message);
  return jsonResponse({ success: false, error: "Internal error" }, 500);
}

/** 由 withPermission 注入 (request, env, userId, botId, role) */
export async function handleSeedDemoMembers(request, env, userId) {
  try {
    const store = await openBotStore(env, userId);
    const profiles = buildDemoMembers(Date.now());

    await Promise.all(profiles.map((p) => store.put("member", p, p.memberId)));

    // 清單只讀一次、寫一次；既有成員保持原順序，測試會員附在後面
    const list = await store.getOr("members", []);
    const known = new Set(list);
    const merged = [...list, ...profiles.map((p) => p.memberId).filter((id) => !known.has(id))];
    if (merged.length !== list.length) await store.put("members", merged);

    return jsonResponse({ success: true, created: profiles.length });
  } catch (err) {
    return internalError("seed", err);
  }
}

export async function handleClearDemoMembers(request, env, userId) {
  try {
    const store = await openBotStore(env, userId);
    const list = await store.getOr("members", []);

    const removed = [];
    for (const id of list) {
      if (typeof id !== "string" || !id.startsWith(DEMO_ID_PREFIX)) continue;
      const profile = await store.get("member", id);
      // 前綴只是第一道；profile 必須明確標記 isDemo 才刪
      if (profile && profile.isDemo === true) removed.push(id);
    }

    if (removed.length > 0) {
      await Promise.all(removed.flatMap((id) => [store.del("member", id), store.del("memberLog", id)]));
      const gone = new Set(removed);
      await store.put("members", list.filter((id) => !gone.has(id)));
    }

    return jsonResponse({ success: true, removed: removed.length });
  } catch (err) {
    return internalError("clear", err);
  }
}
