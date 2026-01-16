import { toast } from '../helper/toast.js';
import { apiBase, getUserId, setUserId } from '../helper/state.js';
import { api } from '../helper/api.client.js';
import { showConfirm } from '../helper/modal.helper.js';
import { setInnerHTML } from '../helper/security.js';

let currentUser = null;
let currentBotInfo = null;

export async function pageInit(pageData) {

    // Ensure userId is set
    if (pageData && pageData.userId) {
        setUserId(pageData.userId);
    }

    const userId = getUserId();
    if (!userId) {
        toast.error('無法取得使用者 ID');
        return;
    }

    currentUser = { userId }; // Minimal user object for now

    initEventListeners();
    await loadTeamData();
}

async function loadTeamData() {
    try {

        const data = await api.get('/team/members');
        renderMemberList(data.members, data.currentUserRole);

        // Update header with Bot ID (or Name if available in future)
        const botNameEl = document.getElementById('current-bot-name');
        if (botNameEl) {
            // Ideally the API should return the bot name, for now we use ID or a placeholder
            // If data.botName exists use it, otherwise generic text
            botNameEl.textContent = `目前管理專案 (Bot ID: ${data.botId || 'Unknown'})`;
        }

    } catch (err) {
        console.error('Load team data error:', err);
        const tbody = document.getElementById('member-list-body');
        if (tbody) {
            setInnerHTML(tbody, `
                <tr><td colspan="5" class="text-center text-danger py-4">
                    <i class="bi bi-exclamation-circle me-2"></i>載入失敗：${err.message}
                </td></tr>
            `);
        }
    }
}

function renderMemberList(members, myRole) {

    // Toggle Invite Button
    const inviteBtn = document.getElementById('btn-invite-member');
    if (inviteBtn) {
        if (myRole === 'owner') {
            inviteBtn.classList.remove('d-none');
        } else {
            inviteBtn.classList.add('d-none');
        }
    }

    const tbody = document.getElementById('member-list-body');
    if (!tbody) {
        console.error('[team_management] tbody not found!');
        return;
    }

    setInnerHTML(tbody, '');

    if (!members || members.length === 0) {
        console.warn('[team_management] No members to display');
        setInnerHTML(tbody, '<tr><td colspan="5" class="text-center py-4">沒有成員</td></tr>');
        return;
    }


    members.forEach((member, index) => {
        const isMe = member.userId === currentUser.userId;
        const joinedDate = new Date(member.addedAt).toLocaleDateString();

        const tr = document.createElement('tr');

        // 第1列：成員資訊（頭像 + 名字）
        const cell1 = document.createElement('td');
        cell1.className = 'ps-4 py-3';

        const flexDiv = document.createElement('div');
        flexDiv.className = 'd-flex align-items-center';

        // 頭像或佔位符
        if (member.pictureUrl) {
            const img = document.createElement('img');
            img.src = member.pictureUrl;
            img.className = 'rounded-circle me-3';
            img.width = 40;
            img.height = 40;
            flexDiv.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'avatar-placeholder me-3 rounded-circle bg-light d-flex align-items-center justify-content-center';
            placeholder.style.width = '40px';
            placeholder.style.height = '40px';
            placeholder.textContent = member.displayName[0];
            flexDiv.appendChild(placeholder);
        }

        // 名字和ID
        const infoDiv = document.createElement('div');

        const nameDiv = document.createElement('div');
        nameDiv.className = 'fw-bold';
        nameDiv.textContent = member.displayName;

        if (isMe) {
            const badge = document.createElement('span');
            badge.className = 'badge bg-secondary ms-1';
            badge.textContent = '我';
            nameDiv.appendChild(document.createTextNode(' '));
            nameDiv.appendChild(badge);
        }

        const userIdDiv = document.createElement('div');
        userIdDiv.className = 'small text-muted';
        userIdDiv.textContent = member.userId;

        infoDiv.appendChild(nameDiv);
        infoDiv.appendChild(userIdDiv);
        flexDiv.appendChild(infoDiv);
        cell1.appendChild(flexDiv);

        // 第2列：角色
        const cell2 = document.createElement('td');
        const roleBadge = document.createElement('span');
        roleBadge.className = member.role === 'owner' ? 'badge bg-primary role-badge' : 'badge bg-info role-badge';
        roleBadge.textContent = member.role === 'owner' ? '管理員' : '成員';
        cell2.appendChild(roleBadge);

        // 第3列：加入日期
        const cell3 = document.createElement('td');
        cell3.textContent = joinedDate;

        // 第4列：加入方式
        const cell4 = document.createElement('td');
        cell4.textContent = member.addedBy === 'system_migration' ? '系統遷移' : '邀請連結';

        // 第5列：操作按鈕
        const cell5 = document.createElement('td');
        cell5.className = 'text-end pe-4';

        if (myRole === 'owner' && !isMe) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn btn-sm btn-outline-danger btn-remove';
            removeBtn.dataset.id = member.userId;

            const icon = document.createElement('i');
            icon.className = 'bi bi-trash';
            removeBtn.appendChild(icon);
            removeBtn.appendChild(document.createTextNode(' 移除'));

            cell5.appendChild(removeBtn);
        }

        // 組裝所有列
        tr.appendChild(cell1);
        tr.appendChild(cell2);
        tr.appendChild(cell3);
        tr.appendChild(cell4);
        tr.appendChild(cell5);

        tbody.appendChild(tr);
    });

    // Bind remove events
    tbody.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', (e) => handleRemoveMember(e.target.closest('button').dataset.id));
    });

}

