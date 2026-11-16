/**
 * Static Tests — 個人設定頁的 Channel Secret 欄位（pages/profile.html + js/profile.js）
 *
 * 前端沒有瀏覽器測試環境，這裡釘住不可退步的規則：
 *   - 密鑰欄位是 password、關閉自動完成；不寫 storage、不進 console
 *   - HTML 與 JS 的 id 對得上
 *   - 編輯對話框不再把 botId 預填進 Token 欄位（那會讓「更新」把 botId 當 token 送出）
 *   - 只更新 Channel Secret 時打 /token/channel-secret，不必重填 token
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'pages/profile.html'), 'utf8');
const js = readFileSync(join(root, 'js/profile.js'), 'utf8');
const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('profile 頁 Channel Secret', () => {
    for (const id of ['add-project-channel-secret', 'edit-project-channel-secret']) {
        it(`#${id} 存在、是 password、關閉自動完成`, () => {
            const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
            assert.ok(m, `缺少 #${id}`);
            assert.match(m[0], /type="password"/);
            assert.match(m[0], /autocomplete="off"/);
        });

        it(`JS 有讀 #${id}`, () => {
            assert.ok(code.includes(`'${id}'`) || code.includes(`"${id}"`));
        });
    }

    it('編輯對話框有目前狀態的顯示欄位，JS 有寫入', () => {
        assert.match(html, /id="edit-secret-status"/);
        assert.ok(/edit-secret-status/.test(code));
    });

    it('說明去哪裡找 Channel Secret，並提醒不填的後果', () => {
        assert.match(html, /Channel secret/i);
        assert.match(html, /Basic settings/);
    });

    it('HTML 沒有重複的 id', () => {
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(ids.length, new Set(ids).size);
    });

    it('只更新 Channel Secret 時打 /token/channel-secret', () => {
        assert.match(code, /postJson\('\/token\/channel-secret'/);
    });

    it('讀取狀態打 GET /token/channel-secret，專案名稱有 encodeURIComponent', () => {
        assert.match(code, /\/token\/channel-secret\?project=\$\{encodeURIComponent/);
    });

    it('註冊時把 channelSecret 一併送出', () => {
        assert.match(code, /channelSecret/);
        assert.match(code, /postJson\('\/token\/register'/);
    });

    it('編輯對話框不再用 projectData（botId）預填 Token 欄位', () => {
        assert.doesNotMatch(code, /edit-project-token"\)\.value\s*=\s*projectData/);
    });

    it('密鑰不落地：不碰 storage、不進 console', () => {
        const start = code.indexOf('async function submitEditProject');
        assert.ok(start > 0);
        const mine = code.slice(start);
        assert.doesNotMatch(mine, /localStorage|sessionStorage/);
        assert.doesNotMatch(mine, /console\.(log|info|debug)\([^)]*[Ss]ecret/);
    });

    it('送出後會清空密鑰欄位', () => {
        assert.match(code, /channel-secret"\)\.value\s*=\s*""|channel-secret'\)\.value\s*=\s*''/);
    });

    // 回歸：伺服器對「舊格式專案」回 409 並附說明，前端卻因為狀態碼不在通用對照表而顯示「發生未知錯誤」，
    // 而且 #status 在對話框後面，使用者根本看不到。
    for (const id of ['edit-modal-error', 'add-modal-error']) {
        it(`對話框裡有 #${id} 錯誤欄位，JS 會寫入`, () => {
            assert.match(html, new RegExp(`id="${id}"`));
            assert.ok(code.includes('-error`') || code.includes("-error'") || code.includes(id), '缺少寫入錯誤欄位的程式');
        });
    }

    it('送出時用 rawResponse 自己處理錯誤（不走通用的「未知錯誤」提示）', () => {
        assert.match(code, /rawResponse:\s*true/);
        assert.match(code, /showErrorToast:\s*false/);
    });

    it('顯示伺服器回的 error 文字', () => {
        assert.match(code, /data\.error|data\?\.error/);
    });

    it('舊格式專案：狀態欄位說明要同時填 Token 與 Channel Secret', () => {
        assert.match(code, /legacy/);
        assert.match(code, /舊格式/);
    });
});
