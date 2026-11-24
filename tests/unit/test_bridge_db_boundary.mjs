/**
 * Unit Tests — Bridge 資料層的邊界（LM-1B）
 *
 *   - SQL 只在 worker_src/bridge/db.js；bridge/ 其他檔案不得出現 .prepare( 或 SQL 關鍵字敘述
 *   - BRIDGE_DB 只在 worker_src/bridge/ 之內被讀取（LM 核心看不到它）
 *   - db.js 不用字串拼接把值塞進 SQL（沒有 template literal 內插到 prepare 的 SQL 裡，除了固定的欄位清單常數）
 *   - bridge/ 不再讀寫已搬走的 KV key（system、systems、idem、service_key）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'worker_src');

function walk(dir) {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
    });
}
/** 去掉註解，免得說明文字裡的字被當成程式碼 */
const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const bridgeFiles = walk(join(SRC, 'bridge'));
const others = bridgeFiles.filter((f) => !f.endsWith('/db.js'));

describe('SQL 只在 bridge/db.js', () => {
    it('db.js 存在，且 bridge/ 還有其他檔案可檢查', () => {
        assert.ok(bridgeFiles.some((f) => f.endsWith('/db.js')));
        assert.ok(others.length >= 5, String(others.length));
    });

    it('bridge/ 其他檔案沒有 .prepare( / .batch( / SQL 敘述', () => {
        for (const f of others) {
            const c = code(f);
            assert.doesNotMatch(c, /\.prepare\s*\(/, relative(ROOT, f));
            assert.doesNotMatch(c, /\.batch\s*\(/, relative(ROOT, f));
            assert.doesNotMatch(c, /\b(SELECT\s+[\w*]|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|CREATE\s+TABLE)\b/i, relative(ROOT, f));
        }
    });

    it('bridge/ 其他檔案也不直接碰 env.BRIDGE_DB 以外的資料庫物件（只有 auth.js 做存在性檢查）', () => {
        for (const f of others) {
            const hits = code(f).match(/BRIDGE_DB/g) || [];
            if (!f.endsWith('/auth.js')) assert.equal(hits.length, 0, relative(ROOT, f));
        }
    });
});

describe('BRIDGE_DB 只在 worker_src/bridge/ 之內', () => {
    it('worker_src 其他地方都沒有讀它', () => {
        for (const f of walk(SRC)) {
            if (f.startsWith(join(SRC, 'bridge') + '/')) continue;
            assert.doesNotMatch(code(f), /BRIDGE_DB/, relative(ROOT, f));
        }
    });
});

describe('db.js 的 SQL 只用 bound parameter', () => {
    it('每個 .prepare( 的第一個參數是字串字面值或固定常數樣板，沒有 ${使用者值}', () => {
        const src = readFileSync(join(SRC, 'bridge', 'db.js'), 'utf8');
        // template literal 內插只允許 SYSTEM_COLUMNS 這個固定欄位清單
        const interpolations = [...src.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
        const inPrepare = [...src.matchAll(/\.prepare\(\s*`([^`]*)`/g)].flatMap((m) => [...m[1].matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1].trim()));
        for (const i of inPrepare) assert.equal(i, 'SYSTEM_COLUMNS', `prepare 內插了 ${i}`);
        assert.ok(interpolations.length >= inPrepare.length);
    });

    it('沒有用 + 把值接進 SQL', () => {
        const src = readFileSync(join(SRC, 'bridge', 'db.js'), 'utf8');
        assert.doesNotMatch(src, /\.prepare\(\s*["'][^"']*["']\s*\+/);
    });
});

describe('LM-3A：LINE userId 不外流', () => {
    it('db.js 只有三句 SELECT 讀出 line_user_id：getContactForSend（LM-3B 送訊息用）、consumeBindCode 的「原綁定者」子查詢（M-02 覆蓋通知用）、listSegmentRecipients（LM-4D 重新計算 Rich Menu 用）；其餘只寫入、或當 WHERE 條件', () => {
        const src = readFileSync(join(SRC, 'bridge', 'db.js'), 'utf8');
        const statements = [...src.matchAll(/\.prepare\(\s*(`[^`]*`|"[^"\n]*")/g)].map((m) => m[1]);
        assert.ok(statements.length > 20);
        // 「讀出」= line_user_id 出現在第一個 FROM 之前（選取清單或其子查詢）；只出現在 WHERE 的不算
        const readers = statements.filter((x) => /^[`"]\s*SELECT/i.test(x) && /line_user_id/.test(x.slice(0, x.search(/\bFROM\b/))));
        assert.equal(readers.length, 3, readers.join('\n'));
        const send = '"SELECT status, line_user_id FROM contacts WHERE link_id = ?1 AND external_contact_ref = ?2 AND bot_id = ?3"';
        assert.ok(readers.includes(send));
        // getContactForSend 的那句在函式之內
        const fn = src.slice(src.indexOf('export async function getContactForSend'), src.indexOf('export async function deleteContact'));
        assert.ok(fn.includes(send));
        // LM-4D：listSegmentRecipients 的那句在函式之內，只讀某條連結範圍內的列
        const segFn = src.slice(src.indexOf('export async function listSegmentRecipients'), src.indexOf('export async function listUserSegments'));
        const seg = readers.find((x) => segFn.includes(x));
        assert.ok(seg, 'listSegmentRecipients 沒有讀 line_user_id 的 SELECT');
        assert.match(seg, /WHERE link_id = \?1/);
        // 另一句只能在 consumeBindCode 之內，而且只讀「同一個 (連結, ref)」的那一列
        const other = readers.find((x) => x !== send && x !== seg);
        const consumeFn = src.slice(src.indexOf('export async function consumeBindCode'), src.indexOf('export async function upsertContactBinding'));
        assert.ok(consumeFn.includes(other));
        assert.match(other, /WHERE c\.link_id = b\.link_id AND c\.external_contact_ref = b\.external_contact_ref\)/);
        // 其餘函式（計數、旗標、稽核）沒有碰 line_user_id
        const counters = src.slice(src.indexOf('export async function takeToken'), src.indexOf('// ── 冪等 ──'));
        assert.doesNotMatch(counters, /line_user/);
    });

    it('consumeBindCode（會回傳 previousUserId）只有 binding.js 在用', () => {
        for (const f of walk(SRC)) {
            if (f.endsWith('/bridge/db.js') || f.endsWith('/bridge/binding.js')) continue;
            assert.doesNotMatch(code(f), /consumeBindCode|previousUserId/, relative(ROOT, f));
        }
        assert.match(code(join(SRC, 'bridge', 'binding.js')), /consumeBindCode/);
    });

    it('listSegmentRecipients（會回傳 LINE userId）只有 segments.js 在用', () => {
        for (const f of walk(SRC)) {
            if (f.endsWith('/bridge/db.js') || f.endsWith('/bridge/segments.js')) continue;
            assert.doesNotMatch(code(f), /listSegmentRecipients/, relative(ROOT, f));
        }
        assert.match(code(join(SRC, 'bridge', 'segments.js')), /listSegmentRecipients/);
    });

    it('LM-4B：getBoundContactByUser、getEventTarget（含密文密鑰）只有 events.js 在用；event_secret_enc 只在 db.js 與 events 相關檔案出現', () => {
        for (const f of walk(SRC)) {
            if (f.endsWith('/bridge/db.js') || f.endsWith('/bridge/events.js')) continue;
            assert.doesNotMatch(code(f), /getBoundContactByUser|getEventTarget/, relative(ROOT, f));
        }
        assert.match(code(join(SRC, 'bridge', 'events.js')), /getBoundContactByUser/);
        // 密文密鑰的欄位名只准出現在 db.js；links.js 只經 sealEventSecret 寫入，不讀出
        for (const f of walk(SRC)) {
            if (f.endsWith('/bridge/db.js')) continue;
            assert.doesNotMatch(code(f), /event_secret_enc/, relative(ROOT, f));
        }
    });

    it('LM-4B：events.js 把 LINE userId 只用在 WHERE／限流雜湊，不放進請求、稽核或 log', () => {
        const src = code(join(SRC, 'bridge', 'events.js'));
        // 送出去的本文由固定欄位組成
        const bodyStart = src.indexOf('const body = JSON.stringify({');
        const bodyEnd = src.indexOf('});', bodyStart);
        assert.doesNotMatch(src.slice(bodyStart, bodyEnd), /lineUserId|userId|replyToken|webhookEventId/);
        // audit() 與 console.* 的呼叫都不帶 userId／replyToken
        for (const m of src.matchAll(/(?:audit\(env, \{|console\.\w+\()[^;]*;/g)) {
            assert.doesNotMatch(m[0], /lineUserId|replyToken/, m[0]);
        }
        assert.doesNotMatch(src, /replyToken/);
    });

    it('getContactForSend 只有 notify.js 在用（其他 bridge 檔案與 LM 核心都不用）', () => {
        for (const f of walk(SRC)) {
            if (f.endsWith('/bridge/db.js') || f.endsWith('/bridge/notify.js')) continue;
            assert.doesNotMatch(code(f), /getContactForSend/, relative(ROOT, f));
        }
        assert.match(code(join(SRC, 'bridge', 'notify.js')), /getContactForSend/);
    });

    it('HTTP 處理檔（contacts.js、links.js）完全不碰 line_user_id / lineUserId', () => {
        for (const f of ['contacts.js', 'links.js']) {
            assert.doesNotMatch(code(join(SRC, 'bridge', f)), /line_?user_?id/i, f);
        }
    });

    it('稽核白名單 sanitizeDetail 沒有 line_user_id、external_contact_ref、綁定碼的欄位', () => {
        const src = readFileSync(join(SRC, 'bridge', 'db.js'), 'utf8');
        const body = src.slice(src.indexOf('function sanitizeDetail'), src.indexOf('export async function writeAudit'));
        assert.doesNotMatch(body, /line_user|userId|external_contact_ref|\bref\b|bind_code|\bcode\b/i);
    });
});

describe('bridge/ 不再使用已搬到 D1 的 KV key', () => {
    it('沒有 BotKeys.system / systems / idem、ServiceKeyKeys', () => {
        for (const f of bridgeFiles) {
            const c = code(f);
            assert.doesNotMatch(c, /BotKeys\.(system|systems|idem)\b/, relative(ROOT, f));
            assert.doesNotMatch(c, /ServiceKeyKeys/, relative(ROOT, f));
        }
    });

    it('KV 在 bridge/ 只剩額度快取與限流（quota.js、rate_limiter），auth/systems/messages 不直接用 KV_LINE_STORAGE', () => {
        for (const f of ['auth.js', 'systems.js', 'messages.js', 'db.js']) {
            assert.doesNotMatch(code(join(SRC, 'bridge', f)), /KV_LINE_STORAGE/, f);
        }
    });
});
