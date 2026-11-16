/**
 * Integration Tests — webhook 依 destination 選擇驗簽密鑰
 *
 * 問題：驗簽只用一個全域 LINE_CHANNEL_SECRET，其他官方帳號的 webhook 全部 401。
 *
 * 規則：
 *   1. destination 有登記自己的 channel secret → 只用它驗。用全域密鑰簽的請求必須被拒
 *      （否則持有全域密鑰的那個 OA 的人，可以偽造別的 bot 的事件）
 *   2. 沒登記 → 退回全域密鑰（既有 OA 不中斷），並記一筆警告
 *   3. WEBHOOK_GLOBAL_SECRET_DISABLED=1 → 不再退回全域密鑰（全部登記完之後的 fail-closed）
 *   4. 兩種密鑰都沒有 → 500（設定錯誤），不是放行
 *   5. destination 只用來「挑密鑰」，驗證仍以 HMAC 為準；destination 本身不可信
 *
 * 測試用空的 events 陣列：驗簽通過後不會觸發任何事件處理，只看 status。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { saveChannelSecret } from '../../worker_src/lib/channel_secret.js';
import { handleWebhookRequest } from '../../worker_src/handler/webhook.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const DEST_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const DEST_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const GLOBAL = 'a'.repeat(32);
const SECRET_A = 'b'.repeat(32);
const SECRET_B = 'c'.repeat(32);

let env;

const sign = (secret, body) => createHmac('sha256', secret).update(body, 'utf8').digest('base64');

function hook(body, secret) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (secret !== null) headers.set('x-line-signature', sign(secret, text));
    return new Request('https://example.com/api/webhook', { method: 'POST', headers, body: text });
}

const call = (body, secret) => handleWebhookRequest(hook(body, secret), env, { waitUntil() {} });

beforeEach(async () => {
    env = { KV_LINE_STORAGE: createMockKV(), TOKEN_ENCRYPTION_KEY: KEY, LINE_CHANNEL_SECRET: GLOBAL };
    await saveChannelSecret(env, DEST_A, SECRET_A);
});

describe('已登記自己的 channel secret', () => {
    it('用自己的密鑰簽 → 通過', async () => {
        assert.equal((await call({ destination: DEST_A, events: [] }, SECRET_A)).status, 200);
    });

    it('用全域密鑰簽 → 401（不可退回全域）', async () => {
        assert.equal((await call({ destination: DEST_A, events: [] }, GLOBAL)).status, 401);
    });

    it('用別的 bot 的密鑰簽 → 401', async () => {
        await saveChannelSecret(env, DEST_B, SECRET_B);
        assert.equal((await call({ destination: DEST_A, events: [] }, SECRET_B)).status, 401);
    });

    it('簽章錯誤 → 401', async () => {
        assert.equal((await call({ destination: DEST_A, events: [] }, 'd'.repeat(32))).status, 401);
    });

    it('沒有簽章 header → 401', async () => {
        assert.equal((await call({ destination: DEST_A, events: [] }, null)).status, 401);
    });

    it('兩個 OA 各用各的密鑰，互不影響', async () => {
        await saveChannelSecret(env, DEST_B, SECRET_B);
        assert.equal((await call({ destination: DEST_A, events: [] }, SECRET_A)).status, 200);
        assert.equal((await call({ destination: DEST_B, events: [] }, SECRET_B)).status, 200);
    });
});

describe('沒登記 → 退回全域密鑰（既有 OA 不中斷）', () => {
    it('用全域密鑰簽 → 通過', async () => {
        assert.equal((await call({ destination: DEST_B, events: [] }, GLOBAL)).status, 200);
    });

    it('用錯的密鑰 → 401', async () => {
        assert.equal((await call({ destination: DEST_B, events: [] }, SECRET_B)).status, 401);
    });

    it('body 沒有 destination → 用全域密鑰', async () => {
        assert.equal((await call({ events: [] }, GLOBAL)).status, 200);
        assert.equal((await call({ events: [] }, SECRET_A)).status, 401);
    });
});

describe('WEBHOOK_GLOBAL_SECRET_DISABLED=1', () => {
    beforeEach(() => { env.WEBHOOK_GLOBAL_SECRET_DISABLED = '1'; });

    it('已登記的 OA 照常通過', async () => {
        assert.equal((await call({ destination: DEST_A, events: [] }, SECRET_A)).status, 200);
    });

    it('未登記的 OA 即使用全域密鑰簽也 401', async () => {
        assert.equal((await call({ destination: DEST_B, events: [] }, GLOBAL)).status, 401);
    });

    it('只有精確的 "1" 才算停用（"0"、"false"、空字串都不算）', async () => {
        for (const v of ['0', 'false', '', 'no']) {
            env.WEBHOOK_GLOBAL_SECRET_DISABLED = v;
            assert.equal((await call({ destination: DEST_B, events: [] }, GLOBAL)).status, 200, v);
        }
    });
});

describe('設定錯誤與壞輸入', () => {
    it('沒有全域密鑰、也沒登記 → 500，不是放行', async () => {
        delete env.LINE_CHANNEL_SECRET;
        assert.equal((await call({ destination: DEST_B, events: [] }, GLOBAL)).status, 500);
    });

    it('沒有全域密鑰，但已登記的 OA 仍可通過', async () => {
        delete env.LINE_CHANNEL_SECRET;
        assert.equal((await call({ destination: DEST_A, events: [] }, SECRET_A)).status, 200);
    });

    it('destination 含 ":" 不會丟例外，視為未登記', async () => {
        const res = await call({ destination: 'bot:evil', events: [] }, GLOBAL);
        assert.equal(res.status, 200);
    });

    it('destination 不是字串（物件、陣列）→ 視為未登記，不丟例外', async () => {
        assert.equal((await call({ destination: { x: 1 }, events: [] }, GLOBAL)).status, 200);
        assert.equal((await call({ destination: [DEST_A], events: [] }, GLOBAL)).status, 200);
    });

    it('已登記但密文壞掉（讀不出來）→ 視為未登記，退回全域，不是 500', async () => {
        await env.KV_LINE_STORAGE.put(`bot:${DEST_B}:credential`, '{nope');
        assert.equal((await call({ destination: DEST_B, events: [] }, GLOBAL)).status, 200);
    });

    it('非 POST → 405', async () => {
        const res = await handleWebhookRequest(new Request('https://x/api/webhook', { method: 'GET' }), env, {});
        assert.equal(res.status, 405);
    });
});

describe('密鑰不外洩', () => {
    it('401 回應不含任何密鑰或簽章', async () => {
        const res = await call({ destination: DEST_A, events: [] }, GLOBAL);
        const text = await res.text();
        for (const s of [SECRET_A, GLOBAL, sign(GLOBAL, JSON.stringify({ destination: DEST_A, events: [] }))]) {
            assert.ok(!text.includes(s));
        }
    });

    it('log 不含密鑰', async () => {
        const logs = [];
        const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
        for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
        try {
            await call({ destination: DEST_A, events: [] }, GLOBAL);
            await call({ destination: DEST_B, events: [] }, GLOBAL);
            await call({ destination: DEST_A, events: [] }, SECRET_A);
        } finally {
            Object.assign(console, orig);
        }
        const all = logs.join('\n');
        for (const s of [SECRET_A, GLOBAL]) assert.ok(!all.includes(s), `log 裡出現密鑰 ${s.slice(0, 4)}…`);
    });
});
