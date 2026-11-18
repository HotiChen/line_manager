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
const MAX_IN_FLIGHT = 6;

/**
 * Miniflare 的 D1 binding 是經本機 HTTP 呼叫 workerd；機器忙碌（CI、並行跑測試）時，同時送出太多請求會偶發
 * `fetch failed`（連線層錯誤，不是 SQL 錯誤）。兩層處理：
 *   1. 限制同時在途的請求數（MAX_IN_FLIGHT）：從源頭避免連線被打爆。SQLite 本來就是單寫入者，
 *      排隊不改變並行測試要驗證的語意（原子性由單句 SQL 與 batch 保證）。
 *   2. 只對「讀取」重試：重試寫入可能在第一次其實已套用時再套用一次（例如計數 +2），
 *      會讓並行測試的「恰好 N 個」斷言失準；寫入遇到連線錯誤直接丟出，讓測試明確失敗而不是默默重複。
 */
let inFlight = 0;
const waiters = [];
async function limited(fn) {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiters.push(resolve));
    inFlight++;
    try {
        return await fn();
    } finally {
        inFlight--;
        const next = waiters.shift();
        if (next) next();
    }
}

async function withRetry(fn, { retry }) {
    let lastErr;
    for (let attempt = 0; attempt < (retry ? 4 : 1); attempt++) {
        try {
            return await limited(fn);
        } catch (err) {
            lastErr = err;
            if (!retry || !TRANSIENT.test(String(err && err.message))) throw err;
            await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
    }
    throw lastErr;
}

const isRead = (sql) => /^\s*SELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

function wrapStatement(stmt, sql) {
    const retry = isRead(sql);
    return {
        [RAW]: stmt,
        bind: (...args) => wrapStatement(stmt.bind(...args), sql),
        run: (...a) => withRetry(() => stmt.run(...a), { retry }),
        first: (...a) => withRetry(() => stmt.first(...a), { retry }),
        all: (...a) => withRetry(() => stmt.all(...a), { retry }),
        raw: (...a) => withRetry(() => stmt.raw(...a), { retry }),
    };
}

function wrapDb(db) {
    return {
        prepare: (sql) => wrapStatement(db.prepare(sql), sql),
        batch: (stmts) => withRetry(() => db.batch(stmts.map((x) => (x && x[RAW]) || x)), { retry: false }),
        exec: (sql) => withRetry(() => db.exec(sql), { retry: false }),
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
