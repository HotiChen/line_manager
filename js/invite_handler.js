import { apiBase, liffId } from '../env/config.js';
import { setInnerHTML } from "../helper/security.js";
import { toast } from "../helper/toast.js";

// Debug mode 偵測
const urlParams = new URLSearchParams(window.location.search);
const isDebugMode = urlParams.get('debug') === 'true' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// API Base URL - 統一使用 config 中的設定
const API_BASE = apiBase;

// Mock user data for debug mode
const customUserId = urlParams.get('userId');
const customDisplayName = urlParams.get('displayName');

const mockUser = {
    userId: customUserId || 'U_test_user_' + Date.now(),
    displayName: customDisplayName || '測試用戶',
    pictureUrl: ''
};

let inviteData = null;
let userProfile = null;

/**
 * 更新 Debug 資訊顯示
 */
function updateDebugInfo() {
    if (isDebugMode) {
        const debugPanel = document.getElementById('debug-info');
        if (debugPanel) {
            debugPanel.style.display = 'block';
            if (userProfile) {
                document.getElementById('debug-user-id').textContent = userProfile.userId;
            }
            document.getElementById('debug-env').textContent = isDebugMode ? 'Debug Mode' : 'Production';
            document.getElementById('debug-api').textContent = API_BASE;
        }
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    updateDebugInfo();

    if (isDebugMode) {
        userProfile = mockUser;
        updateDebugInfo();
        await loadInviteInfo();
    } else {
        await initLiff();
    }

    // 綁定按鈕事件
    document.getElementById('btn-accept-invite')?.addEventListener('click', acceptInvite);
    document.getElementById('btn-decline-invite')?.addEventListener('click', () => {
        window.close();
    });
});

async function initLiff() {
    try {
        // 使用從 config.js 導入的 liffId
        await liff.init({ liffId });

        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }

        const profile = await liff.getProfile();
        userProfile = profile;

        updateDebugInfo();
        await loadInviteInfo();

    } catch (err) {
        console.error('LIFF init failed:', err);
        showError('系統錯誤，請稍後再試');
    }
}

async function loadInviteInfo() {
    const token = urlParams.get('token');
    if (!token) {
        showError('邀請連結缺少 token');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/team/invite/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || '無法載入邀請資訊');
        }

        inviteData = data;
        showConfirmation();

    } catch (err) {
        console.error(err);
        showError(err.message);
    }
}

function showConfirmation() {
    document.getElementById('loading-state').classList.add('d-none');
    document.getElementById('confirmation-state').classList.remove('d-none');

    // 顯示邀請資訊
    const botIdEl = document.getElementById('invite-bot-id');

    if (inviteData.bots && inviteData.bots.length > 0) {
        // 多專案顯示
        if (inviteData.bots.length === 1) {
            botIdEl.textContent = inviteData.bots[0].name;
        } else {
            // 建立列表
            const listHtml = inviteData.bots.map(b => `
                <div class="d-flex align-items-center mb-1">
                    <i class="bi bi-robot me-2 text-secondary"></i>
                    <span>${b.name}</span>
                </div>
            `).join('');
            setInnerHTML(botIdEl, `<div class="mt-2 ps-1">${listHtml}</div>`);
        }
    } else {
        // 相容舊版
        botIdEl.textContent = inviteData.botId || 'Unknown';
    }

    document.getElementById('invite-creator').textContent = inviteData.createdBy || 'Unknown';

    const roleBadge = document.querySelector('#invite-role .badge');
    if (roleBadge) {
        roleBadge.textContent = inviteData.role === 'owner' ? '管理員' : '成員';
        roleBadge.className = `badge ${inviteData.role === 'owner' ? 'bg-danger' : 'bg-info'}`;
    }

    // 如果是 owner 邀請，顯示警告
    if (inviteData.role === 'owner') {
        document.getElementById('owner-warning')?.classList.remove('d-none');
    }
}

async function acceptInvite() {
    if (!inviteData || !userProfile) return;

    const btn = document.getElementById('btn-accept-invite');
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.textContent = '加入中...';

    const token = urlParams.get('token');

    try {
        const res = await fetch(`${API_BASE}/team/invite/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token,
                userId: userProfile.userId,
                displayName: userProfile.displayName,
                pictureUrl: userProfile.pictureUrl
            })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || '加入失敗');
        }

        // ✅ 處理部分成功的情況
        if (data.warning) {
            toast.warning(data.warning);
            console.warn('[Invite] Partial success:', data);
        }

        showSuccess();

    } catch (err) {
        console.error('[Invite] Accept failed:', err);
        toast.error('加入失敗: ' + err.message);
        btn.disabled = false;
        setInnerHTML(btn, originalText);
    }
}

function showSuccess() {
    document.getElementById('loading-state').classList.add('d-none');
    document.getElementById('confirmation-state').classList.add('d-none');
    document.getElementById('success-state').classList.remove('d-none');

    // 在測試環境下，修改「前往管理後台」連結以保持用戶身份
    if (isDebugMode && userProfile) {
        const successLink = document.querySelector('#success-state a');
        if (successLink) {
            const currentUrl = new URL(successLink.href, window.location.origin);
            currentUrl.searchParams.set('userId', userProfile.userId);
            currentUrl.searchParams.set('displayName', userProfile.displayName);
            successLink.href = currentUrl.toString();
        }
    }
}

function showError(msg) {
    document.getElementById('loading-state').classList.add('d-none');
    document.getElementById('error-state').classList.remove('d-none');
    document.getElementById('error-message').textContent = msg;
}
