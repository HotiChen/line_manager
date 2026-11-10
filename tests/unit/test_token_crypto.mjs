/**
 * Unit Tests — token 的靜態加密
 *
 * LINE channel access token 目前以明文存在 KV。只保管自己三個帳號是一回事；
 * 要開放給別人用，就是在保管別人官方帳號的完全控制權 —— KV 一旦外洩就是
 * 所有人的帳號被接管。
 *
 * 設計取捨：
 *
 * 1. 密文是「字串」而不是物件。access_tokens 的結構是
 *    `{ [project]: { token, destination, displayName } }`，維持 token 欄位
 *    是字串，形狀就完全不變，不會波及任何讀這個結構的程式。
 *
 * 2. 格式帶版本（`enc.v1.<iv>.<ct>`）。將來換演算法或輪替金鑰時，要能同時
 *    讀得懂舊的；沒有版本就只能猜。
 *
 * 3. 明文必須照常讀得出來。正式環境已有明文 token，如果解密路徑不接受明文，
 *    加密上線的那一刻所有既有帳號立刻失效。
 *
 * 4. 加密時缺金鑰一律丟錯，不可默默存明文（fail-closed，CLAUDE.md 的要求）。
 *    解密時遇到密文卻缺金鑰也丟錯 —— 那是設定錯誤，不是可以容忍的狀態。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const PLAIN = 'a-very-secret-line-channel-access-token-0123456789';

/** 32 bytes，base64 —— 與 `openssl rand -base64 32` 的產出同格式 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

async function load() {
    return import('../../worker_src/lib/token_crypto.js');
}

describe('encryptToken / decryptToken 來回', () => {
    it('加密後能解回原值', async () => {
        const { encryptToken, decryptToken } = await load();
        const env = { TOKEN_ENCRYPTION_KEY: KEY };
        const sealed = await encryptToken(env, PLAIN);
        assert.equal(await decryptToken(env, sealed), PLAIN);
    });

    it('密文不得包含明文', async () => {
        const { encryptToken } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        assert.ok(!sealed.includes(PLAIN), '明文出現在密文裡');
    });

    it('密文是字串，形狀不變', async () => {
        const { encryptToken } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        assert.equal(typeof sealed, 'string');
    });

    it('同一個明文每次加密的密文都不同（IV 隨機）', async () => {
        const { encryptToken } = await load();
        const env = { TOKEN_ENCRYPTION_KEY: KEY };
        const a = await encryptToken(env, PLAIN);
        const b = await encryptToken(env, PLAIN);
        assert.notEqual(a, b, 'IV 沒有隨機化 —— 相同明文產生相同密文會洩漏資訊');
    });

    it('密文帶版本前綴，將來才能換演算法', async () => {
        const { encryptToken } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        assert.ok(sealed.startsWith('enc.v1.'), `缺版本前綴：${sealed.slice(0, 20)}`);
    });

    it('中文與長字串也要能來回', async () => {
        const { encryptToken, decryptToken } = await load();
        const env = { TOKEN_ENCRYPTION_KEY: KEY };
        for (const value of ['短', '熱茶小秘書的 token', 'x'.repeat(4096)]) {
            assert.equal(await decryptToken(env, await encryptToken(env, value)), value);
        }
    });
});

describe('明文向下相容', () => {
    it('明文 token 原樣回傳（既有資料不可失效）', async () => {
        const { decryptToken } = await load();
        assert.equal(await decryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN), PLAIN);
    });

    it('沒有金鑰時明文也要讀得出來', async () => {
        const { decryptToken } = await load();
        assert.equal(await decryptToken({}, PLAIN), PLAIN);
    });

    it('isEncrypted 分得出密文與明文', async () => {
        const { encryptToken, isEncrypted } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        assert.equal(isEncrypted(sealed), true);
        assert.equal(isEncrypted(PLAIN), false);
        assert.equal(isEncrypted(''), false);
        assert.equal(isEncrypted(null), false);
    });
});

describe('fail-closed', () => {
    it('加密時缺金鑰必須丟錯，不可回明文', async () => {
        const { encryptToken } = await load();
        await assert.rejects(() => encryptToken({}, PLAIN), /TOKEN_ENCRYPTION_KEY/);
    });

    it('解密密文時缺金鑰必須丟錯', async () => {
        const { encryptToken, decryptToken } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        await assert.rejects(() => decryptToken({}, sealed), /TOKEN_ENCRYPTION_KEY/);
    });

    it('金鑰長度不對時丟錯', async () => {
        const { encryptToken } = await load();
        await assert.rejects(
            () => encryptToken({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }, PLAIN),
            /32/);
    });

    it('換了金鑰解不開，而且不可回傳垃圾', async () => {
        const { encryptToken, decryptToken } = await load();
        const sealed = await encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, PLAIN);
        await assert.rejects(() => decryptToken({ TOKEN_ENCRYPTION_KEY: OTHER_KEY }, sealed));
    });

    it('密文被篡改時丟錯（GCM 的完整性保護）', async () => {
        const { encryptToken, decryptToken } = await load();
        const env = { TOKEN_ENCRYPTION_KEY: KEY };
        const sealed = await encryptToken(env, PLAIN);
        const parts = sealed.split('.');
        const bytes = Buffer.from(parts[3], 'base64url');
        bytes[0] ^= 0xff;
        parts[3] = bytes.toString('base64url');
        await assert.rejects(() => decryptToken(env, parts.join('.')));
    });

    it('格式壞掉的密文丟錯，不可當成明文放行', async () => {
        const { decryptToken } = await load();
        const env = { TOKEN_ENCRYPTION_KEY: KEY };
        for (const bad of ['enc.v1.', 'enc.v1.only-two', 'enc.v9.aa.bb']) {
            await assert.rejects(() => decryptToken(env, bad), undefined, `${bad} 竟然沒丟錯`);
        }
    });

    it('非字串輸入丟錯', async () => {
        const { encryptToken } = await load();
        await assert.rejects(() => encryptToken({ TOKEN_ENCRYPTION_KEY: KEY }, null));
    });
});
