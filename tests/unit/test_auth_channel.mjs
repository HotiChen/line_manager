/**
 * Unit Tests — LIFF Channel 驗證與認證路由閘門
 *
 * 來源：origin/fix/auth-hardening (da45ae8) 的三項修補，重新套用在 fail-closed 版 auth.js 上。
 *
 * 這裡測三件既有測試沒有覆蓋的事：
 *
 * 1. verifyLiffToken 只檢查 token「有效」，不檢查它是「發給誰」的。
 *    任何 LINE 應用的使用者都能拿自己 app 的 access token 來通過本站認證，
 *    userId 是真的（所以 profile 查得到），但那個人從來沒授權過本站。
 *
 * 2. authenticate 用 `env.AUTH_MODE || "liff"`：只要值不是空的就照用。
 *    部署時把 AUTH_MODE 打成 "dev"、"LEGACY"、"production" 之類的任何字串，
 *    authMode 就不等於 "liff"，於是掉進 legacy 分支——X-User-Id 直接通行。
 *    fail-closed 的意思是只有明確的 "legacy" 才開，不是「不是 liff 就開」。
 *
 * 3. /api/* 從來沒進 requiresAuth 清單，但 index.js 把它接到 push_message。
 *    /api/send-message 的 userId 取自呼叫者自報的 X-User-Id，而 getAccessToken
 *    用那個 userId 去 KV 撈 current_token_<userId> / access_tokens_<userId>，
 *    等於任何人知道一個 userId 就能借用那個人的 LINE Channel token 發訊息。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

function mockLineApi({ clientId, userId = 'Uverified123', expiresIn = 3600 }) {
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('oauth2/v2.1/verify')) {
            const body = { expires_in: expiresIn };
            if (clientId !== undefined) body.client_id = clientId;
            return new Response(JSON.stringify(body), { status: 200 });
        }
        if (u.includes('v2/profile')) {
            return new Response(JSON.stringify({ userId, displayName: 'TestUser' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

async function loadAuth() {
    const { authenticate } = await import('../../worker_src/middleware/auth.js');
    return { authenticate };
}

function bearerRequest(token = 'valid_access_token', extra = {}) {
    const h = new Headers({ Authorization: `Bearer ${token}`, ...extra });
    return new Request('http://localhost/member/list', { headers: h });
}

describe('verifyLiffToken — Channel 歸屬驗證', () => {
    it('拒絕發給其他 Channel 的 access token', async () => {
        const { authenticate } = await loadAuth();
        mockLineApi({ clientId: '9999999999' });
        try {
            const result = await authenticate(bearerRequest(), {
                AUTH_MODE: 'liff',
                LIFF_CHANNEL_ID: '1653928585',
            });
            assert.equal(result.authenticated, false);
            assert.match(result.error, /channel/i);
        } finally {
            restoreFetch();
        }
    });

    it('接受發給本站 Channel 的 access token', async () => {
        const { authenticate } = await loadAuth();
        mockLineApi({ clientId: '1653928585' });
        try {
            const result = await authenticate(bearerRequest(), {
                AUTH_MODE: 'liff',
                LIFF_CHANNEL_ID: '1653928585',
            });
            assert.equal(result.authenticated, true);
            assert.equal(result.userId, 'Uverified123');
        } finally {
            restoreFetch();
        }
    });

    it('client_id 是數字、設定值是字串時仍視為相符', async () => {
        // LINE verify API 回的 client_id 是字串，但 env 來源若經過 JSON 設定可能是數字；
        // 兩邊都轉字串比較，避免型別不同造成「正確的 token 被拒」。
        const { authenticate } = await loadAuth();
        mockLineApi({ clientId: 1653928585 });
        try {
            const result = await authenticate(bearerRequest(), {
                AUTH_MODE: 'liff',
                LIFF_CHANNEL_ID: '1653928585',
            });
            assert.equal(result.authenticated, true);
        } finally {
            restoreFetch();
        }
    });

    it('verify 回應沒有 client_id 時拒絕（無法確認歸屬）', async () => {
        const { authenticate } = await loadAuth();
        mockLineApi({});
        try {
            const result = await authenticate(bearerRequest(), {
                AUTH_MODE: 'liff',
                LIFF_CHANNEL_ID: '1653928585',
            });
            assert.equal(result.authenticated, false);
        } finally {
            restoreFetch();
        }
    });

    it('env.LIFF_CHANNEL_ID 未設定時拒絕，不可放行（fail-closed）', async () => {
        // 漏設一個環境變數不該等於「關掉 Channel 檢查」。
        const { authenticate } = await loadAuth();
        mockLineApi({ clientId: '1653928585' });
        try {
            const result = await authenticate(bearerRequest(), { AUTH_MODE: 'liff' });
            assert.equal(result.authenticated, false);
            assert.match(result.error, /LIFF_CHANNEL_ID/);
        } finally {
            restoreFetch();
        }
    });
});

describe('authenticate — AUTH_MODE 只認明確的 legacy', () => {
    const typos = ['dev', 'LEGACY', 'development', 'production', 'true'];

    for (const mode of typos) {
        it(`AUTH_MODE="${mode}" 不得啟用 X-User-Id 回退`, async () => {
            const { authenticate } = await loadAuth();
            const request = new Request('http://localhost/member/list', {
                headers: new Headers({ 'X-User-Id': 'Uspoofed' }),
            });
            const result = await authenticate(request, { AUTH_MODE: mode });
            assert.equal(result.authenticated, false);
        });
    }

    it('AUTH_MODE="legacy" 仍可用 X-User-Id（本機開發不被破壞）', async () => {
        const { authenticate } = await loadAuth();
        const request = new Request('http://localhost/member/list', {
            headers: new Headers({ 'X-User-Id': 'Udev' }),
        });
        const result = await authenticate(request, { AUTH_MODE: 'legacy' });
        assert.equal(result.authenticated, true);
        assert.equal(result.userId, 'Udev');
    });
});

describe('requiresAuthentication — 路由閘門', () => {
    async function load() {
        const { requiresAuthentication } = await import('../../worker_src/middleware/auth_routes.js');
        return requiresAuthentication;
    }

    it('/api/send-message 必須認證', async () => {
        const requiresAuthentication = await load();
        assert.equal(requiresAuthentication('/api/send-message'), true);
    });

    it('/api/webhook 不需認證（由 LINE 簽章驗證）', async () => {
        const requiresAuthentication = await load();
        assert.equal(requiresAuthentication('/api/webhook'), false);
    });

    it('既有受保護路由不受影響', async () => {
        const requiresAuthentication = await load();
        for (const p of [
            '/token/list', '/richmenu/list', '/member/save', '/team/members',
            '/flex/get', '/imagemap/save', '/profile/get', '/keyword/list',
            '/tag/add', '/quickreply/save', '/tier/config', '/flow/save',
            '/stats/messages', '/user/bot/info', '/image/upload', '/alias/set',
        ]) {
            assert.equal(requiresAuthentication(p), true, `${p} 應該要認證`);
        }
    });

    it('既有公開路由維持公開', async () => {
        const requiresAuthentication = await load();
        for (const p of ['/team/invite/preview', '/debug-ping', '/admin/migrate', '/debug/kv']) {
            assert.equal(requiresAuthentication(p), false, `${p} 應該維持公開`);
        }
    });
});
