// js/member_builder.js
import { apiBase, getUserId, setUserId } from "../helper/state.js";
import { api } from "../helper/api.client.js";
import { setInnerHTML } from "../helper/security.js";
import { toast } from "../helper/toast.js";
let members = [];
let tags = [];
// let userId = null; // Module-level userId removed


// 初始化頁面
export async function pageInit(pageData) {
  setUserId(pageData.userId);
  const userId = getUserId();

  await Promise.all([
    loadMembers(),
    loadTags()
  ]);
  setupEventListeners();
}

// 載入會員資料
async function loadMembers() {
  try {
    const data = await api.get('/member/list-full');
    if (data.success && Array.isArray(data.data)) {
      members = data.data;
    } else {
      members = [];
    }
    renderMemberTable();
  } catch (err) {
    console.error("❌ 載入會員失敗", err);
    members = [];
  }
}

// 載入所有標籤
async function loadTags() {
  try {
    const data = await api.get('/tag/list');
    tags = data.success ? data.data : [];
    renderTagCheckboxes();
  } catch (err) {
    console.error("❌ 載入 tag 失敗", err);
    tags = [];
  }
}

// 渲染會員表格
function renderMemberTable() {
  const tbody = document.getElementById("member-table-body");
  setInnerHTML(tbody, "");
  for (const m of members) {
    const tr = document.createElement("tr");
    setInnerHTML(tr, `
      <td>${m.name || ""}</td>
      <td>${m.lineName || ""}</td>
      <td>${m.phone || ""}</td>
      <td>${m.region || ""}</td>
      <td>${m.company || ""}</td>
      <td>${m.jobTitle || ""}</td>
      <td>
        <a href="#" class="edit-tags-link btn ${m.tags?.length ? 'btn-success' : 'btn-outline-secondary'} btn-sm rounded-pill" data-member-id="${m.memberId}">
          ${m.tags?.length ? '⋯' : ''}
        </a>
      </td>
      <td>${m.role || ""}</td>
      <td>${m.temperature || ""}</td>
      <td>${m.gender || ""}</td>
      <td>${m.source || ""}</td>
      <td>${m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</td>
      <td><button class="btn btn-sm btn-outline-primary" onclick='editMember(${JSON.stringify(m)})'>編輯</button></td>
    `);
    tbody.appendChild(tr);
  }
}

// 渲染標籤多選
function renderTagCheckboxes() {
  const container = document.getElementById("tag-checkboxes");
  setInnerHTML(container, "");
  for (const tag of tags) {
    const label = document.createElement("label");
    label.className = "form-check form-check-inline";
    setInnerHTML(label, `
      <input class="form-check-input tag-checkbox" type="checkbox" value="${tag}">
      <span class="form-check-label">${tag}</span>
    `);
    container.appendChild(label);
  }
}

// 設定監聽器
function setupEventListeners() {
  // 防止重複綁定
  if (window._memberEventListenersSetup) {
    return;
  }
  window._memberEventListenersSetup = true;

  document.getElementById("search-button").addEventListener("click", () => {
    const keyword = document.getElementById("search-input").value.trim().toLowerCase();
    const filtered = members.filter(m =>
      (m.name || "").toLowerCase().includes(keyword) ||
      (m.phone || "").toLowerCase().includes(keyword) ||
      (m.lineName || "").toLowerCase().includes(keyword) ||
      (m.region || "").toLowerCase().includes(keyword) ||
      (m.company || "").toLowerCase().includes(keyword) ||
      (m.jobTitle || "").toLowerCase().includes(keyword) ||
      (m.email || "").toLowerCase().includes(keyword) ||
      (m.tags || []).some(tag => tag.toLowerCase().includes(keyword)) ||
      (m.role || "").toLowerCase().includes(keyword) ||
      (m.source || "").toLowerCase().includes(keyword)
    );
    renderFilteredTable(filtered);
  });

  document.getElementById("save-member").addEventListener("click", saveMember);

  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("edit-tags-link")) {
      e.preventDefault();
      const memberId = e.target.dataset.memberId;
      openTagModal(memberId);
    }
  });
}

function renderFilteredTable(filteredList) {
  const tbody = document.getElementById("member-table-body");
  setInnerHTML(tbody, "");
  for (const m of filteredList) {
    const tr = document.createElement("tr");
    setInnerHTML(tr, `
      <td>${m.name || ""}</td>
      <td>${m.lineName || ""}</td>
      <td>${m.phone || ""}</td>
      <td>${m.region || ""}</td>
      <td>${m.company || ""}</td>
      <td>${m.jobTitle || ""}</td>
      <td><a href="#" class="edit-tags-link" data-member-id="${m.memberId}">${(m.tags || []).join(", ")}</a></td>
      <td>${m.role || ""}</td>
      <td>${m.temperature || ""}</td>
      <td>${m.gender || ""}</td>
      <td>${m.source || ""}</td>
      <td>${m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</td>
      <td><button class="btn btn-sm btn-outline-primary" onclick='editMember(${JSON.stringify(m)})'>編輯</button></td>
    `);
    tbody.appendChild(tr);
  }
}

// 編輯會員
window.editMember = function (m) {
  const f = document.getElementById("member-form");
  for (const el of f.elements) {
    if (el.id && m[el.id] !== undefined) {
      el.value = m[el.id];
    }
  }

  // 處理多選 tag
  const checkboxes = document.querySelectorAll(".tag-checkbox");
  for (const cb of checkboxes) {
    cb.checked = (m.tags || []).includes(cb.value);
  }

  const modal = new bootstrap.Modal(document.getElementById("member-modal"));
  modal.show();
}