async function handleRemoveMember(targetUserId) {
    const confirmed = await showConfirm({
        title: '移除成員',
        message: '確定要移除這位成員嗎？此動作無法復原。',
        type: 'danger',
        confirmText: '移除',
        cancelText: '取消'
    });

    if (!confirmed) return;

    try {
        await api.delete('/team/members', { targetUserId });
        toast.success('成員已移除');
        loadTeamData(); // Reload list

    } catch (err) {
        console.error(err);
        toast.error(err.message);
    }
}

function initEventListeners() {
    const inviteModalEl = document.getElementById('inviteModal');
    if (!inviteModalEl) return;

    const inviteModal = new bootstrap.Modal(inviteModalEl);

    // 監聽 modal 關閉事件，清理 backdrop
    inviteModalEl.addEventListener('hidden.bs.modal', function () {
        setTimeout(() => {
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('overflow');
            document.body.style.removeProperty('padding-right');
        }, 100);
    });

    const inviteBtn = document.getElementById('btn-invite-member');
    if (inviteBtn) {
        inviteBtn.addEventListener('click', () => {
            // Reset modal state
            const resultArea = document.getElementById('invite-result');
            const generateBtn = document.getElementById('btn-generate-link');
            const roleSelect = document.getElementById('invite-role');

            if (resultArea) resultArea.classList.add('d-none');
            if (generateBtn) generateBtn.classList.remove('d-none');
            if (roleSelect) roleSelect.value = 'member';

            // Load projects
            loadUserProjects();

            inviteModal.show();
        });
    }

    const generateBtn = document.getElementById('btn-generate-link');
    if (generateBtn) {
        generateBtn.addEventListener('click', async () => {
            const role = document.getElementById('invite-role').value;
            const btn = document.getElementById('btn-generate-link');
            const loading = document.getElementById('invite-loading');
            const resultArea = document.getElementById('invite-result');

            // Collect selected projects
            const selectedProjects = [];
            document.querySelectorAll('input[name="invite-project"]:checked').forEach(cb => {
                selectedProjects.push(cb.value);
            });

            if (selectedProjects.length === 0) {
                toast.warning('請至少選擇一個專案');
                return;
            }

            btn.classList.add('d-none');
            loading.classList.remove('d-none');

            try {
                const data = await api.post('/team/invite/generate', {
                    inviteRole: role,
                    targetBotIds: selectedProjects
                });
                const inviteUrl = data.inviteUrl;
                document.getElementById('invite-link').value = inviteUrl;

                loading.classList.add('d-none');
                resultArea.classList.remove('d-none');

                // Auto-trigger Share Target Picker if available
                if (liff.isInClient() && liff.isApiAvailable('shareTargetPicker')) {
                    try {
                        const result = await liff.shareTargetPicker([
                            {
                                type: "flex",
                                altText: "邀請您加入 Line Bot 管理團隊",
                                contents: {
                                    type: "bubble",
                                    body: {
                                        type: "box",
                                        layout: "vertical",
                                        contents: [
                                            {
                                                type: "text",
                                                text: "團隊邀請",
                                                weight: "bold",
                                                size: "xl",
                                                color: "#1DB446"
                                            },
                                            {
                                                type: "text",
                                                text: "您被邀請加入 Line Bot 管理團隊。",
                                                margin: "md",
                                                wrap: true
                                            },
                                            {
                                                type: "separator",
                                                margin: "md"
                                            },
                                            {
                                                type: "button",
                                                style: "primary",
                                                action: {
                                                    type: "uri",
                                                    label: "接受邀請",
                                                    uri: inviteUrl
                                                },
                                                margin: "md",
                                                color: "#1DB446"
                                            }
                                        ]
                                    }
                                }
                            }
                        ]);

                        if (result) {
                            toast.success('邀請已分享！');
                            // Optional: Close modal if shared successfully? 
                            // inviteModal.hide(); // Need access to inviteModal instance
                        } else {
                        }
                    } catch (err) {
                        console.error('ShareTargetPicker error:', err);
                        toast.error('分享失敗，請手動複製連結');
                    }
                }

            } catch (err) {
                console.error(err);
                toast.error(err.message);
                btn.classList.remove('d-none');
                loading.classList.add('d-none');
            }
        });
    }

    const copyBtn = document.getElementById('btn-copy-link');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const input = document.getElementById('invite-link');
            input.select();
            navigator.clipboard.writeText(input.value);
            toast.success('連結已複製到剪貼簿');
        });
    }

    // Share Target Picker Logic
    const shareBtn = document.getElementById('btn-share-link');
    if (shareBtn) {
        shareBtn.addEventListener('click', async () => {
            const inviteUrl = document.getElementById('invite-link').value;
            if (!inviteUrl) {
                toast.error('請先產生邀請連結');
                return;
            }

            // Check if LIFF and ShareTargetPicker are available
            if (typeof liff === 'undefined' || !liff.isInClient() || !liff.isApiAvailable('shareTargetPicker')) {
                toast.warning('此功能僅在 LINE App 中可用，請使用複製功能');
                return;
            }

            try {
                const result = await liff.shareTargetPicker([
                    {
                        type: "flex",
                        altText: "邀請您加入 Line Bot 管理團隊",
                        contents: {
                            type: "bubble",
                            body: {
                                type: "box",
                                layout: "vertical",
                                contents: [
                                    {
                                        type: "text",
                                        text: "團隊邀請",
                                        weight: "bold",
                                        size: "xl",
                                        color: "#1DB446"
                                    },
                                    {
                                        type: "text",
                                        text: "您被邀請加入 Line Bot 管理團隊。",
                                        margin: "md",
                                        wrap: true
                                    },
                                    {
                                        type: "separator",
                                        margin: "md"
                                    },
                                    {
                                        type: "button",
                                        style: "primary",
                                        action: {
                                            type: "uri",
                                            label: "接受邀請",
                                            uri: inviteUrl
                                        },
                                        margin: "md",
                                        color: "#1DB446"
                                    }
                                ]
                            }
                        }
                    }
                ]);

                if (result) {
                    toast.success('邀請已分享！');
                } else {
                }
            } catch (err) {
                console.error('ShareTargetPicker error:', err);
                toast.error('分享失敗：' + err.message);
            }
        });
    }
}

async function loadUserProjects() {
    const container = document.getElementById('project-selection-area');
    if (!container) return;

    setInnerHTML(container, '<div class="text-center text-muted small">載入專案中...</div>');

    try {
        const projects = await api.get('/token/list');
        setInnerHTML(container, ''); // Clear loading

        if (Object.keys(projects).length === 0) {
            setInnerHTML(container, '<div class="text-center text-muted small">沒有可用的專案</div>');
            return;
        }

        Object.entries(projects).forEach(([name, botId]) => {
            const div = document.createElement('div');
            div.className = 'form-check';
            setInnerHTML(div, `
                <input class="form-check-input" type="checkbox" name="invite-project" value="${botId}" id="proj-${botId}" checked>
                <label class="form-check-label" for="proj-${botId}">
                    ${name}
                </label>
            `);
            container.appendChild(div);
        });

    } catch (err) {
        console.error('Load projects error:', err);
        setInnerHTML(container, `<div class="text-center text-danger small">載入失敗: ${err.message}</div>`);
    }
}
