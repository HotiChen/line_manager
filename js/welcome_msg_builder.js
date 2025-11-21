// js/welcome_msg_builder.js

let userId = null;

export function pageInit(pageData) {
  userId = pageData.userId;
  console.log(`[welcome_msg_builder] page loaded, userId: ${userId}`);
}