// 儲存會員
async function saveMember() {
  const f = document.getElementById("member-form");
  // 若未指定 memberId，產生一個隨機 ID（新增時用）
  if (!f["memberId"].value) {
    f["memberId"].value = "mem_" + Date.now();
  }
  const member = {};
  for (const el of f.elements) {
    if (el.id && !["createdAt", "userId"].includes(el.id)) {
      member[el.id] = el.value;
    }
  }

  // tag 處理
  member.tags = Array.from(document.querySelectorAll(".tag-checkbox:checked"))
    .map(cb => cb.value);

  member.createdAt = f["createdAt"].value || new Date().toISOString();

  try {
    const data = await api.post('/member/save', member);
    if (data.success) {
      const memberModal = bootstrap.Modal.getInstance(document.getElementById("member-modal"));
      if (memberModal) {
        memberModal.hide();
        setTimeout(() => {
          document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
          document.body.classList.remove('modal-open');
          document.body.style.removeProperty('overflow');
          document.body.style.removeProperty('padding-right');
        }, 300);
      }
      await loadMembers();
    } else {
      toast.error("儲存失敗: " + data.error);
    }
  } catch (err) {
    console.error("❌ 儲存錯誤", err);
  }
}

// 頁面啟動

function openTagModal(memberId) {
  const member = members.find(m => m.memberId === memberId);
  if (!member) {
    toast.error("找不到會員資料");
    return;
  }

  // 建立 checkbox 清單
  const container = document.getElementById("tag-edit-modal-body");
  setInnerHTML(container, "");
  for (const tag of tags) {
    const label = document.createElement("label");
    label.className = "form-check form-check-inline";
    setInnerHTML(label, `
      <input class="form-check-input tag-edit-checkbox" type="checkbox" value="${tag}" ${member.tags?.includes(tag) ? "checked" : ""}>
      <span class="form-check-label">${tag}</span>
    `);
    container.appendChild(label);
  }

  // 綁定儲存按鈕
  const saveBtn = document.getElementById("save-member-tags");
  if (!saveBtn) {
    console.error("❌ 找不到 #save-member-tags 按鈕");
    return;
  }
  saveBtn.onclick = async () => {
    const selectedTags = Array.from(document.querySelectorAll(".tag-toggle-btn"))
      .filter(btn => btn.classList.contains("btn-success"))
      .map(btn => btn.dataset.tag);
    const extraInput = document.getElementById("extra-tag-input");
    if (extraInput) {
      const extraTags = extraInput.value.split(",").map(t => t.trim()).filter(t => t);
      selectedTags.push(...extraTags);
    }

    const payload = {
      ...member,
      tags: selectedTags
    };

    try {
      const res = await fetch(`${apiBase}/member/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": userId
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        for (const tag of newTags) {
          await api.post('/tag/save', { name: tag });
        }
        tags = Array.from(new Set([...tags, ...selectedTags]));
        const tagModal = bootstrap.Modal.getInstance(document.getElementById("tag-edit-modal"));
        if (tagModal) {
          tagModal.hide();
          setTimeout(() => {
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('overflow');
            document.body.style.removeProperty('padding-right');
          }, 300);
        }
        await loadMembers();
      } else {
        toast.error("儲存失敗: " + data.error);
      }
    } catch (err) {
      console.error("❌ 儲存錯誤", err);
    }
  };

  const modal = new bootstrap.Modal(document.getElementById("tag-edit-modal"));
  modal.show();

  // 補上渲染可編輯 checkbox 的方法
  function renderTagEditCheckboxes(member) {
    const container = document.getElementById("tag-edit-modal-body");
    setInnerHTML(container, "");

    const btnGroup = document.createElement("div");
    btnGroup.className = "d-flex flex-wrap gap-2";

    for (const tag of tags) {
      const isChecked = member.tags?.includes(tag);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${isChecked ? "btn-success" : "btn-outline-secondary"} rounded-pill tag-toggle-btn`;
      btn.dataset.tag = tag;
      btn.innerText = tag;

      btn.onclick = () => {
        btn.classList.toggle("btn-success");
        btn.classList.toggle("btn-outline-secondary");
        btn.classList.toggle("active");
      };

      btnGroup.appendChild(btn);
    }

    container.appendChild(btnGroup);

    const addButtonRow = document.createElement("div");
    addButtonRow.className = "d-flex mt-2 justify-content-end";
    setInnerHTML(addButtonRow, `
      <input type="text" id="new-tag-name" class="form-control me-2" placeholder="新增標籤">
      <button class="btn btn-outline-primary" id="add-tag-button">➕ 加入 Tag</button>
    `);
    container.appendChild(addButtonRow);

    const addTagBtn = addButtonRow.querySelector("#add-tag-button");
    const newTagInput = addButtonRow.querySelector("#new-tag-name");
    addTagBtn.onclick = async () => {
      const newTag = newTagInput.value.trim();
      if (!newTag || tags.includes(newTag)) return;
      try {
        const data = await api.post('/tag/save', { name: newTag });
        if (data.success) {
          tags.push(newTag); // 更新全域 tags 清單
          member.tags.push(newTag); // 加到會員身上
          renderTagEditCheckboxes(member); // 重繪按鈕
        } else {
          toast.error("新增標籤失敗: " + data.error);
        }
      } catch (err) {
        console.error("❌ 新增標籤錯誤", err);
      }
    };
  }

  // 初次渲染 checkbox
  renderTagEditCheckboxes(member);
}