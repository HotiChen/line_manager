/**
 * 連結（link）流程的 scope 常數（LM-2A）
 *
 * 連結流程只可能發出這幾種 scope（LM-4D 加了 segments:write）。`raw:push`（以及過渡期的舊名 `messages:push`）屬於 owner 手動發放的
 * 信任金鑰，連結流程永遠不能發出，也不能被登記進產品（見 links.js 的產品登記驗證與 auth.js 的 principal 過濾）。
 */
export const LINK_SCOPES = Object.freeze(["link:manage", "contacts:bind", "messages:send", "segments:write"]);

/** 連結流程絕不可出現的 scope（測試用來斷言） */
export const FORBIDDEN_LINK_SCOPES = Object.freeze(["raw:push", "messages:push"]);

/**
 * 保留 `scopes` 中屬於 LINK_SCOPES 的項目（去重、依 LINK_SCOPES 的順序）。
 *
 * @param {unknown} scopes
 * @returns {string[]}
 */
export function onlyLinkScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return LINK_SCOPES.filter((s) => scopes.includes(s));
}
