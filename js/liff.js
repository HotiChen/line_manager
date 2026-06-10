// js/liff.js
export async function initLiff(liffId) {
  try {
    // Timeout after 3s — falls back to URL-param userId in non-LINE environments
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LIFF init timeout')), 3000)
    );
    await Promise.race([liff.init({ liffId }), timeout]);

    if (!liff.isLoggedIn()) {
      console.warn("🟡 使用者未登入，導向 LINE Login");
      liff.login(); // 導向後會中止本頁執行
      return;       // 明確 return 中斷後續
    }

    const profile = await liff.getProfile();
    if (!profile || !profile.userId) {
      console.error("❌ 無法取得有效的使用者資料");
      return;
    }

    return profile;

  } catch (err) {
    console.error("❌ LIFF 初始化失敗", err);
    throw err;
  }
}