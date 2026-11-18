/**
 * mock_d1.mjs — 測試用的真 D1（Miniflare 內的 SQLite，與正式 D1 同一套語意）
 *
 * 結構只有一份來源：套用 migrations/ 底下**全部**的 *.sql（依檔名順序），
 * 測試裡不再重複寫 CREATE TABLE。
 *
 * 用法（每個測試檔一個實例；啟動約 2.6 秒，所以放在 before / after，不要放 beforeEach）：
 *
 *   let d1;
 *   before(async () => { d1 = await createTestD1(); });
 *   after(async () => { await d1.dispose(); });          // 不 dispose，node --test 會因 open handle 卡住
 *   beforeEach(async () => { await d1.reset(); });
 *   // env = { BRIDGE_DB: d1.db }
 */
import { Miniflare } from 'miniflare';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * @param {string} [upTo] 只讀到這個前綴（含）為止，例如 '0003'：模擬「還沒套用後續遷移」的資料庫
 * @returns {{name: string, sql: string}[]} 依檔名排序
 */
export function readMigrations(upTo) {
    return readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => upTo === undefined || f.slice(0, upTo.length) <= upTo)
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** 把 SQL 檔切成一句一句（去掉 -- 註解；遷移檔裡沒有字串內含分號或 trigger） */
export function splitStatements(sql) {
    return sql
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 對一個 D1 套用全部遷移檔 */
export async function applyMigrations(db, upTo) {
    for (const { sql } of readMigrations(upTo)) {
        for (const stmt of splitStatements(sql)) {
            await db.prepare(stmt).run();
        }
    }
}

const RAW = Symbol('rawStatement');
const TRANSIENT = /fetch failed/i;

/**
 * Miniflare 的 D1 binding 是經本機 HTTP 呼叫 workerd；機器忙碌（CI、並行跑測試）時偶爾回
 * `fetch failed`（連線層錯誤，不是 SQL 錯誤），會讓並行測試偶發紅燈。這裡只對這一種暫時性錯誤重試，
 * 其他錯誤（包含 SQL 失敗）一律原樣丟出，測試語意不變。
 */
async function withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!TRANSIENT.test(String(err && err.message))) throw err;
            await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
    }
    throw lastErr;
}

function wrapStatement(stmt) {
    return {
        [RAW]: stmt,
        bind: (...args) => wrapStatement(stmt.bind(...args)),
        run: (...a) => withRetry(() => stmt.run(...a)),
        first: (...a) => withRetry(() => stmt.first(...a)),
        all: (...a) => withRetry(() => stmt.all(...a)),
        raw: (...a) => withRetry(() => stmt.raw(...a)),
    };
}

function wrapDb(db) {
    return {
        prepare: (sql) => wrapStatement(db.prepare(sql)),
        batch: (stmts) => withRetry(() => db.batch(stmts.map((x) => (x && x[RAW]) || x))),
        exec: (sql) => withRetry(() => db.exec(sql)),
        dump: (...a) => db.dump(...a),
    };
}

/**
 * @param {{upTo?: string}} [opts] upTo：只套用到這個遷移前綴（含），用來測「缺最新遷移」的情況
 * @returns {Promise<{
 *   db: object,
 *   reset: () => Promise<void>,
 *   applyMigrations: () => Promise<void>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function createTestD1({ upTo } = {}) {
    const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: { BRIDGE_DB: 'test-bridge-db' },
    });
    const db = wrapDb(await mf.getD1Database('BRIDGE_DB'));
    await applyMigrations(db, upTo);

    return {
        db,
        applyMigrations: () => applyMigrations(db, upTo),

        /** 清空每個使用者資料表，並重設 AUTOINCREMENT 計數 */
        async reset() {
            const { results } = await db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
                .all();
            for (const { name } of results) await db.prepare(`DELETE FROM "${name}"`).run();
            await db.prepare("DELETE FROM sqlite_sequence").run().catch(() => {});
        },

        async dispose() {
            await mf.dispose();
        },
    };
}
