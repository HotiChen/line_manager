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

/** @returns {{name: string, sql: string}[]} 依檔名排序 */
export function readMigrations() {
    return readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
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
export async function applyMigrations(db) {
    for (const { sql } of readMigrations()) {
        for (const stmt of splitStatements(sql)) {
            await db.prepare(stmt).run();
        }
    }
}

/**
 * @returns {Promise<{
 *   db: object,
 *   reset: () => Promise<void>,
 *   applyMigrations: () => Promise<void>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function createTestD1() {
    const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: { BRIDGE_DB: 'test-bridge-db' },
    });
    const db = await mf.getD1Database('BRIDGE_DB');
    await applyMigrations(db);

    return {
        db,
        applyMigrations: () => applyMigrations(db),

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
