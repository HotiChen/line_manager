#!/usr/bin/env node
/**
 * Pre-Deploy 檢查腳本
 * 在部署前自動驗證所有必要條件
 *
 * 用法：node scripts/pre_deploy_check.mjs [--env production|dev]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ENV = process.argv.includes('--env')
    ? process.argv[process.argv.indexOf('--env') + 1]
    : 'production';

let passed = 0;
let failed = 0;
let warnings = 0;

function check(name, fn) {
    try {
        const result = fn();
        if (result === 'warn') {
            console.log(`  ⚠️  ${name}`);
            warnings++;
        } else {
            console.log(`  ✅ ${name}`);
            passed++;
        }
    } catch (err) {
        console.log(`  ❌ ${name}`);
        console.log(`     → ${err.message}`);
        failed++;
    }
}

const ROOT = path.resolve(import.meta.dirname, '..');

console.log(`\n🔍 Pinti LINE - Pre-Deploy Check (env: ${ENV})`);
console.log('='.repeat(50));

// ═══════════════════════════════════════
// 1. 檔案結構檢查
// ═══════════════════════════════════════
console.log('\n📁 檔案結構:');

check('wrangler.jsonc 存在', () => {
    if (!fs.existsSync(path.join(ROOT, 'wrangler.jsonc')))
        throw new Error('缺少 wrangler.jsonc');
});

check('worker_src/index.js 存在', () => {
    if (!fs.existsSync(path.join(ROOT, 'worker_src/index.js')))
        throw new Error('缺少 worker entry point');
});

check('worker_src/middleware/auth.js 存在', () => {
    if (!fs.existsSync(path.join(ROOT, 'worker_src/middleware/auth.js')))
        throw new Error('缺少 auth middleware');
});

check('worker_src/middleware/rate_limiter.js 存在', () => {
    if (!fs.existsSync(path.join(ROOT, 'worker_src/middleware/rate_limiter.js')))
        throw new Error('缺少 rate limiter');
});

check('.gitignore 存在', () => {
    if (!fs.existsSync(path.join(ROOT, '.gitignore')))
        throw new Error('缺少 .gitignore');
});

// ═══════════════════════════════════════
// 2. 安全性檢查
// ═══════════════════════════════════════
console.log('\n🔐 安全性:');

check('無硬編碼密鑰 (worker_src/)', () => {
    const files = getJSFiles(path.join(ROOT, 'worker_src'));
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        // Check for hardcoded secrets patterns
        if (/migration_secret_\d+/i.test(content)) {
            throw new Error(`發現硬編碼密鑰: ${path.relative(ROOT, file)}`);
        }
        if (/['"]Ud66f9caf[^'"]*['"]/i.test(content)) {
            throw new Error(`發現硬編碼 userId: ${path.relative(ROOT, file)}`);
        }
    }
});

check('無硬編碼 User ID (前端)', () => {
    const frontendDirs = ['js', 'helper', 'env'].map(d => path.join(ROOT, d));
    for (const dir of frontendDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = getJSFiles(dir);
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            if (/['"]Ud66f9caf44c4d927ca4f9361d66ccc18['"]/.test(content)) {
                throw new Error(`硬編碼 userId 在: ${path.relative(ROOT, file)}`);
            }
        }
    }
});

check('CORS 設定正確 (含 Authorization)', () => {
    const utils = fs.readFileSync(path.join(ROOT, 'worker_src/lib/utils.js'), 'utf-8');
    if (!utils.includes('Authorization')) {
        throw new Error('CORS headers 缺少 Authorization');
    }
});

check('.env 檔案未被追蹤', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
    if (!gitignore.includes('.env')) {
        throw new Error('.gitignore 缺少 .env 規則');
    }
});

// ═══════════════════════════════════════
// 3. 設定檢查
// ═══════════════════════════════════════
console.log('\n⚙️  設定:');

check('wrangler.jsonc AUTH_MODE 設定', () => {
    const config = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf-8');
    if (ENV === 'production') {
        if (!config.includes('"AUTH_MODE": "liff"')) {
            throw new Error('正式環境應設定 AUTH_MODE 為 "liff"');
        }
    }
});

check('wrangler.jsonc 有 KV namespace', () => {
    const config = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf-8');
    if (!config.includes('KV_LINE_STORAGE')) {
        throw new Error('缺少 KV_LINE_STORAGE binding');
    }
});

check('node_modules 存在', () => {
    if (!fs.existsSync(path.join(ROOT, 'node_modules')))
        throw new Error('請先執行 npm install');
});

// ═══════════════════════════════════════
// 4. Secrets 檢查（提醒）
// ═══════════════════════════════════════
console.log('\n🔑 Secrets (需手動確認):');

check('MIGRATION_SECRET 是否已設定', () => {
    try {
        const output = execSync('npx wrangler secret list 2>&1', {
            cwd: ROOT, encoding: 'utf-8', timeout: 15000
        });
        if (!output.includes('MIGRATION_SECRET')) {
            console.log('     → 請執行: npx wrangler secret put MIGRATION_SECRET');
            return 'warn';
        }
    } catch (e) {
        console.log('     → 無法檢查 (可能未登入 Cloudflare): 請確認已設定');
        return 'warn';
    }
});

// ═══════════════════════════════════════
// 5. 建構測試
// ═══════════════════════════════════════
console.log('\n🔨 建構:');

check('Wrangler 可成功解析設定', () => {
    try {
        execSync('npx wrangler deploy --dry-run 2>&1', {
            cwd: ROOT, encoding: 'utf-8', timeout: 30000
        });
    } catch (e) {
        // dry-run may fail for other reasons, check if it's config related
        const msg = e.stdout || e.stderr || e.message;
        if (msg.includes('Could not resolve') || msg.includes('parse error') || msg.includes('Configuration error')) {
            throw new Error(`Wrangler 設定錯誤: ${msg.substring(0, 200)}`);
        }
        // Other errors (e.g., not logged in) are OK for dry-run
        console.log('     → dry-run 部分完成（可能需要登入 Cloudflare）');
        return 'warn';
    }
});

// ═══════════════════════════════════════
// 6. 備份檔案檢查
// ═══════════════════════════════════════
console.log('\n🗑️  清潔度:');

check('無 .bak 備份檔案', () => {
    const bakFiles = findFiles(ROOT, /\.(bak|backup|old)$/i, ['node_modules', '.git', 'backups']);
    if (bakFiles.length > 0) {
        throw new Error(`發現 ${bakFiles.length} 個備份檔案: ${bakFiles.slice(0, 3).map(f => path.relative(ROOT, f)).join(', ')}`);
    }
});

check('無散落的測試檔案在根目錄', () => {
    const rootFiles = fs.readdirSync(ROOT);
    const testFiles = rootFiles.filter(f => /^test_/.test(f) || /^init_cloud/.test(f));
    if (testFiles.length > 0) {
        throw new Error(`根目錄有測試檔案: ${testFiles.join(', ')}`);
    }
});

// ═══════════════════════════════════════
// 結果
// ═══════════════════════════════════════
console.log('\n' + '='.repeat(50));
console.log(`📊 結果: ✅ ${passed} 通過, ❌ ${failed} 失敗, ⚠️  ${warnings} 警告`);

if (failed > 0) {
    console.log('\n❌ 部署前檢查未通過！請修復上述問題後再部署。\n');
    process.exit(1);
} else if (warnings > 0) {
    console.log('\n⚠️  有警告，但可以部署。建議確認上述警告項目。\n');
    process.exit(0);
} else {
    console.log('\n🎉 所有檢查通過！可以安全部署。\n');
    process.exit(0);
}

// ═══════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════
function getJSFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
            results.push(...getJSFiles(full));
        } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

function findFiles(dir, pattern, exclude = []) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (exclude.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findFiles(full, pattern, exclude));
        } else if (entry.isFile() && pattern.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}
