/**
 * import_boundary.mjs — Bridge 模組邊界的檢查器（純函式 + 檔案掃描）
 *
 * 規則（與 eslint.config.js 的 no-restricted-imports 區塊一致，兩層防線）：
 *   (i)  `worker_src/bridge/` 以外的檔案不得 import `bridge/` 底下的任何東西，
 *        唯一例外是 composition root `worker_src/index.js`。
 *   (ii) `worker_src/bridge/*.js` 只能 import：
 *          - 同目錄的兄弟檔（./x.js，bridge 目錄是扁平的）
 *          - ../lm_service.js
 *          - ../lib/line_api.js、../lib/crypto_util.js、../lib/kv_schema.js、../lib/utils.js
 *          - ../middleware/rate_limiter.js
 *        其他一律違規（含 bare specifier：Bridge 不引入第三方依賴）。
 *
 * 所有路徑都以「相對 repo 根目錄、用 / 分隔」表示，例如 `worker_src/bridge/auth.js`。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE_DIR = 'worker_src/bridge';
export const COMPOSITION_ROOT = 'worker_src/index.js';

/** Bridge 可以 import 的非兄弟檔（相對 repo 根目錄） */
export const BRIDGE_ALLOWED_EXTERNAL = [
    'worker_src/lm_service.js',
    'worker_src/lib/line_api.js',
    'worker_src/lib/crypto_util.js',
    'worker_src/lib/kv_schema.js',
    'worker_src/lib/utils.js',
    'worker_src/middleware/rate_limiter.js',
];

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 取出一份原始碼裡所有 import / export-from / 動態 import 的 specifier。
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractSpecifiers(source) {
    const code = stripComments(source);
    const found = [];
    // import x from "a" / import {a,\n b} from "a" / export * from "a" / export {x} from "a"
    const staticRe = /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
    // import "a"（side-effect）
    const bareRe = /^\s*import\s*(['"])([^'"\n]+)\1/gm;
    // import("a")
    const dynamicRe = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
    for (const re of [staticRe, bareRe, dynamicRe]) {
        for (const m of code.matchAll(re)) found.push(m[2]);
    }
    return found;
}

function resolveSpecifier(importer, specifier) {
    if (!specifier.startsWith('.')) return null;
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
}

const isUnderBridge = (p) => p === BRIDGE_DIR || p.startsWith(`${BRIDGE_DIR}/`);

/**
 * 檢查單一檔案。
 *
 * @param {string} relPath 檔案路徑（相對 repo 根目錄）
 * @param {string} source 原始碼
 * @returns {Array<{file: string, specifier: string, rule: 'bridge-private'|'bridge-allowlist', message: string}>}
 */
export function checkFile(relPath, source) {
    const violations = [];
    const importerInBridge = isUnderBridge(relPath);

    for (const specifier of extractSpecifiers(source)) {
        const resolved = resolveSpecifier(relPath, specifier);

        if (importerInBridge) {
            const sibling = resolved !== null
                && path.posix.dirname(resolved) === BRIDGE_DIR
                && resolved.endsWith('.js');
            const allowed = sibling || (resolved !== null && BRIDGE_ALLOWED_EXTERNAL.includes(resolved));
            if (!allowed) {
                violations.push({
                    file: relPath,
                    specifier,
                    rule: 'bridge-allowlist',
                    message: `bridge 模組不得 import "${specifier}"；只能走 ../lm_service.js 或放行的共用模組`,
                });
            }
            continue;
        }

        if (resolved !== null && isUnderBridge(resolved) && relPath !== COMPOSITION_ROOT) {
            violations.push({
                file: relPath,
                specifier,
                rule: 'bridge-private',
                message: `${relPath} 不得 import bridge/（只有 ${COMPOSITION_ROOT} 可以）`,
            });
        }
    }
    return violations;
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * 掃描 `worker_src/**\/*.js`。
 *
 * @param {string} repoRoot repo 根目錄的絕對路徑
 * @returns {{files: number, violations: ReturnType<typeof checkFile>}}
 */
export function scanWorkerSrc(repoRoot) {
    const files = walk(path.join(repoRoot, 'worker_src'));
    const violations = [];
    for (const abs of files) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        violations.push(...checkFile(rel, fs.readFileSync(abs, 'utf8')));
    }
    return { files: files.length, violations };
}
