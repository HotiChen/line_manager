import { apiBase, getUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { toast } from "../helper/toast.js";
import { setInnerHTML } from '../helper/security.js';

export async function pageInit() {

    // Load initial data
    await Promise.all([
        loadUserProjects(),
        loadInvites()
    ]);

    // Event Listeners
    document.getElementById("btn-refresh").addEventListener("click", loadInvites);
    document.getElementById("btn-generate-token").addEventListener("click", generateToken);
}

async function loadUserProjects() {
    const container = document.getElementById("project-selection-area");
    try {
        const projects = await api.get('/token/list');
        if (Object.keys(projects).length === 0) {
            setInnerHTML(container, '<div class="text-muted small p-2">無可用專案</div>');
            return;
        }

        let html = '';
        for (const [name, botId] of Object.entries(projects)) {
            html += `
                <div class="form-check">
                    <input class="form-check-input project-checkbox" type="checkbox" value="${botId}" id="chk-${botId}" checked>
                    <label class="form-check-label" for="chk-${botId}">
                        ${name} <span class="text-muted small">(${botId.substring(0, 8)}...)</span>
                    </label>
                </div>
            `;
        }
        setInnerHTML(container, html);
    } catch (e) {
        console.error("Failed to load projects", e);
        setInnerHTML(container, '<div class="text-danger small p-2">載入失敗</div>');
    }
}

async function loadInvites() {
    const tbody = document.getElementById("token-list-body");
    setInnerHTML(tbody, '<tr><td colspan="6" class="text-center py-4 text-muted">載入中...</td></tr>');

    try {
        const data = await api.get('/team/invites');
        const invites = data.invites || [];

        if (invites.length === 0) {
            setInnerHTML(tbody, '<tr><td colspan="6" class="text-center py-4 text-muted">目前沒有任何 Token</td></tr>');
            return;
        }

        setInnerHTML(tbody, invites.map(invite => {
            const isExpired = new Date(invite.expiresAt) < new Date();
            const isUsed = invite.used;

            let statusBadge = '';
            if (isUsed) {
                statusBadge = '<span class="badge bg-secondary">已使用</span>';
            } else if (isExpired) {
                statusBadge = '<span class="badge bg-danger">已過期</span>';
            } else {
                statusBadge = '<span class="badge bg-success">有效</span>';
            }

            const botCount = (invite.botIds || [invite.botId]).length;
            const botText = botCount > 1 ? `${botCount} 個專案` : (invite.botIds?.[0] || invite.botId || 'Unknown');

            // Calculate time remaining
            const timeLeft = getTimeRemaining(invite.expiresAt);

            return `
                <tr>
                    <td>${statusBadge}</td>
                    <td class="font-monospace" title="${invite.token}">
                        ${invite.token.substring(0, 8)}...
                        <button class="btn btn-sm btn-link p-0 ms-1" onclick="navigator.clipboard.writeText('${invite.token}')">
                            <i class="bi bi-clipboard"></i>
                        </button>
                    </td>
                    <td>${botText}</td>
                    <td>${new Date(invite.createdAt).toLocaleString()}</td>
                    <td>${isExpired ? '-' : timeLeft}</td>
                    <td>
                        ${!isUsed && !isExpired ? `
                            <a href="./pages/invite.html?token=${invite.token}" target="_blank" class="btn btn-sm btn-outline-primary">
                                <i class="bi bi-box-arrow-up-right"></i> 測試
                            </a>
                        ` : '<span class="text-muted">-</span>'}
                    </td>
                </tr>
            `;
        }).join(''));

    } catch (e) {
        console.error("Failed to load invites", e);
        setInnerHTML(tbody, '<tr><td colspan="6" class="text-center py-4 text-danger">載入失敗</td></tr>');
    }
}

async function generateToken() {
    const btn = document.getElementById("btn-generate-token");
    const checkboxes = document.querySelectorAll('.project-checkbox:checked');
    const expiry = document.getElementById("token-expiry").value;

    if (checkboxes.length === 0) {
        toast.warning("請至少選擇一個專案");
        return;
    }

    const targetBotIds = Array.from(checkboxes).map(cb => cb.value);

    btn.disabled = true;
    setInnerHTML(btn, '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 產生中...');

    try {
        const data = await api.post('/team/invite/generate', {
            inviteRole: "member",
            expiresInHours: parseInt(expiry),
            targetBotIds: targetBotIds
        });

        if (data.success) {
            // Show result
            const resultArea = document.getElementById("generate-result");
            const urlInput = document.getElementById("new-token-url");
            const openLink = document.getElementById("open-token-link");

            resultArea.classList.remove("d-none");
            urlInput.value = data.inviteUrl;
            openLink.href = data.inviteUrl;

            // Refresh list
            loadInvites();
            toast.success("產生成功！");
        } else {
            toast.error(data.error || "產生失敗");
        }
    } catch (e) {
        console.error(e);
        toast.error("發生錯誤");
    } finally {
        btn.disabled = false;
        setInnerHTML(btn, '<i class="bi bi-magic me-2"></i>產生連結');
    }
}

function getTimeRemaining(endtime) {
    const total = Date.parse(endtime) - Date.parse(new Date());
    const hours = Math.floor((total / (1000 * 60 * 60)));
    const minutes = Math.floor((total / 1000 / 60) % 60);
    return `${hours}時 ${minutes}分`;
}
