const STORAGE_KEY = "jobflow_state_v2";
const LEGACY_STORAGE_KEY = "jobflow_state_v1";
const DATA_RESET_MARKER_KEY = "jobflow_data_reset_20260723";
const JOB_STATUSES = ["待投递", "已投递", "面试中", "已Offer", "未通过"];

const state = loadState();
let currentView = "jobs";
let currentJobId = state.jobs[0]?.id || null;
let currentTab = "overview";
let activeJdSection = "insight";
let activeSuggestionIndex = null;
let activeResumeReviewIndex = null;
let activeReviewCommentIndex = null;
let statusEditorOpen = false;
let resumeObjectUrl = null;
let pdfRenderToken = 0;
let pdfZoom = 1;
let pdfRenderedZoom = 1;
let pdfFitPage = true;
let presetJobType = "";
let expandedJobTypes = new Set(state.jobs.map(getJobRoleType));
let aiRuntimeStatus = { state: "checking", label: "检查 AI 连接", detail: "正在读取服务状态" };
let expandedResolvedComments = new Set();

function defaultState() {
  return {
    jobs: [],
    jdReviews: {},
    jdMatches: {},
    jobDirections: {},
    resumes: {},
    resumeReviews: {},
    conversations: {},
    revisions: {},
    resumeVersions: {},
    statusHistory: {},
    account: null,
    jobTypes: []
  };
}

function loadState() {
  if (!localStorage.getItem(DATA_RESET_MARKER_KEY)) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.setItem(DATA_RESET_MARKER_KEY, new Date().toISOString());
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase("jobflow_files");
    return defaultState();
  }

  const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
  let loaded;
  try {
    loaded = raw ? JSON.parse(raw) : defaultState();
  } catch {
    loaded = defaultState();
  }

  const base = defaultState();
  const migrated = {
    ...base,
    ...loaded,
    jobs: Array.isArray(loaded.jobs) ? loaded.jobs : base.jobs,
    jdReviews: loaded.jdReviews || {},
    jdMatches: loaded.jdMatches || {},
    jobDirections: loaded.jobDirections || {},
    resumes: loaded.resumes || {},
    resumeReviews: loaded.resumeReviews || {},
    conversations: loaded.conversations || {},
    revisions: loaded.revisions || {},
    resumeVersions: loaded.resumeVersions || {},
    statusHistory: loaded.statusHistory || {},
    account: loaded.account || null,
    jobTypes: Array.isArray(loaded.jobTypes) ? loaded.jobTypes : []
  };
  migrated.jobs.forEach(job => {
    if (job.status === "Offer") job.status = "已Offer";
    job.status = JOB_STATUSES.includes(job.status) ? job.status : "待投递";
    job.statusUpdatedAt ||= job.updatedAt || job.createdAt || new Date().toISOString();
  });
  Object.values(migrated.statusHistory).forEach(items => asArray(items).forEach(item => {
    if (item.status === "Offer") item.status = "已Offer";
    if (item.fromStatus === "Offer") item.fromStatus = "已Offer";
    if (item.toStatus === "Offer") item.toStatus = "已Offer";
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function $(selector) {
  return document.querySelector(selector);
}

function icon(name, size = 18) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px" aria-hidden="true"></i>`;
}

function render() {
  const app = $("#app");
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <button class="brand" data-nav="jobs" aria-label="返回岗位列表"><span class="brand-mark">J</span><span>JobFlow</span></button>
        <nav class="side-nav" aria-label="主导航">
          <div class="sidebar-section-head">
            <button class="nav-item ${currentView === "jobs" ? "active" : ""}" data-nav="jobs">${icon("briefcase-business")}<span>岗位工作台</span></button>
            <button class="sidebar-add" id="sidebarNewJobBtn" aria-label="创建岗位"><span>创建</span>${icon("plus", 15)}</button>
          </div>
          <button class="add-type-btn" id="sidebarAddTypeBtn">${icon("folder-plus", 16)}<span>增加岗位类型</span></button>
          <div class="job-tree">${renderSidebarJobTree()}</div>
        </nav>
        ${renderAiRuntimeStatus()}
        ${renderAccountEntry()}
      </aside>
      <main class="main">${currentView === "jobs" ? renderJobs() : renderWorkspace()}</main>
    </div>
    ${renderAccountModal()}
    ${renderJobTypeModal()}
  `;
  window.lucide?.createIcons();
  bindCommonEvents();
  if (currentView === "jobs") bindJobsEvents();
  if (currentView === "workspace") {
    bindWorkspaceEvents();
    prepareResumeDocument();
  }
}

function renderAiRuntimeStatus() {
  const iconName = aiRuntimeStatus.state === "live"
    ? "circle-check"
    : aiRuntimeStatus.state === "mock"
      ? "circle-alert"
      : aiRuntimeStatus.state === "error"
        ? "circle-x"
        : "loader-circle";
  return `<div class="ai-runtime-status ${aiRuntimeStatus.state}" title="${escapeHtml(aiRuntimeStatus.detail)}">${icon(iconName, 15)}<span><strong>${escapeHtml(aiRuntimeStatus.label)}</strong><small>${escapeHtml(aiRuntimeStatus.detail)}</small></span></div>`;
}

async function refreshAiRuntimeStatus() {
  try {
    const response = await fetch("/api/ai-status");
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "无法读取 AI 状态");
    aiRuntimeStatus = result.configured
      ? { state: "live", label: "DeepSeek 已配置", detail: result.model }
      : { state: "mock", label: "当前为模拟模式", detail: "配置 API Key 后启用真实分析" };
  } catch (error) {
    aiRuntimeStatus = { state: "error", label: "AI 服务未连接", detail: error.message || "请检查本地服务" };
  }
  const current = $(".ai-runtime-status");
  if (current) {
    current.outerHTML = renderAiRuntimeStatus();
    window.lucide?.createIcons();
  }
}

function bindCommonEvents() {
  document.querySelectorAll("[data-nav]").forEach(button => {
    button.addEventListener("click", () => {
      currentView = button.dataset.nav;
      if (currentView === "workspace" && !currentJobId) currentJobId = state.jobs[0]?.id || null;
      render();
    });
  });
  document.querySelectorAll("[data-sidebar-job]").forEach(button => button.addEventListener("click", () => {
    currentJobId = button.dataset.sidebarJob;
    currentView = "workspace";
    currentTab = "overview";
    render();
  }));
  document.querySelectorAll("[data-toggle-job-type]").forEach(button => button.addEventListener("click", () => {
    const type = button.dataset.toggleJobType;
    expandedJobTypes.has(type) ? expandedJobTypes.delete(type) : expandedJobTypes.add(type);
    render();
  }));
  document.querySelectorAll("[data-delete-job-type]").forEach(button => button.addEventListener("click", () => deleteJobType(button.dataset.deleteJobType)));
  document.querySelectorAll("[data-delete-sidebar-job]").forEach(button => button.addEventListener("click", () => deleteJob(button.dataset.deleteSidebarJob)));
  $("#sidebarNewJobBtn")?.addEventListener("click", () => {
    openCreateJobForType("");
  });
  bindJobTypeEvents();
  bindAccountEvents();
}

function renderSidebarJobTree() {
  const groups = groupJobsByType();
  if (!groups.length) return `<p class="sidebar-empty">暂无岗位</p>`;
  return groups.map(([type, jobs]) => {
    const expanded = expandedJobTypes.has(type);
    return `
      <div class="job-tree-group">
        <div class="job-type-row">
          <button class="job-type-toggle" data-toggle-job-type="${escapeHtml(type)}" aria-expanded="${expanded}">
            ${icon(expanded ? "chevron-down" : "chevron-right", 15)}<span>${escapeHtml(type)}</span><small>${jobs.length}</small>
          </button>
          <button class="type-delete" data-delete-job-type="${escapeHtml(type)}" aria-label="删除岗位类型${escapeHtml(type)}">${icon("trash-2", 13)}</button>
        </div>
        <div class="job-tree-items" ${expanded ? "" : "hidden"}>
          ${jobs.length ? jobs.map(job => `<div class="tree-job-row"><button class="tree-job ${currentView === "workspace" && currentJobId === job.id ? "active" : ""}" data-sidebar-job="${job.id}" title="${escapeHtml(job.company)} · ${escapeHtml(job.title)}"><span>${escapeHtml(job.company)}</span><strong>${escapeHtml(job.title)}</strong></button><button class="tree-delete-job" data-delete-sidebar-job="${job.id}" aria-label="删除${escapeHtml(job.company)}的${escapeHtml(job.title)}">${icon("trash-2", 13)}</button></div>`).join("") : `<p class="tree-type-empty">暂无岗位</p>`}
        </div>
      </div>
    `;
  }).join("");
}

function groupJobsByType() {
  const groups = new Map();
  state.jobTypes.forEach(type => groups.set(type, []));
  state.jobs.forEach(job => {
    const type = getJobRoleType(job);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(job);
  });
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
}

function getJobRoleType(job) {
  const analyzedType = job.roleType?.trim() || state.jdReviews?.[job.id]?.jobSummary?.roleType?.trim();
  if (analyzedType) return analyzedType;
  const title = job.title || "";
  const rules = [
    ["产品运营", /产品运营|用户运营|活动运营|内容运营|社区运营/],
    ["产品经理", /产品经理|产品实习/],
    ["数据分析", /数据分析|商业分析|策略分析/],
    ["市场与品牌", /市场|品牌|公关|营销/],
    ["技术研发", /开发|工程师|算法|测试|前端|后端/],
    ["设计", /设计|视觉|交互|UX|UI/i]
  ];
  return rules.find(([, pattern]) => pattern.test(title))?.[0] || "其他岗位";
}

function renderJobTypeModal() {
  return `<div class="modal-backdrop" id="jobTypeModal" hidden><section class="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="jobTypeModalTitle"><div class="section-heading"><h2 id="jobTypeModalTitle">增加岗位类型</h2><button class="icon-btn" id="closeJobTypeModal" aria-label="关闭">${icon("x")}</button></div><label class="field">岗位类型名称<input class="input" id="newJobTypeName" placeholder="如：产品经理" /></label><p class="form-hint" id="jobTypeHint"></p><div class="footer-row"><span></span><button class="btn primary" id="saveJobTypeBtn">增加类型</button></div></section></div>`;
}

function bindJobTypeEvents() {
  const modal = $("#jobTypeModal");
  $("#sidebarAddTypeBtn")?.addEventListener("click", () => { modal.hidden = false; $("#newJobTypeName")?.focus(); });
  $("#closeJobTypeModal")?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", event => { if (event.target === modal) modal.hidden = true; });
  $("#saveJobTypeBtn")?.addEventListener("click", () => {
    const name = $("#newJobTypeName").value.trim();
    const existing = groupJobsByType().some(([type]) => type === name);
    if (!name || existing) {
      $("#jobTypeHint").textContent = !name ? "请输入岗位类型名称。" : "该岗位类型已经存在。";
      return;
    }
    state.jobTypes.push(name);
    expandedJobTypes.add(name);
    saveState();
    render();
  });
}

function openCreateJobForType(type) {
  presetJobType = type;
  currentView = "jobs";
  render();
  const modal = $("#createJobModal");
  if (!modal) return;
  modal.hidden = false;
  const typeSelect = $("#jobType");
  if (typeSelect && type) typeSelect.value = type;
  $("#jobTitle")?.focus();
}

function deleteJob(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job || !confirm(`删除“${job.company} · ${job.title}”吗？该岗位的全部资料也会被删除。`)) return;
  state.jobs = state.jobs.filter(item => item.id !== jobId);
  ["jdReviews", "jdMatches", "jobDirections", "resumes", "resumeReviews", "conversations", "revisions", "resumeVersions", "statusHistory"].forEach(key => delete state[key][jobId]);
  if (currentJobId === jobId) {
    currentJobId = state.jobs[0]?.id || null;
    currentView = "jobs";
    currentTab = "overview";
  }
  saveState();
  render();
}

function deleteJobType(type) {
  const jobs = state.jobs.filter(job => getJobRoleType(job) === type);
  if (jobs.length) {
    alert("该类型下仍有岗位，请先删除或移动这些岗位。");
    return;
  }
  if (!confirm(`删除岗位类型“${type}”吗？`)) return;
  state.jobTypes = state.jobTypes.filter(item => item !== type);
  expandedJobTypes.delete(type);
  saveState();
  render();
}

function renderAccountEntry() {
  const account = state.account;
  const label = account?.name || "登录 JobFlow";
  const detail = account?.email || "未登录";
  return `<button class="account-entry" id="accountEntryBtn" aria-label="${account ? "账户设置" : "登录 JobFlow"}"><span class="account-avatar">${account ? escapeHtml(account.name.slice(0, 1).toUpperCase()) : icon("user", 17)}</span><span class="account-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>${icon("settings", 16)}</button>`;
}

function renderAccountModal() {
  const account = state.account;
  return `<div class="modal-backdrop" id="accountModal" hidden><section class="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="accountModalTitle"><div class="section-heading"><h2 id="accountModalTitle">${account ? "账户设置" : "登录 JobFlow"}</h2><button class="icon-btn" id="closeAccountModal" aria-label="关闭">${icon("x")}</button></div><label class="field">姓名<input class="input" id="accountName" value="${escapeHtml(account?.name || "")}" placeholder="你的姓名" /></label><label class="field">邮箱<input class="input" id="accountEmail" type="email" value="${escapeHtml(account?.email || "")}" placeholder="name@example.com" /></label>${account ? "" : `<label class="field">密码<input class="input" id="accountPassword" type="password" placeholder="至少 6 位" /></label>`}<p class="form-hint" id="accountHint"></p><div class="footer-row">${account ? `<button class="btn danger" id="logoutBtn">退出登录</button>` : `<span></span>`}<button class="btn primary" id="saveAccountBtn">${account ? "保存设置" : "登录"}</button></div></section></div>`;
}

function bindAccountEvents() {
  const modal = $("#accountModal");
  $("#accountEntryBtn")?.addEventListener("click", () => { modal.hidden = false; $("#accountName")?.focus(); });
  $("#closeAccountModal")?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", event => { if (event.target === modal) modal.hidden = true; });
  $("#saveAccountBtn")?.addEventListener("click", () => {
    const name = $("#accountName").value.trim();
    const email = $("#accountEmail").value.trim();
    const password = $("#accountPassword")?.value || "";
    const hint = $("#accountHint");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || (!state.account && password.length < 6)) {
      hint.textContent = "请填写姓名、有效邮箱和至少 6 位密码。";
      return;
    }
    state.account = { name, email, loggedInAt: state.account?.loggedInAt || new Date().toISOString() };
    saveState();
    render();
  });
  $("#logoutBtn")?.addEventListener("click", () => {
    state.account = null;
    saveState();
    render();
  });
}

function renderJobs() {
  const counts = Object.fromEntries(JOB_STATUSES.map(status => [status, state.jobs.filter(job => job.status === status).length]));
  return `
    <header class="topbar">
      <div>
        <span class="module-product-name">Job Workspace</span>
        <h1>岗位工作台</h1>
        <p class="muted">${state.jobs.length} 个岗位</p>
      </div>
    </header>
    <section class="status-summary" aria-label="申请状态概览">
      ${JOB_STATUSES.map(status => `<button class="status-stat" data-status-filter="${status}"><strong>${counts[status]}</strong><span>${status}</span></button>`).join("")}
    </section>
    <section class="toolbar job-toolbar">
      <label class="search-field">${icon("search")}<input id="jobSearch" placeholder="搜索岗位或公司" /></label>
      <select class="select compact" id="statusFilter" aria-label="筛选申请状态">
        <option value="">全部状态</option>
        ${JOB_STATUSES.map(status => `<option>${status}</option>`).join("")}
      </select>
    </section>
    <section class="job-list-shell">
      <div class="job-list-head"><span class="job-column-role">岗位</span><span class="job-column-status">当前状态</span><span class="job-column-progress">进度</span><span></span></div>
      <div id="jobList" class="job-table">${state.jobs.length ? state.jobs.map(renderJobRow).join("") : renderEmptyJobs()}</div>
    </section>
    <div class="modal-backdrop" id="createJobModal" hidden>
      <section class="modal create-job-modal" role="dialog" aria-modal="true" aria-labelledby="createJobTitle">
        <div class="section-heading create-job-heading"><h2 id="createJobTitle">创建岗位</h2><button class="icon-btn" id="closeJobModal" aria-label="关闭">${icon("x")}</button></div>
        <div class="job-type-field">
          <label class="field">岗位类型<select class="select" id="jobType">${groupJobsByType().map(([type]) => `<option ${presetJobType === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}${groupJobsByType().some(([type]) => type === "其他岗位") ? "" : `<option ${!presetJobType ? "selected" : ""}>其他岗位</option>`}<option value="__custom__">自定义岗位类型</option></select></label>
          <label class="field custom-job-type-field" id="customJobTypeField" hidden>自定义岗位类型<input class="input" id="customJobType" placeholder="输入新的岗位类型" /></label>
        </div>
        <div class="grid two">
          <label class="field">岗位名称<input class="input" id="jobTitle" placeholder="产品运营实习生" /></label>
          <label class="field">公司名称<input class="input" id="jobCompany" placeholder="公司名称" /></label>
        </div>
        <label class="field">岗位 JD<textarea class="textarea jd-input" id="jobJd" placeholder="粘贴完整岗位描述"></textarea></label>
        <div class="footer-row"><span class="form-hint" id="createHint"></span><div class="actions"><button class="btn" id="cancelJobBtn">取消</button><button class="btn primary" id="saveJobBtn">创建岗位</button></div></div>
      </section>
    </div>
  `;
}

function renderJobRow(job) {
  const review = state.jdReviews[job.id];
  return `
    <article class="job-row" data-open-job="${job.id}">
      <div class="job-main"><div class="company-avatar">${escapeHtml(job.company.slice(0, 1).toUpperCase())}</div><div><h2>${escapeHtml(job.title)}</h2><p>${escapeHtml(job.company)}</p></div></div>
      <div class="job-status-cell"><span class="status status-${statusClass(job.status)}">${job.status}</span></div>
      ${renderJobFlow(job, Boolean(review))}
      <button class="icon-btn row-open" aria-label="打开岗位">${icon("chevron-right")}</button>
    </article>
  `;
}

function renderJobFlow(job, hasJdReview) {
  const steps = ["JD分析", "简历优化", "已投递", "面试", "Offer"];
  const statusIndex = { "已投递": 2, "面试中": 3, "已Offer": 4, "Offer": 4 }[job.status];
  const failed = job.status === "未通过";
  const historyStatuses = asArray(state.statusHistory[job.id]).map(item => item.toStatus || item.status);
  const reachedBeforeFailure = Math.max(
    hasJdReview ? 0 : -1,
    historyStatuses.includes("已Offer") || historyStatuses.includes("Offer") ? 4 : -1,
    historyStatuses.includes("面试中") ? 3 : -1,
    historyStatuses.includes("已投递") ? 2 : -1
  );
  const currentIndex = failed ? reachedBeforeFailure : (statusIndex ?? (hasJdReview ? 1 : 0));
  return `<div class="job-flow" aria-label="岗位求职进度">${steps.map((step, index) => {
    const stateClass = failed ? (index <= currentIndex ? "done" : "") : index < currentIndex ? "done" : index === currentIndex ? "current" : "";
    return `<span class="job-flow-step ${stateClass}"><i></i><small>${step}</small></span>`;
  }).join("")}</div>`;
}

function renderEmptyJobs() {
  return `<div class="empty"><div>${icon("briefcase-business", 28)}<h2>还没有岗位</h2><button class="btn primary" id="emptyNewJobBtn">创建第一个岗位</button></div></div>`;
}

function bindJobsEvents() {
  const modal = $("#createJobModal");
  const openModal = type => { presetJobType = type || ""; modal.hidden = false; const select = $("#jobType"); if (select && type) select.value = type; $("#jobTitle")?.focus(); };
  const closeModal = () => { modal.hidden = true; };
  $("#emptyNewJobBtn")?.addEventListener("click", () => openModal(""));
  $("#closeJobModal")?.addEventListener("click", closeModal);
  $("#cancelJobBtn")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", event => { if (event.target === modal) closeModal(); });
  $("#saveJobBtn")?.addEventListener("click", createJob);
  $("#jobType")?.addEventListener("change", toggleCustomJobTypeField);
  $("#jobSearch")?.addEventListener("input", filterJobs);
  $("#statusFilter")?.addEventListener("change", filterJobs);
  document.querySelectorAll("[data-status-filter]").forEach(button => button.addEventListener("click", () => {
    $("#statusFilter").value = button.dataset.statusFilter;
    filterJobs();
  }));
  bindOpenJobRows();
}

function createJob() {
  const selectedRoleType = $("#jobType").value.trim();
  const roleType = selectedRoleType === "__custom__" ? $("#customJobType").value.trim() : selectedRoleType;
  const title = $("#jobTitle").value.trim();
  const company = $("#jobCompany").value.trim();
  const jd = $("#jobJd").value.trim();
  const hint = $("#createHint");
  if (!roleType || !title || !company || jd.length < 30) {
    hint.textContent = selectedRoleType === "__custom__" && !roleType
      ? "请输入自定义岗位类型。"
      : "请选择岗位类型，填写岗位、公司，并补充相对完整的 JD。";
    return;
  }
  if (state.jobs.some(job => job.title === title && job.company === company) && !confirm("已经有相同公司和岗位，仍要创建吗？")) return;
  const now = new Date().toISOString();
  const job = { id: crypto.randomUUID(), title, company, roleType, status: "待投递", jd, createdAt: now, updatedAt: now, statusUpdatedAt: now };
  if (!state.jobTypes.includes(roleType)) state.jobTypes.push(roleType);
  expandedJobTypes.add(roleType);
  state.jobs.unshift(job);
  state.statusHistory[job.id] = [{ status: "待投递", toStatus: "待投递", changedAt: now }];
  currentJobId = job.id;
  currentView = "workspace";
  currentTab = "overview";
  saveState();
  render();
}

function toggleCustomJobTypeField() {
  const isCustom = $("#jobType")?.value === "__custom__";
  const field = $("#customJobTypeField");
  if (!field) return;
  field.hidden = !isCustom;
  if (isCustom) $("#customJobType")?.focus();
}

function filterJobs() {
  const keyword = $("#jobSearch").value.trim().toLowerCase();
  const status = $("#statusFilter").value;
  const jobs = state.jobs.filter(job => `${job.title} ${job.company}`.toLowerCase().includes(keyword) && (!status || job.status === status));
  $("#jobList").innerHTML = jobs.length ? jobs.map(renderJobRow).join("") : `<div class="empty compact-empty">没有匹配的岗位</div>`;
  window.lucide?.createIcons();
  bindOpenJobRows();
}

function bindOpenJobRows() {
  document.querySelectorAll("[data-open-job]").forEach(row => row.addEventListener("click", () => {
    currentJobId = row.dataset.openJob;
    currentView = "workspace";
    currentTab = "overview";
    render();
  }));
}

function renderWorkspace() {
  const job = getCurrentJob();
  if (!job) return `<div class="empty"><div><h2>还没有岗位</h2><button class="btn primary" data-nav="jobs">返回岗位管理</button></div></div>`;
  const tabs = [["overview", "总览"], ["jd", "岗位分析"], ["resume", "AI 简历助手"], ["tracker", "投递追踪"], ["history", "历史记录"]];
  const jobDescription = getWorkspaceJobDescription(job);
  return `
    <header class="workspace-header">
      <button class="back-link" id="backJobsBtn">${icon("arrow-left")}岗位列表</button>
      <div class="workspace-title-row">
        <div class="workspace-title-copy"><span class="module-product-name">Job Workspace · 岗位工作台</span><h1>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</h1><p>${escapeHtml(jobDescription)}</p></div>
        <div class="actions"><span class="status status-${statusClass(job.status)}">${escapeHtml(job.status)}</span><button class="btn" id="editJobBtn">${icon("pencil")}编辑岗位</button></div>
      </div>
      <nav class="tabs" aria-label="岗位工作区功能">${tabs.map(([key, label]) => `<button class="tab ${currentTab === key ? "active" : ""}" data-tab="${key}" ${currentTab === key ? `aria-current="page"` : ""}>${label}</button>`).join("")}</nav>
    </header>
    <section class="workspace-content">${renderTab(job)}</section>
    ${renderEditJobModal(job)}
  `;
}

function getWorkspaceJobDescription(job) {
  const review = state.jdReviews[job.id];
  if (review) {
    return review.jobSummary?.oneSentenceInterpretation
      || getJdConclusion(review, getJdCapabilities(review), getResponsibilityBreakdown(review, getJdCapabilities(review))).split(/[。！？]/)[0];
  }
  return compactSentence(job.jd, 88);
}

function renderEditJobModal(job) {
  return `<div class="modal-backdrop" id="editJobModal" hidden><section class="modal" role="dialog" aria-modal="true"><div class="section-heading"><h2>编辑岗位信息</h2><button class="icon-btn" id="closeEditJob" aria-label="关闭">${icon("x")}</button></div><div class="grid two"><label class="field">岗位名称<input class="input" id="editJobTitle" value="${escapeHtml(job.title)}" /></label><label class="field">公司名称<input class="input" id="editJobCompany" value="${escapeHtml(job.company)}" /></label></div><label class="field">岗位 JD<textarea class="textarea jd-input" id="editJobJd">${escapeHtml(job.jd)}</textarea></label><div class="footer-row"><span class="form-hint" id="editJobHint"></span><button class="btn primary" id="saveJobInfoBtn">保存岗位信息</button></div></section></div>`;
}

function renderTab(job) {
  if (currentTab === "overview") return renderOverview(job);
  if (currentTab === "jd") return renderJdIntelligence(job);
  if (currentTab === "resume") return renderResumeCopilot(job);
  if (currentTab === "tracker") return renderTracker(job);
  return renderHistory(job);
}

function renderOverview(job) {
  const jdReview = state.jdReviews[currentJobId];
  const latestReview = getLatestResumeReview();
  const resume = state.resumes[currentJobId];
  const versions = state.resumeVersions[currentJobId] || [];
  const next = getOverviewNextAction(job);
  return `
    <section class="metric-grid">
      <button class="metric" data-tab="jd"><span class="metric-icon">${icon("scan-search")}</span><span><strong>岗位分析</strong><small>${jdReview ? "岗位解析已完成" : "等待分析"}</small></span><span class="state-label ${jdReview ? "complete" : ""}">${jdReview ? "已完成" : "未开始"}</span></button>
      <button class="metric" data-tab="resume"><span class="metric-icon">${icon("file-user")}</span><span><strong>AI 简历助手</strong><small>${latestReview ? `简历评分 ${latestReview.fitScore || "-"} 分` : resume ? "简历已上传" : "等待简历"}</small></span><span class="state-label ${latestReview ? "complete" : ""}">${latestReview ? "已审阅" : "待处理"}</span></button>
      <button class="metric" data-tab="tracker"><span class="metric-icon">${icon("send")}</span><span><strong>投递追踪</strong><small>更新于 ${formatDate(job.statusUpdatedAt)}</small></span><span class="status status-${statusClass(job.status)}">${job.status}</span></button>
      <button class="metric" data-tab="history"><span class="metric-icon">${icon("history")}</span><span><strong>求职资料</strong><small>${versions.length} 个简历版本</small></span><span class="state-label">查看</span></button>
    </section>
    <section class="content-section next-action-section"><div class="next-action-heading"><div class="eyebrow">下一步</div><h2>${next.title}</h2></div><div class="next-action"><strong>${next.copy}</strong><button class="icon-btn" data-tab="${next.tab}" aria-label="进入${next.title}">${icon("arrow-right")}</button></div></section>
  `;
}

function getOverviewNextAction(job) {
  if (job.status === "已投递") return { tab: "tracker", title: "准备面试", copy: "更新投递状态，并准备岗位相关面试内容。" };
  if (job.status === "面试中") return { tab: "tracker", title: "面试记录", copy: "记录面试进展，并持续更新申请状态。" };
  if (job.status === "已Offer" || job.status === "Offer") return { tab: "tracker", title: "入职准备", copy: "确认 Offer 信息、入职时间和后续安排。" };
  if (job.status === "未通过") return { tab: "history", title: "复盘申请", copy: "整理本次申请记录，为后续求职积累经验。" };

  const jdComplete = Boolean(state.jdReviews[job.id] && state.jdMatches[job.id] && state.jobDirections[job.id]);
  if (!jdComplete) return { tab: "jd", title: "完成岗位分析", copy: "完成岗位解析、用户匹配和岗位竞争力提升。" };

  const reviews = state.resumeReviews[job.id] || [];
  const latestReview = reviews.at(-1);
  const issues = asArray(latestReview?.paragraphIssues || latestReview?.suggestions);
  const resumeComplete = Boolean(latestReview) && issues.every(issue => ["completed", "saved", "ignored"].includes(issue.workflowStatus));
  if (!resumeComplete) return { tab: "resume", title: "优化简历", copy: "完成简历批注，并生成岗位定制版本。" };

  return { tab: "tracker", title: "准备投递", copy: "生成岗位定制简历并记录投递状态。" };
}

function renderJdIntelligence() {
  const review = state.jdReviews[currentJobId];
  const match = state.jdMatches[currentJobId];
  const directions = state.jobDirections[currentJobId] || (match?.optimizationDirections ? { improvements: match.optimizationDirections } : null);
  const resume = state.resumes[currentJobId];
  if (!review) return renderAnalysisEmpty("JD Intelligence", "岗位分析", "scan-search", "解析岗位需求，发现匹配优势与提升方向", "runJdReviewBtn", "开始分析");

  const capabilities = getJdCapabilities(review);
  const summary = review.jobSummary || {};
  const keywords = getSkillKeywords(review, capabilities);
  const responsibilities = getResponsibilityBreakdown(review, capabilities);
  const conclusion = getJdConclusion(review, capabilities, responsibilities);
  const quickInterpretation = summary.oneSentenceInterpretation || conclusion.split(/[。！？]/)[0] || "暂无岗位解析结论";
  if ((activeJdSection === "match" && !match) || (activeJdSection === "competition" && !directions)) activeJdSection = "insight";
  return `
    <div class="page-actions"><div><span class="module-product-name">JD Intelligence</span><h2>岗位分析</h2></div><div class="actions"><button class="btn" id="runJdReviewBtn">${icon("refresh-cw")}重新分析</button>${resume && match ? `<button class="btn primary" id="runJdMatchBtn">${icon("user-check")}重新匹配</button>` : ""}</div></div>
    <section class="insight-banner"><span class="insight-kicker">岗位快速判断</span><strong>${escapeHtml(quickInterpretation)}</strong></section>
    <nav class="result-nav" aria-label="岗位分析流程导航">${renderJdNavTab("insight", "岗位解析", "job-analysis", true)}${renderJdNavTab("match", "用户匹配", "user-match", Boolean(match))}${renderJdNavTab("competition", "岗位竞争力提升", "job-direction", Boolean(directions))}</nav>
    <section class="content-section" id="job-analysis"><div class="section-heading"><div><span class="section-number">01</span><h2>岗位解析</h2></div></div>
      <div class="section-heading subheading"><h3>核心能力要求</h3></div>
      <div class="capability-grid">${capabilities.length ? capabilities.map(renderCapability).join("") : renderInlineEmpty("暂无能力要求")}</div>
      <div class="section-heading subheading"><h3>技能关键词</h3></div>
      <div class="keyword-priority-list">${["P0", "P1", "P2"].map(priority => renderKeywordGroup(priority, keywords[priority] || [])).join("")}</div>
      <div class="section-heading subheading"><h3>岗位职责拆解</h3></div>
      <div class="responsibility-list">${responsibilities.length ? responsibilities.map(renderResponsibility).join("") : renderInlineEmpty("暂无岗位职责拆解")}</div>
      <div class="section-heading subheading"><h3>岗位解析结论</h3></div>
      <div class="jd-conclusion"><span>${icon("scan-search", 20)}</span><p>${escapeHtml(conclusion || "JD 信息不足，暂无法形成岗位解析结论。")}</p></div>
    </section>
    <section class="content-section" id="user-match"><div class="section-heading"><div><span class="section-number">02</span><h2>用户匹配</h2></div></div>${resume ? match ? renderJdMatch(match) : renderMatchEmpty() : renderResumeRequired("上传简历后，系统会补充已匹配优势、能力缺口和匹配程度。")}</section>
    <section class="content-section" id="job-direction"><div class="section-heading"><div><span class="section-number">03</span><h2>岗位竞争力提升</h2></div></div>${match ? directions ? renderCompetitionImprovement(directions) : `<div class="soft-empty"><p>完成用户匹配后生成针对能力缺口的竞争力提升方向。</p></div>` : `<div class="soft-empty"><p>先完成用户匹配，再分析岗位竞争力提升方向。</p></div>`}</section>
  `;
}

function renderJdNavTab(key, label, target, complete) {
  const active = activeJdSection === key;
  const locked = !complete;
  const stateLabel = complete ? "已完成" : "未完成，暂时锁定";
  return `<button class="result-tab ${active ? "active" : ""} ${complete ? "complete" : "locked"}" data-jd-section="${key}" data-jd-target="${target}" ${locked ? "disabled" : ""} title="${stateLabel}" aria-current="${active ? "true" : "false"}"><span>${label}</span><span class="result-tab-state" aria-label="${stateLabel}">${icon(complete ? "check" : "lock-keyhole", 12)}</span></button>`;
}

function renderRequirement(item) {
  if (typeof item === "string") return `<article class="requirement-card"><strong>${escapeHtml(item)}</strong></article>`;
  return `<article class="requirement-card"><strong>${escapeHtml(item.requirement || item.title || "岗位要求")}</strong>${item.meaning ? `<p>${escapeHtml(item.meaning)}</p>` : ""}${item.basis ? `<small>${escapeHtml(item.basis)}</small>` : ""}</article>`;
}

function renderExpectation(item) {
  if (typeof item === "string") return `<article class="requirement-card implicit"><strong>${escapeHtml(item)}</strong></article>`;
  return `<article class="requirement-card implicit"><strong>${escapeHtml(item.expectation || item.title || "隐含期待")}</strong>${item.basis ? `<small>${escapeHtml(item.basis)}</small>` : ""}</article>`;
}

function renderCapability(item) {
  const priority = normalizeCapabilityPriority(item);
  return `<article class="capability-card"><div class="capability-top"><span class="priority-badge priority-${priority.toLowerCase()}">${priority}</span><h3>${escapeHtml(item.name)}</h3></div><p>${escapeHtml(item.description || item.meaning || item.whyImportant || "该能力影响岗位工作的完成质量。")}</p></article>`;
}

function renderKeywordGroup(title, items) {
  const labels = { P0: "核心", P1: "重要", P2: "加分" };
  return `<article class="keyword-group"><strong><span class="priority-badge priority-${title.toLowerCase()}">${title}</span>${labels[title] || ""}</strong><div class="tag-list">${items.length ? items.map(item => `<span>${escapeHtml(item)}</span>`).join("") : `<small>JD 未明确提及</small>`}</div></article>`;
}

function renderResponsibility(item, index) {
  const name = cleanResponsibilityName(item.responsibility || item.duty || item.task || "岗位职责");
  return `<article class="responsibility-row"><span class="responsibility-index">${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(name)}</strong></article>`;
}

function cleanResponsibilityName(value) {
  return String(value || "")
    .replace(/^\s*P[0-2]\s*[-:：]?\s*/i, "")
    .replace(/\s*[（(][^（）()]*[）)]\s*$/g, "")
    .trim();
}

function renderJdMatch(match) {
  const score = normalizeMatchScore(match);
  const strengths = normalizeMatchStrengths(match);
  const gaps = normalizeMatchGaps(match);
  return `<div class="match-analysis"><div class="match-subheading"><h3>匹配度分析</h3></div><div class="match-score-summary"><div class="score-ring compact-score" style="--score:${score.overall}"><span><strong>${score.overall}%</strong><small>整体匹配度</small></span></div><div class="match-factor-list">${score.dimensions.map(renderMatchFactor).join("")}</div></div><div class="match-detail-grid"><section><h3>已匹配优势</h3><div class="match-item-list">${strengths.length ? strengths.map(renderMatchStrength).join("") : renderInlineEmpty("暂无有充分证据的匹配优势")}</div></section><section><h3>能力缺口</h3><div class="match-item-list">${gaps.length ? gaps.map(renderMatchGap).join("") : renderInlineEmpty("暂无明确能力缺口")}</div></section></div></div>`;
}

function renderMatchFactor(item) {
  const score = clampScore(item.score);
  return `<article class="match-factor"><div><strong>${escapeHtml(item.name)}</strong><span>${score}%</span></div><div class="factor-track"><i style="width:${score}%"></i></div>${item.basis ? `<p>${escapeHtml(item.basis)}</p>` : ""}</article>`;
}

function renderMatchStrength(item) {
  return `<article class="match-evidence strength"><span>${icon("check", 15)}</span><div><div class="evidence-title"><strong>${escapeHtml(item.requirement)}</strong></div><p>${escapeHtml(item.matchReason)}</p></div></article>`;
}

function renderMatchGap(item) {
  return `<article class="match-evidence gap"><span>${icon("circle-alert", 15)}</span><div><div class="evidence-title"><strong>${escapeHtml(item.gap)}</strong></div><p>${escapeHtml(item.gapReason)}</p></div></article>`;
}

function renderCompetitionImprovement(value) {
  const improvements = normalizeCompetitionImprovements(value);
  return improvements.length ? `<div class="competition-table"><div class="competition-columns"><span></span><span>优化问题</span><span>优化方向</span></div>${improvements.map(renderCompetitionItem).join("")}</div><div class="competition-actions"><button class="btn primary next-stage-btn" data-tab="resume">下一阶段：简历优化${icon("arrow-right")}</button></div>` : renderInlineEmpty("暂无岗位竞争力提升方向");
}

function renderCompetitionItem(item, index) {
  return `<article class="competition-row"><span class="competition-index">${String(index + 1).padStart(2, "0")}</span><div><div class="competition-title"><strong>${escapeHtml(compactSentence(item.problem, 24))}</strong></div><p>${escapeHtml(compactSentence(item.explanation, 54))}</p></div><div class="competition-direction"><span>${icon("arrow-up-right", 14)}</span><p>${escapeHtml(compactSentence(item.direction, 54))}</p></div></article>`;
}

function compactSentence(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const firstSentence = text.match(/^.*?[。！？!?](?:\s|$)/)?.[0]?.trim() || text;
  return firstSentence.length > maxLength ? `${firstSentence.slice(0, maxLength - 1)}…` : firstSentence;
}

function renderMatchEmpty() {
  return `<div class="soft-empty"><div><h3>简历已就绪</h3><p>结合当前简历分析已匹配优势、能力缺口和匹配程度。</p><button class="btn primary" id="runJdMatchBtn">开始岗位匹配</button></div></div>`;
}

function renderResumeRequired(copy) {
  return `<div class="soft-empty"><div>${icon("file-up", 26)}<h3>需要一份简历</h3><p>${copy}</p><button class="btn primary" data-tab="resume">上传简历</button></div></div>`;
}

function renderResumeCopilot() {
  const resume = state.resumes[currentJobId];
  const reviews = state.resumeReviews[currentJobId] || [];
  const review = getLatestResumeReview();
  if (!resume) return renderResumeUploadPage();
  if (!review) return `<div class="copilot-shell"><div class="page-actions"><div><span class="module-product-name">Resume Copilot</span><h2>AI 简历助手</h2></div>${renderResumeBadge(resume)}</div><div class="analysis-ready"><span class="analysis-icon">${icon("sparkles", 28)}</span><div><h2>简历已解析</h2><p>${escapeHtml(resume.name)} · ${resume.charCount || resume.extractedText?.length || 0} 字</p></div><button class="btn primary" id="runResumeReviewBtn">开始 AI 批注</button></div></div>`;

  const issues = asArray(review.paragraphIssues || review.suggestions);
  if (activeSuggestionIndex !== null && issues[activeSuggestionIndex]) return renderSuggestionWorkbench(review, issues[activeSuggestionIndex], activeSuggestionIndex);
  const completedCount = issues.filter(issue => ["completed", "saved", "ignored"].includes(issue.workflowStatus)).length;
  const pendingCount = issues.filter(issue => !["completed", "saved", "ignored"].includes(issue.workflowStatus)).length;
  const acceptedCount = (state.revisions[currentJobId] || []).length;
  const isPdf = resume.type === "application/pdf";
  const firstPendingIndex = issues.findIndex(issue => !["completed", "saved", "ignored"].includes(issue.workflowStatus));
  const firstEditableIndex = issues.findIndex(issue => issue.workflowStatus !== "ignored");
  const nextIssueIndex = firstPendingIndex >= 0 ? firstPendingIndex : Math.max(0, firstEditableIndex);
  const isHistoricalReview = Number.isInteger(activeResumeReviewIndex) && activeResumeReviewIndex < reviews.length - 1;
  return `
    <div class="page-actions resume-review-header"><div class="resume-review-heading"><span class="module-product-name">Resume Copilot</span><h2>AI 简历助手</h2><p class="resume-review-status"><strong>简历评分 ${review.fitScore || "-"} 分</strong><span>·</span><span>${pendingCount} 条待处理建议</span></p><div class="resume-header-file"><span>当前简历：<strong title="${escapeHtml(resume.name)}">${escapeHtml(resume.name)}</strong></span><div class="resume-header-file-actions"><button class="icon-btn small-icon" id="replaceResumeBtn" aria-label="替换简历" title="替换简历">${icon("replace", 14)}</button><button class="icon-btn small-icon" id="removeResumeBtn" aria-label="删除当前简历" title="删除当前简历">${icon("trash-2", 14)}</button><input type="file" id="resumeFile" accept=".pdf,.docx" hidden /></div></div></div><div class="actions">${isHistoricalReview ? `<button class="btn" id="latestResumeReviewBtn">${icon("arrow-up-right")}返回最新批注</button>` : ""}<button class="btn primary" id="runResumeReviewBtn">${icon("refresh-cw")}重新批注</button></div></div>
    <section class="review-toolbar"><div class="review-progress"><div><strong>批注进度</strong><span>${completedCount} / ${issues.length} 已处理</span></div><div class="review-progress-track"><i style="width:${issues.length ? Math.round(completedCount / issues.length * 100) : 100}%"></i></div></div></section>
    ${pendingCount > 0 ? `<section class="review-action-bar"><div class="review-action-icon">${icon("list-checks", 22)}</div><div><strong>继续处理 ${pendingCount} 条 AI 批注</strong><p>逐条查看建议，完成修改或忽略后即可导出。</p></div>${issues.length ? `<div class="review-action-buttons"><button class="btn primary" id="startReviewFlowBtn" data-issue-index="${nextIssueIndex}">${icon("pencil-line", 16)}开始修改</button></div>` : ""}</section>` : ""}
    <section class="review-editor-layout"><div class="resume-pane"><div class="editor-pane-head"><h3>简历预览与修改</h3><span>${issues.length} 条批注 · ${acceptedCount} 处已替换</span></div>${isPdf ? `<div class="pdf-review-toolbar" aria-label="PDF 查看控制"><div class="pdf-zoom-controls"><button class="icon-btn" id="pdfZoomOutBtn" aria-label="缩小 PDF" title="缩小">${icon("minus", 16)}</button><span class="pdf-zoom-value" id="pdfZoomValue">${Math.round(pdfRenderedZoom * 100)}%</span><button class="icon-btn" id="pdfZoomInBtn" aria-label="放大 PDF" title="放大">${icon("plus", 16)}</button></div><button class="btn ghost pdf-fit-button ${pdfFitPage ? "active" : ""}" id="pdfFitPageBtn">${icon("scan", 15)}适应页面</button></div>` : ""}<div class="resume-paper">${isPdf ? `<div class="pdf-review-viewer" id="pdfReviewViewer"><div class="pdf-loading">${icon("loader-circle")}正在还原 PDF 页面...</div></div>` : renderAnnotatedResume(resume.extractedText, issues)}</div></div><aside class="review-comments"><div class="editor-pane-head"><h3>AI 批注</h3><span>${pendingCount} 条待处理</span></div><div class="comment-list">${issues.length ? issues.map((issue, index) => renderReviewComment(issue, index)).join("") : renderInlineEmpty("AI 暂未发现需要批注的文本")}</div>${pendingCount === 0 ? `<div class="review-export-action"><div><strong>批注已全部处理</strong><span>${acceptedCount ? `已应用 ${acceptedCount} 处修改` : "已完成建议确认"}</span></div><button class="btn ${isPdf ? "primary" : ""}" data-export-resume-pdf ${isPdf ? "" : "disabled"}>${icon("download", 16)}导出 PDF 版简历</button></div>` : ""}</aside></section>
  `;
}

function renderResumeUploadPage() {
  return `<div class="upload-page"><div class="page-actions"><div><span class="module-product-name">Resume Copilot</span><h2>AI 简历助手</h2></div></div><div class="upload-zone" id="uploadZone">${icon("upload-cloud", 32)}<strong>选择 PDF 或 DOCX 文件</strong><span>文件仅在当前浏览器本地处理</span><input type="file" id="resumeFile" accept=".pdf,.docx" /></div><div class="upload-error" id="uploadError" hidden></div></div>`;
}

function renderResumeBadge(resume) {
  return `<span class="file-badge">${icon("file-text")}<span>${escapeHtml(resume.name)}</span><button class="icon-btn small-icon" id="replaceResumeBtn" aria-label="替换简历">${icon("replace", 15)}</button><button class="icon-btn small-icon" id="removeResumeBtn" aria-label="移除简历">${icon("trash-2", 15)}</button><input type="file" id="resumeFile" accept=".pdf,.docx" hidden /></span>`;
}

function renderAnnotatedResume(text, issues) {
  const source = String(text || "").slice(0, 16000);
  const ranges = [];
  issues.forEach((issue, index) => {
    const original = String(issue.original || "").trim();
    if (!original) return;
    let start = source.indexOf(original);
    while (start >= 0 && ranges.some(range => start < range.end && start + original.length > range.start)) start = source.indexOf(original, start + original.length);
    if (start >= 0) ranges.push({ start, end: start + original.length, index, status: issue.workflowStatus || "pending" });
  });
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const html = ranges.map(range => {
    const before = escapeHtml(source.slice(cursor, range.start));
    const highlighted = escapeHtml(source.slice(range.start, range.end));
    cursor = range.end;
    return `${before}<mark class="resume-highlight status-${range.status}" data-highlight-index="${range.index}">${highlighted}<button type="button" data-select-comment="${range.index}" aria-label="查看批注 ${range.index + 1}">${range.index + 1}</button></mark>`;
  }).join("") + escapeHtml(source.slice(cursor));
  return `<div class="resume-annotated-text">${html || "未提取到简历文本"}</div>`;
}

function renderReviewComment(issue, index) {
  const status = issue.workflowStatus || "pending";
  const isComplete = ["completed", "saved"].includes(status);
  const resolved = status === "ignored" || isComplete;
  const commentKey = getResolvedCommentKey(index);
  const collapsed = resolved && !expandedResolvedComments.has(commentKey);
  return `<article class="review-comment status-${status}${collapsed ? " collapsed" : ""}${activeReviewCommentIndex === index ? " active" : ""}" id="review-comment-${index}" data-comment-index="${index}" tabindex="0" aria-label="定位批注 ${index + 1} 对应的简历原文"><div class="comment-head"><span class="comment-number">${index + 1}</span><div class="comment-finding"><small>问题类型</small><h3>${escapeHtml(getIssueOptimizationType(issue))}</h3></div><span class="comment-status ${isComplete ? "complete" : ""}">${status === "ignored" ? "已忽略" : isComplete ? "已完成" : "待处理"}</span>${resolved ? `<button class="icon-btn comment-collapse-toggle" data-toggle-resolved-comment="${index}" aria-label="${collapsed ? "展开" : "折叠"}批注 ${index + 1}" title="${collapsed ? "展开批注" : "折叠批注"}">${icon(collapsed ? "chevron-down" : "chevron-up", 14)}</button>` : ""}</div><div class="comment-body"><div class="comment-detail"><small>问题</small><p>${escapeHtml(getIssueProblem(issue))}</p></div><div class="comment-detail"><small>建议</small><p>${escapeHtml(getIssueSuggestionText(issue))}</p></div><div class="comment-actions"><button class="btn primary compact-action" data-apply-suggestion="${index}">${icon("wand-sparkles", 14)}AI 优化表达</button><button class="btn compact-action" data-manual-suggestion="${index}">${icon("pencil-line", 14)}自主修改</button><button class="btn compact-action" data-ignore-suggestion="${index}">${status === "ignored" ? "恢复建议" : "忽略建议"}</button></div></div></article>`;
}

function getResolvedCommentKey(index) {
  return `${currentJobId || "none"}:${activeResumeReviewIndex ?? "latest"}:${index}`;
}

function getIssueOptimizationType(issue) {
  const value = issue.optimizationType || issue.reviewType || issue.category || issue.type || "";
  const context = `${value} ${issue.problem || issue.finding || ""} ${issue.suggestion || issue.suggestedInformation || ""}`;
  return /岗位|匹配|JD|关键词|核心能力/i.test(context) ? "岗位匹配优化" : "经历表达优化";
}

function getIssueProblem(issue) {
  return compactSentence(issue.problem || issue.finding || issue.problemTag || issue.title || issue.issue || "当前经历未充分体现具体贡献。", 42);
}

function getIssueSuggestionText(issue) {
  const raw = issue.suggestion || issue.suggestedInformation || issue.optimizationDirection || ["负责内容", "具体行动", "实际结果"];
  if (typeof raw === "string") return compactSentence(raw, 46);
  const items = asArray(raw)
    .map(item => String(item).replace(/^[补充说明量化梳理强化：:\s]+/, "").replace(/[。；;]+$/g, ""))
    .filter(Boolean);
  return `补充${items.join("、") || "项目规模、具体执行动作、数据结果或业务影响"}。`;
}

function renderSuggestionWorkbench(review, issue, index) {
  const drafts = review.drafts || {};
  const draft = drafts[index] || {};
  const prompts = [
    { title: "经历背景", hint: "请补充项目背景、目标或具体场景" },
    { title: "负责目标", hint: "请补充你承担的任务目标，或当时需要解决的问题" },
    { title: "具体行动", hint: "请补充你采取的措施、执行过程或使用的方法" },
    { title: "最终结果", hint: "请补充项目产生的数据结果、影响或实际产出" }
  ];
  const direction = getIssueSuggestionText(issue);
  return `<div class="workbench"><button class="back-link" id="backSuggestionsBtn">${icon("arrow-left")}返回批注编辑器</button><div class="workbench-grid"><section><div class="eyebrow">COMMENT ${String(index + 1).padStart(2, "0")}</div><h2>${escapeHtml(getIssueLabel(issue))}</h2><div class="source-text"><small>优化前</small><p>${escapeHtml(issue.original || "")}</p></div><div class="framework"><small>本次优化重点</small><p>${escapeHtml(direction)}</p></div><div class="field"><span>经历信息（可选）</span>${renderSupplementEditor(draft)}<textarea id="supplementInput" hidden>${escapeHtml(draft.supplement || "")}</textarea></div><div class="question-prompts" aria-label="经历信息快捷提示">${prompts.map(item => `<button type="button" data-question-prompt data-prompt-title="${escapeHtml(item.title)}" data-prompt-hint="${escapeHtml(item.hint)}">${icon("plus", 13)}${escapeHtml(item.title)}</button>`).join("")}</div><div class="actions"><button class="btn primary" id="polishResumeBtn">${icon("sparkles")}AI 优化表达</button></div></section><section class="result-editor"><div class="section-heading"><h3>优化后</h3>${draft.polished ? `<span class="state-label complete">等待确认</span>` : `<span class="state-label">尚未生成</span>`}</div>${draft.polished ? `<div class="before-after"><div><small>优化前</small><p>${escapeHtml(issue.original || "")}</p></div><label><small>优化后</small><textarea class="textarea final-copy" id="finalResumeText">${escapeHtml(draft.polished)}</textarea></label></div><div class="result-actions"><button class="btn" id="cancelPolishBtn">${icon("x", 15)}取消</button><button class="btn" id="repolishBtn">${icon("refresh-cw")}继续优化</button><button class="btn primary" id="saveResumeVersionBtn">${icon("replace", 15)}替换原文</button></div><p class="confirmation-note">只有点击“替换原文”后，修改才会应用到导出的 PDF 版本。</p>` : `<div class="polish-empty">${icon("wand-sparkles", 24)}<strong>等待 AI 优化表达</strong><p>可直接基于原文优化；仅在确有信息时补充经历细节。</p></div>`}</section></div></div>`;
}

function renderSupplementEditor(draft) {
  const entries = asArray(draft.supplementEntries);
  const fallback = entries.length ? draft.supplementFreeform || "" : draft.supplement || "";
  return `<div class="supplement-editor" id="supplementEditor">${entries.map((entry, index) => renderSupplementEntry(entry, index + 1)).join("")}<div class="supplement-freeform" id="supplementFreeform" contenteditable="plaintext-only" data-placeholder="${entries.length ? "继续补充其他信息..." : "输入经历信息，或点击下方快捷提示..."}">${escapeHtml(fallback)}</div></div>`;
}

function renderSupplementEntry(entry, number) {
  const hint = entry.hint || getSupplementPromptHint(entry.title);
  return `<div class="supplement-entry" data-supplement-entry data-title="${escapeHtml(entry.title)}" data-hint="${escapeHtml(hint)}"><div class="supplement-prompt"><span><b class="supplement-order">${number}</b>、${escapeHtml(entry.title)}（${escapeHtml(hint)}）：</span><button type="button" class="icon-btn supplement-remove" data-remove-supplement-entry aria-label="删除${escapeHtml(entry.title)}" title="删除此项">${icon("x", 13)}</button></div><div class="supplement-answer" contenteditable="plaintext-only" data-placeholder="在这里输入真实经历信息...">${escapeHtml(entry.answer || "")}</div></div>`;
}

function getSupplementPromptHint(title) {
  return {
    "经历背景": "请补充项目背景、目标或具体场景",
    "负责目标": "请补充你承担的任务目标，或当时需要解决的问题",
    "具体行动": "请补充你采取的措施、执行过程或使用的方法",
    "最终结果": "请补充项目产生的数据结果、影响或实际产出"
  }[title] || "请补充相关真实经历信息";
}

function getIssueLabel(issue) {
  return getIssueOptimizationType(issue);
}

function renderOptimizationDirection(value) {
  const items = asArray(value).slice(0, 4).map(formatActionableDirection);
  return items.length > 1
    ? `<ul class="direction-points">${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(items[0] || "补充规模、具体行动和最终结果。")}</p>`;
}

function formatActionableDirection(value) {
  return String(value || "")
    .replace(/补充真实经历信息/g, "补充规模、具体行动和最终结果")
    .replace(/补充真实经历细节/g, "补充规模、具体行动和最终结果");
}

function renderTracker(job) {
  const history = normalizeTrackerHistory(job);
  const finalStep = job.status === "已Offer" || job.status === "Offer"
    ? { value: "已Offer", label: "Offer" }
    : job.status === "未通过"
      ? { value: "未通过", label: "未通过" }
      : { value: "结果", label: "结果" };
  const applicationSteps = [
    { value: "待投递", label: "待投递" },
    { value: "已投递", label: "已投递" },
    { value: "面试中", label: "面试中" },
    finalStep
  ];
  const currentIndex = job.status === "已Offer" || job.status === "Offer" || job.status === "未通过"
    ? 3
    : applicationSteps.findIndex(step => step.value === job.status);
  const guidance = getTrackerGuidance(job.status);
  return `<div class="page-actions"><div><span class="module-product-name">Application Tracker</span><h2>投递追踪</h2></div></div>
    <section class="tracker-panel">
      <div class="tracker-current"><div><span>当前申请阶段</span><strong>${escapeHtml(job.status)}</strong></div><small>更新于 ${formatDateTime(job.statusUpdatedAt)}</small><button class="btn primary" id="trackerUpdateStatusBtn">${icon("refresh-cw", 16)}更新状态</button></div>
      ${statusEditorOpen ? `<div class="status-update-panel"><label class="field">切换申请状态<select class="select" id="trackerStatusSelect">${JOB_STATUSES.map(status => `<option ${job.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label><div class="actions"><button class="btn" id="cancelStatusUpdateBtn">取消</button><button class="btn primary" id="confirmStatusUpdateBtn">确认更新</button></div></div>` : ""}
      <div class="tracker-block-title"><strong>申请流程</strong><span>当前：${escapeHtml(job.status)}</span></div>
      <div class="status-steps">${applicationSteps.map((step, index) => `<div class="status-step ${job.status === step.value || (step.value === "已Offer" && job.status === "Offer") ? "active" : ""} ${index < currentIndex ? "complete" : ""}"><span>${index < currentIndex ? icon("check", 12) : index + 1}</span><strong>${step.label}</strong></div>`).join("")}</div>
    </section>
    <section class="tracker-guidance"><div class="tracker-guidance-icon">${icon(guidance.icon, 22)}</div><div><span>下一步建议</span><strong>${guidance.title}</strong><p>${guidance.copy}</p></div>${guidance.actions ? `<div class="actions">${guidance.actions}</div>` : ""}</section>
    <section class="content-section tracker-history"><div class="section-heading"><h2>状态记录</h2><span>${history.length} 条记录</span></div><ol class="timeline">${history.slice().reverse().map(item => `<li><span class="timeline-dot"></span><div><small>${formatDateTime(item.changedAt)}</small><strong>${item.fromStatus ? `状态更新：${escapeHtml(item.fromStatus)} → ${escapeHtml(item.toStatus)}` : `创建岗位：${escapeHtml(item.toStatus || item.status)}`}</strong></div></li>`).join("")}</ol></section>`;
}

function normalizeTrackerHistory(job) {
  const raw = asArray(state.statusHistory[currentJobId]);
  if (!raw.length) return [{ status: job.status, toStatus: job.status, changedAt: job.statusUpdatedAt || job.createdAt }];
  let previous = null;
  return raw.map((item, index) => {
    const toStatus = item.toStatus || item.status || job.status;
    const normalized = { ...item, toStatus, status: toStatus };
    if (item.fromStatus) normalized.fromStatus = item.fromStatus;
    else if (index > 0 && previous !== toStatus) normalized.fromStatus = previous;
    previous = toStatus;
    return normalized;
  });
}

function getTrackerGuidance(status) {
  if (status === "待投递") return { icon: "send", title: "完成岗位定制并确认投递", copy: "先处理简历批注并导出最新版简历，再通过上方入口更新状态。", actions: `<button class="btn" data-tab="resume">${icon("file-pen-line", 16)}优化简历</button>` };
  if (status === "已投递") return { icon: "clock-3", title: "记录投递结果并持续跟进", copy: "留意招聘方反馈；收到面试或结果通知后通过上方入口更新状态。", actions: "" };
  if (status === "面试中") return { icon: "messages-square", title: "围绕岗位要求准备面试", copy: "回看岗位洞察与简历中的核心经历，准备能力证明和项目细节。", actions: `<button class="btn" data-tab="jd">${icon("scan-search", 16)}查看岗位洞察</button>` };
  if (status === "已Offer") return { icon: "badge-check", title: "确认 Offer 与最终选择", copy: "核对岗位、入职时间和关键条件，需要变更时通过上方入口更新状态。", actions: "" };
  return { icon: "history", title: "复盘本次申请", copy: "保留岗位分析、简历版本和过程记录，为下一次申请积累经验。", actions: `<button class="btn" data-tab="history">${icon("history", 16)}查看求职资料</button>` };
}

function renderHistory() {
  const reviews = state.resumeReviews[currentJobId] || [];
  const versions = state.resumeVersions[currentJobId] || [];
  const jdReview = state.jdReviews[currentJobId];
  const resume = state.resumes[currentJobId];
  const analysisAssets = [
    jdReview ? `<button class="history-resource" data-open-history-asset="jd"><span class="history-resource-icon">${icon("scan-search", 18)}</span><span class="history-resource-copy"><strong>岗位分析</strong><small>岗位解析 · ${state.jdMatches[currentJobId] ? "用户匹配 · " : ""}${state.jobDirections[currentJobId] ? "竞争力提升 · " : ""}${formatDateTime(getCurrentJob()?.updatedAt)}</small></span>${icon("chevron-right", 17)}</button>` : "",
    ...reviews.map((review, index) => `<button class="history-resource" data-open-history-asset="resume" data-review-index="${index}"><span class="history-resource-icon">${icon("message-square-text", 18)}</span><span class="history-resource-copy"><strong>简历优化记录 · ${review.fitScore || "-"} 分</strong><small>${asArray(review.paragraphIssues || review.suggestions).length} 条 AI 批注 · ${formatDateTime(review.createdAt)}</small></span>${icon("chevron-right", 17)}</button>`).reverse()
  ].filter(Boolean);
  const versionAssets = [
    resume?.type === "application/pdf" ? `<button class="history-resource resume-asset" data-download-resume-version="original"><span class="version-number">v1.0</span><span class="history-resource-copy"><strong>${escapeHtml(resume.name || "原始简历.pdf")}</strong><small>原始简历 · ${formatDateTime(resume.uploadedAt)}</small></span>${icon("download", 17)}</button>` : "",
    ...versions.map((version, index) => `<button class="history-resource resume-asset" data-download-resume-version="${escapeHtml(version.id)}"><span class="version-number">v1.${index + 1}</span><span class="history-resource-copy"><strong>${escapeHtml(version.fileName || `${getCurrentJob()?.company || ""}-${getCurrentJob()?.title || ""}-岗位优化版.pdf`)}</strong><small>岗位优化版 · ${formatDateTime(version.createdAt)}</small></span>${icon("download", 17)}</button>`)
  ].filter(Boolean);
  return `<div class="page-actions"><div><h2>历史记录</h2></div></div><section class="history-grid asset-history-grid"><section class="content-section"><div class="section-heading"><h2>分析记录</h2><span>${analysisAssets.length} 项</span></div><div class="history-resource-list">${analysisAssets.length ? analysisAssets.join("") : renderInlineEmpty("暂无分析记录")}</div></section><section class="content-section"><div class="section-heading"><h2>简历版本</h2><span>${versionAssets.length} 个 PDF</span></div><div class="history-resource-list">${versionAssets.length ? versionAssets.join("") : renderInlineEmpty("暂无简历版本")}</div></section></section>`;
}

function renderAnalysisEmpty(productName, title, iconName, copy, buttonId, buttonText) {
  return `<div class="page-actions"><div><span class="module-product-name">${escapeHtml(productName)}</span><h2>${escapeHtml(title)}</h2></div></div><div class="analysis-empty"><span class="analysis-icon">${icon(iconName, 30)}</span><h2>从岗位 JD 开始</h2><p>${copy}</p><button class="btn primary" id="${buttonId}">${buttonText}${icon("arrow-right")}</button></div>`;
}

function renderInlineEmpty(text) {
  return `<div class="inline-empty">${escapeHtml(text)}</div>`;
}

function bindWorkspaceEvents() {
  $("#backJobsBtn")?.addEventListener("click", () => { currentView = "jobs"; render(); });
  document.querySelectorAll("[data-tab]").forEach(tab => tab.addEventListener("click", () => {
    currentTab = tab.dataset.tab;
    activeSuggestionIndex = null;
    statusEditorOpen = false;
    if (currentTab === "resume") activeResumeReviewIndex = null;
    render();
  }));
  document.querySelectorAll("[data-jd-section]").forEach(tab => tab.addEventListener("click", () => {
    activeJdSection = tab.dataset.jdSection;
    document.querySelectorAll("[data-jd-section]").forEach(item => {
      item.classList.toggle("active", item === tab);
      item.setAttribute("aria-current", item === tab ? "true" : "false");
    });
    document.getElementById(tab.dataset.jdTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#trackerUpdateStatusBtn")?.addEventListener("click", openStatusEditor);
  $("#cancelStatusUpdateBtn")?.addEventListener("click", () => { statusEditorOpen = false; render(); });
  $("#confirmStatusUpdateBtn")?.addEventListener("click", () => updateJobStatus($("#trackerStatusSelect")?.value));
  bindEditJobEvents();
  $("#runJdReviewBtn")?.addEventListener("click", runJdReview);
  $("#runJdMatchBtn")?.addEventListener("click", runJdMatch);
  $("#runResumeReviewBtn")?.addEventListener("click", runResumeReview);
  $("#latestResumeReviewBtn")?.addEventListener("click", () => { activeResumeReviewIndex = null; activeSuggestionIndex = null; render(); });
  $("#resumeFile")?.addEventListener("change", handleResumeUpload);
  $("#replaceResumeBtn")?.addEventListener("click", () => $("#resumeFile")?.click());
  $("#removeResumeBtn")?.addEventListener("click", removeCurrentResume);
  document.querySelectorAll("[data-apply-suggestion]").forEach(button => button.addEventListener("click", () => { activeSuggestionIndex = Number(button.dataset.applySuggestion); render(); }));
  document.querySelectorAll("[data-manual-suggestion]").forEach(button => button.addEventListener("click", () => startManualSuggestion(Number(button.dataset.manualSuggestion))));
  document.querySelectorAll("[data-ignore-suggestion]").forEach(button => button.addEventListener("click", () => toggleSuggestion(Number(button.dataset.ignoreSuggestion))));
  document.querySelectorAll("[data-toggle-resolved-comment]").forEach(button => button.addEventListener("click", () => toggleResolvedComment(Number(button.dataset.toggleResolvedComment))));
  document.querySelectorAll("[data-select-comment]").forEach(button => button.addEventListener("click", () => selectReviewComment(Number(button.dataset.selectComment))));
  document.querySelectorAll("[data-comment-index]").forEach(card => {
    const openIssue = () => {
      activeSuggestionIndex = Number(card.dataset.commentIndex);
      render();
    };
    card.addEventListener("click", event => {
      if (!event.target.closest("button, a, input, textarea, select")) openIssue();
    });
    card.addEventListener("keydown", event => {
      if (event.target.closest("button, a, input, textarea, select")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openIssue();
      }
    });
  });
  $("#pdfZoomOutBtn")?.addEventListener("click", () => adjustPdfZoom(-0.1));
  $("#pdfZoomInBtn")?.addEventListener("click", () => adjustPdfZoom(0.1));
  $("#pdfFitPageBtn")?.addEventListener("click", fitPdfToPage);
  $("#startReviewFlowBtn")?.addEventListener("click", startResumeRevision);
  $("#backSuggestionsBtn")?.addEventListener("click", () => { activeSuggestionIndex = null; render(); });
  document.querySelectorAll("[data-question-prompt]").forEach(button => button.addEventListener("click", () => appendPrompt(button.dataset.promptTitle, button.dataset.promptHint)));
  document.querySelectorAll("[data-remove-supplement-entry]").forEach(button => button.addEventListener("click", () => removeSupplementEntry(button)));
  document.querySelectorAll(".supplement-answer, #supplementFreeform").forEach(input => input.addEventListener("input", syncSupplementInput));
  $("#polishResumeBtn")?.addEventListener("click", () => polishSuggestion(false));
  $("#repolishBtn")?.addEventListener("click", () => polishSuggestion(true));
  $("#cancelPolishBtn")?.addEventListener("click", cancelPolish);
  $("#saveResumeVersionBtn")?.addEventListener("click", saveResumeVersion);
  document.querySelectorAll("[data-export-resume-pdf]").forEach(button => button.addEventListener("click", exportResumePdf));
  document.querySelectorAll("[data-open-history-asset]").forEach(button => button.addEventListener("click", () => openHistoryAsset(button)));
  document.querySelectorAll("[data-download-resume-version]").forEach(button => button.addEventListener("click", () => downloadResumeVersion(button.dataset.downloadResumeVersion, button)));
}

function openHistoryAsset(button) {
  if (button.dataset.openHistoryAsset === "jd") {
    currentTab = "jd";
    activeJdSection = "insight";
  } else {
    currentTab = "resume";
    activeResumeReviewIndex = Number(button.dataset.reviewIndex);
    activeSuggestionIndex = null;
  }
  render();
}

function removeCurrentResume() {
  if (!confirm("移除当前简历吗？已保存的历史版本仍会保留。")) return;
  delete state.resumes[currentJobId];
  delete state.jdMatches[currentJobId];
  delete state.jobDirections[currentJobId];
  state.resumeReviews[currentJobId] = [];
  if (resumeObjectUrl) URL.revokeObjectURL(resumeObjectUrl);
  resumeObjectUrl = null;
  activeResumeReviewIndex = null;
  deleteResumeBlob(currentJobId);
  saveState();
  render();
}

function bindEditJobEvents() {
  const modal = $("#editJobModal");
  $("#editJobBtn")?.addEventListener("click", () => { modal.hidden = false; });
  $("#closeEditJob")?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", event => { if (event.target === modal) modal.hidden = true; });
  $("#saveJobInfoBtn")?.addEventListener("click", () => {
    const job = getCurrentJob();
    const title = $("#editJobTitle").value.trim();
    const company = $("#editJobCompany").value.trim();
    const jd = $("#editJobJd").value.trim();
    if (!title || !company || jd.length < 30) { $("#editJobHint").textContent = "请补充完整岗位信息。"; return; }
    const jdChanged = job.jd !== jd;
    Object.assign(job, { title, company, jd, updatedAt: new Date().toISOString() });
    if (jdChanged) {
      delete state.jdMatches[currentJobId];
      delete state.jobDirections[currentJobId];
    }
    saveState();
    render();
  });
}

function updateJobStatus(status) {
  const job = getCurrentJob();
  if (!job || !JOB_STATUSES.includes(status)) return;
  if (job.status === status) {
    statusEditorOpen = false;
    render();
    return;
  }
  const now = new Date().toISOString();
  if (!state.statusHistory[currentJobId]?.length) {
    state.statusHistory[currentJobId] = [{ status: job.status, toStatus: job.status, changedAt: job.statusUpdatedAt || job.updatedAt || job.createdAt }];
  }
  const previousStatus = job.status;
  job.status = status;
  job.statusUpdatedAt = now;
  job.updatedAt = now;
  state.statusHistory[currentJobId].push({ status, fromStatus: previousStatus, toStatus: status, changedAt: now });
  statusEditorOpen = false;
  saveState();
  render();
}

function openStatusEditor() {
  statusEditorOpen = true;
  render();
}

function startResumeRevision() {
  const index = Number($("#startReviewFlowBtn")?.dataset.issueIndex);
  if (!Number.isInteger(index) || index < 0) return;
  activeSuggestionIndex = index;
  render();
}

function startManualSuggestion(index) {
  const review = getLatestResumeReview();
  const issue = asArray(review?.paragraphIssues || review?.suggestions)[index];
  if (!issue) return;
  review.drafts ||= {};
  const currentDraft = review.drafts[index] || {};
  review.drafts[index] = {
    ...currentDraft,
    polished: currentDraft.polished || issue.manualDraft || issue.original || "",
    reason: currentDraft.reason || "用户基于原文自主修改。"
  };
  activeSuggestionIndex = index;
  saveState();
  render();
}

async function handleResumeUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isDocx = file.name.toLowerCase().endsWith(".docx");
  if (!isPdf && !isDocx) { showUploadError("请选择 PDF 或 DOCX 文件。"); return; }
  const trigger = $("#uploadZone");
  trigger?.classList.add("loading");
  try {
    const pdfData = isPdf ? await extractPdfData(file) : null;
    const extractedText = isPdf ? pdfData.text : await extractDocxText(file);
    if (extractedText.trim().length < 30) throw new Error("未能从文件中读取到足够的文字，请检查文件是否为扫描件或受保护文件。");
    if (resumeObjectUrl) URL.revokeObjectURL(resumeObjectUrl);
    resumeObjectUrl = isPdf ? URL.createObjectURL(file) : null;
    if (isPdf) await saveResumeBlob(currentJobId, file);
    else await deleteResumeBlob(currentJobId);
    state.resumes[currentJobId] = { name: file.name, type: isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", uploadedAt: new Date().toISOString(), extractedText, charCount: extractedText.length, pageCount: pdfData?.pageCount || null, pdfTextElements: pdfData?.elements || [], pdfPages: pdfData?.pageSizes || [] };
    delete state.jdMatches[currentJobId];
    delete state.jobDirections[currentJobId];
    delete state.revisions[currentJobId];
    delete state.resumeVersions[currentJobId];
    state.resumeReviews[currentJobId] = [];
    activeResumeReviewIndex = null;
    saveState();
    render();
  } catch (error) {
    showUploadError(error.message || "简历解析失败，请重新上传。");
    trigger?.classList.remove("loading");
  }
}

function showUploadError(message) {
  const target = $("#uploadError");
  if (target) { target.hidden = false; target.textContent = message; } else alert(message);
}

async function extractPdfData(file) {
  const pdfjs = await import("/vendor/pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  const elements = [];
  const pageSizes = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    pageSizes.push({ page: pageNumber, width: Number(viewport.width.toFixed(2)), height: Number(viewport.height.toFixed(2)) });
    pages.push(`--- 第 ${pageNumber} 页 ---\n${content.items.map(item => item.str).join(" ")}`);
    content.items.forEach(item => {
      if (!String(item.str || "").trim()) return;
      const rect = getPdfItemRect(pdfjs, viewport, item);
      const style = content.styles?.[item.fontName] || {};
      const fontFamily = String(style.fontFamily || "sans-serif").replace(/["']/g, "");
      elements.push({
        page: pageNumber,
        content: item.str,
        fontFamily,
        fontSize: Number(rect.height.toFixed(2)),
        fontWeight: /bold|black|heavy|semibold|demi/i.test(`${item.fontName || ""} ${fontFamily}`) ? 700 : 400,
        x: Number(rect.left.toFixed(2)),
        y: Number(rect.top.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2))
      });
    });
  }
  return { text: pages.join("\n\n"), pageCount: pdf.numPages, elements, pageSizes };
}

function openResumeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jobflow_files", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("resumes")) request.result.createObjectStore("resumes");
      if (!request.result.objectStoreNames.contains("versions")) request.result.createObjectStore("versions");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveResumeBlob(jobId, blob) {
  const db = await openResumeDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("resumes", "readwrite");
    transaction.objectStore("resumes").put(blob, jobId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function getResumeBlob(jobId) {
  const db = await openResumeDb();
  const blob = await new Promise((resolve, reject) => {
    const request = db.transaction("resumes").objectStore("resumes").get(jobId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return blob;
}

async function deleteResumeBlob(jobId) {
  const db = await openResumeDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("resumes", "readwrite");
    transaction.objectStore("resumes").delete(jobId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function resumeVersionStorageKey(jobId, versionId) {
  return `${jobId}:${versionId}`;
}

async function saveResumeVersionBlob(jobId, versionId, blob) {
  const db = await openResumeDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("versions", "readwrite");
    transaction.objectStore("versions").put(blob, resumeVersionStorageKey(jobId, versionId));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function getResumeVersionBlob(jobId, versionId) {
  const db = await openResumeDb();
  const blob = await new Promise((resolve, reject) => {
    const request = db.transaction("versions").objectStore("versions").get(resumeVersionStorageKey(jobId, versionId));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return blob;
}

async function extractDocxText(file) {
  const response = await fetch("/api/parse-docx", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    body: await file.arrayBuffer()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) throw new Error("DOCX 解析失败，请检查文件后重新上传。");
  return json.text;
}

async function prepareResumeDocument() {
  const viewer = $("#pdfReviewViewer");
  const resume = state.resumes[currentJobId];
  if (!viewer || resume?.type !== "application/pdf") return;
  const token = ++pdfRenderToken;
  try {
    const blob = await getResumeBlob(currentJobId);
    if (!blob || token !== pdfRenderToken || !document.body.contains(viewer)) {
      if (!blob && document.body.contains(viewer)) viewer.innerHTML = `<div class="pdf-missing">${icon("file-warning", 24)}<strong>原 PDF 文件未保存在当前浏览器</strong><span>请点击上方替换按钮重新上传，分析记录仍会保留。</span></div>`;
      window.lucide?.createIcons();
      return;
    }
    if (resumeObjectUrl) URL.revokeObjectURL(resumeObjectUrl);
    resumeObjectUrl = URL.createObjectURL(blob);
    await renderPdfReviewViewer(viewer, blob, token);
  } catch (error) {
    if (document.body.contains(viewer)) viewer.innerHTML = `<div class="pdf-missing"><strong>PDF 预览加载失败</strong><span>${escapeHtml(error.message || "请重新上传文件")}</span></div>`;
  }
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function locateIssueItems(items, issues) {
  const records = [];
  let pageText = "";
  items.forEach((item, itemIndex) => {
    const text = compactText(item.str);
    const start = pageText.length;
    pageText += text;
    records.push({ itemIndex, start, end: pageText.length });
  });
  return issues.map(issue => {
    const needle = compactText(issue.original);
    if (!needle) return [];
    let start = pageText.indexOf(needle);
    let length = needle.length;
    if (start < 0 && needle.length > 12) {
      const anchor = needle.slice(0, Math.min(18, needle.length));
      start = pageText.indexOf(anchor);
      length = Math.min(needle.length, Math.max(anchor.length, 60));
    }
    if (start < 0) return [];
    const end = start + length;
    return records.filter(record => record.start < end && record.end > start).map(record => record.itemIndex);
  });
}

function getPdfItemRect(pdfjs, viewport, item) {
  const transform = pdfjs.Util.transform(viewport.transform, item.transform);
  const height = Math.max(8, Math.hypot(transform[2], transform[3]));
  return {
    left: transform[4],
    top: transform[5] - height,
    width: Math.max(4, Math.abs(item.width * viewport.scale)),
    height
  };
}

function unionRects(rects) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map(rect => rect.left));
  const top = Math.min(...rects.map(rect => rect.top));
  const right = Math.max(...rects.map(rect => rect.left + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function latestAcceptedRevisions(source = state.revisions[currentJobId] || []) {
  const latest = new Map();
  source.forEach(revision => {
    if (revision.original && revision.revised) latest.set(compactText(revision.original), revision);
  });
  return [...latest.values()];
}

async function renderPdfReviewViewer(viewer, blob, token) {
  const pdfjs = await import("/vendor/pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
  const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const issues = asArray(getLatestResumeReview()?.paragraphIssues || getLatestResumeReview()?.suggestions);
  const revisions = latestAcceptedRevisions();
  const firstPage = await pdf.getPage(1);
  const firstBaseViewport = firstPage.getViewport({ scale: 1.22 });
  const availableWidth = Math.max(280, (viewer.closest(".resume-paper")?.clientWidth || firstBaseViewport.width) - 48);
  const effectiveZoom = pdfFitPage
    ? Math.min(1.4, Math.max(0.35, availableWidth / firstBaseViewport.width))
    : Math.min(1.8, Math.max(0.35, pdfZoom));
  pdfRenderedZoom = effectiveZoom;
  updatePdfZoomUi();
  viewer.innerHTML = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (token !== pdfRenderToken || !document.body.contains(viewer)) return;
    const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.22 * effectiveZoom });
    const pageElement = document.createElement("section");
    pageElement.className = "pdf-review-page";
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    pageElement.innerHTML = `<canvas></canvas><div class="pdf-annotation-layer"></div><span class="pdf-page-number">${pageNumber} / ${pdf.numPages}</span>`;
    viewer.appendChild(pageElement);

    const canvas = pageElement.querySelector("canvas");
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] }).promise;

    const textContent = await page.getTextContent();
    const matches = locateIssueItems(textContent.items, issues);
    const layer = pageElement.querySelector(".pdf-annotation-layer");
    matches.forEach((itemIndexes, issueIndex) => {
      if (!itemIndexes.length) return;
      const issue = issues[issueIndex];
      const rects = itemIndexes.map(itemIndex => getPdfItemRect(pdfjs, viewport, textContent.items[itemIndex]));
      const revision = revisions.find(item => compactText(item.original) === compactText(issue.original));
      if (revision) {
        const bounds = unionRects(rects);
        const replacement = document.createElement("div");
        replacement.className = `pdf-confirmed-replacement${activeReviewCommentIndex === issueIndex ? " active" : ""}`;
        replacement.dataset.highlightIndex = issueIndex;
        replacement.style.cssText = `left:${Math.max(0, bounds.left - 2)}px;top:${Math.max(0, bounds.top - 1)}px;width:${Math.max(bounds.width + 6, 90)}px;min-height:${bounds.height + 3}px;font-size:${Math.max(8, Math.min(11, bounds.height * .78))}px`;
        replacement.textContent = revision.revised;
        layer.appendChild(replacement);
      } else {
        rects.forEach(rect => {
          const highlight = document.createElement("span");
          highlight.className = `pdf-text-highlight status-${issue.workflowStatus || "pending"}${activeReviewCommentIndex === issueIndex ? " active" : ""}`;
          highlight.dataset.highlightIndex = issueIndex;
          highlight.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          layer.appendChild(highlight);
        });
      }
      const lastRect = rects.at(-1);
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `pdf-comment-marker status-${issue.workflowStatus || "pending"}${activeReviewCommentIndex === issueIndex ? " active" : ""}`;
      marker.dataset.selectComment = issueIndex;
      marker.dataset.highlightIndex = issueIndex;
      marker.setAttribute("aria-label", `查看批注 ${issueIndex + 1}`);
      marker.textContent = issueIndex + 1;
      const markerSize = 16;
      const preferredLeft = lastRect.left + lastRect.width + 4;
      const markerLeft = preferredLeft + markerSize <= viewport.width - 2
        ? preferredLeft
        : Math.max(2, lastRect.left - markerSize - 4);
      marker.style.cssText = `left:${markerLeft}px;top:${Math.max(2, lastRect.top + (lastRect.height - markerSize) / 2)}px`;
      marker.addEventListener("click", () => selectReviewComment(issueIndex));
      layer.appendChild(marker);
    });
  }
}

function updatePdfZoomUi() {
  const value = $("#pdfZoomValue");
  if (value) value.textContent = `${Math.round(pdfRenderedZoom * 100)}%`;
  const zoomOut = $("#pdfZoomOutBtn");
  const zoomIn = $("#pdfZoomInBtn");
  if (zoomOut) zoomOut.disabled = pdfRenderedZoom <= 0.35;
  if (zoomIn) zoomIn.disabled = pdfRenderedZoom >= 1.8;
  $("#pdfFitPageBtn")?.classList.toggle("active", pdfFitPage);
}

function adjustPdfZoom(delta) {
  pdfFitPage = false;
  pdfZoom = Math.min(1.8, Math.max(0.35, Number((pdfRenderedZoom + delta).toFixed(2))));
  pdfRenderedZoom = pdfZoom;
  updatePdfZoomUi();
  prepareResumeDocument();
}

function fitPdfToPage() {
  pdfFitPage = true;
  prepareResumeDocument();
}

function wrapCanvasText(context, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const char of String(text || "")) {
    if (char === "\n") {
      if (line) lines.push(line);
      line = "";
    } else if (context.measureText(line + char).width > maxWidth && line) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitReplacementText(context, text, maxWidth, maxHeight, preferredFontSize, fontFamily, fontWeight = "400") {
  let fontSize = preferredFontSize;
  let lines = [];
  let lineHeight = fontSize * 1.18;
  while (fontSize >= 5) {
    context.font = `${fontWeight} ${fontSize}px "${fontFamily}", "Microsoft YaHei", sans-serif`;
    lineHeight = fontSize * 1.18;
    lines = wrapCanvasText(context, text, maxWidth);
    if (lines.length * lineHeight <= maxHeight + 2) break;
    fontSize -= .5;
  }
  return { fontSize, lineHeight, lines };
}

function samplePdfRegionColors(context, bounds, scale) {
  const x = Math.max(0, Math.floor((bounds.left - 2) * scale));
  const y = Math.max(0, Math.floor((bounds.top - 2) * scale));
  const width = Math.max(1, Math.min(context.canvas.width - x, Math.ceil((bounds.width + 4) * scale)));
  const height = Math.max(1, Math.min(context.canvas.height - y, Math.ceil((bounds.height + 4) * scale)));
  const pixels = context.getImageData(x, y, width, height).data;
  const colorCounts = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    const color = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const key = color.map(channel => Math.min(255, Math.round(channel / 16) * 16)).join(",");
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  }
  const dominant = [...colorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const background = dominant ? dominant.split(",").map(Number) : [255, 255, 255];
  const foreground = [];
  for (let index = 0; index < pixels.length; index += 4) {
    const color = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const distance = Math.hypot(...color.map((channel, channelIndex) => channel - background[channelIndex]));
    if (distance > 72) foreground.push(color);
  }
  const average = (colors, fallback) => colors.length
    ? colors.reduce((sum, color) => sum.map((value, channel) => value + color[channel]), [0, 0, 0]).map(value => Math.round(value / colors.length))
    : fallback;
  return {
    text: average(foreground, [24, 35, 31]),
    background
  };
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(async blob => {
    if (!blob) {
      reject(new Error("无法生成替换文本图层。"));
      return;
    }
    resolve(await blob.arrayBuffer());
  }, "image/png"));
}

async function buildResumePdfBlob(revisionSource, jobId = currentJobId) {
  const sourceBlob = await getResumeBlob(jobId);
  const revisions = latestAcceptedRevisions(revisionSource);
  if (!sourceBlob) throw new Error("原 PDF 文件未保存在当前浏览器，请重新上传。");
  if (!revisions.length) return sourceBlob.slice(0, sourceBlob.size, "application/pdf");
  if (!window.PDFLib) throw new Error("PDF 组件尚未加载，请刷新页面后重试。");

  const pdfjs = await import("/vendor/pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
  const sourceBytes = await sourceBlob.arrayBuffer();
  const sourcePdf = await pdfjs.getDocument({ data: sourceBytes.slice(0) }).promise;
  const outputPdf = await window.PDFLib.PDFDocument.load(sourceBytes);
  const { rgb } = window.PDFLib;

  for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
    const page = await sourcePdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const matches = locateIssueItems(textContent.items, revisions);
    if (!matches.some(itemIndexes => itemIndexes.length)) continue;

    const sampleScale = 2;
    const sampleViewport = page.getViewport({ scale: sampleScale });
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = Math.ceil(sampleViewport.width);
    sampleCanvas.height = Math.ceil(sampleViewport.height);
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: sampleContext, viewport: sampleViewport }).promise;
    const outputPage = outputPdf.getPage(pageNumber - 1);

    for (let revisionIndex = 0; revisionIndex < matches.length; revisionIndex += 1) {
      const itemIndexes = matches[revisionIndex];
      if (!itemIndexes.length) continue;
      const rects = itemIndexes.map(itemIndex => getPdfItemRect(pdfjs, viewport, textContent.items[itemIndex]));
      const bounds = unionRects(rects);
      const firstItem = textContent.items[itemIndexes[0]];
      const fontStyle = textContent.styles?.[firstItem.fontName];
      const fontFamily = String(fontStyle?.fontFamily || "Microsoft YaHei").replace(/["']/g, "");
      const fontWeight = /bold|black|heavy|semibold|demi/i.test(`${firstItem.fontName || ""} ${fontFamily}`) ? "700" : "400";
      const preferredFontSize = Math.max(6, Math.min(22, rects[0].height * 0.82));
      const box = {
        left: Math.max(0, bounds.left - 1),
        top: Math.max(0, bounds.top - 1),
        width: Math.max(24, bounds.width + 2),
        height: Math.max(10, bounds.height + 2)
      };
      const colors = samplePdfRegionColors(sampleContext, box, sampleScale);
      const renderScale = 3;
      const replacementCanvas = document.createElement("canvas");
      replacementCanvas.width = Math.ceil(box.width * renderScale);
      replacementCanvas.height = Math.ceil(box.height * renderScale);
      const replacementContext = replacementCanvas.getContext("2d");
      replacementContext.scale(renderScale, renderScale);
      const fitted = fitReplacementText(replacementContext, revisions[revisionIndex].revised, box.width, box.height, preferredFontSize, fontFamily, fontWeight);
      replacementContext.clearRect(0, 0, box.width, box.height);
      replacementContext.fillStyle = `rgb(${colors.text.join(",")})`;
      replacementContext.textBaseline = "top";
      replacementContext.font = `${fontWeight} ${fitted.fontSize}px "${fontFamily}", "Microsoft YaHei", sans-serif`;
      fitted.lines.forEach((line, lineIndex) => replacementContext.fillText(line, 0, lineIndex * fitted.lineHeight, box.width));

      const pdfY = viewport.height - box.top - box.height;
      outputPage.drawRectangle({
        x: box.left,
        y: pdfY,
        width: box.width,
        height: box.height,
        color: rgb(colors.background[0] / 255, colors.background[1] / 255, colors.background[2] / 255),
        borderWidth: 0
      });
      const replacementImage = await outputPdf.embedPng(await canvasToPngBytes(replacementCanvas));
      outputPage.drawImage(replacementImage, {
        x: box.left,
        y: pdfY,
        width: box.width,
        height: box.height
      });
    }
  }

  return new Blob([await outputPdf.save()], { type: "application/pdf" });
}

function applyRevisionsToWordElements(elements, revisions) {
  const output = [];
  const pages = [...new Set(elements.map(item => item.page))].sort((a, b) => a - b);
  pages.forEach(pageNumber => {
    const pageItems = elements.filter(item => item.page === pageNumber);
    const matches = locateIssueItems(pageItems.map(item => ({ str: item.content })), revisions);
    const replacements = new Map();
    const skipped = new Set();
    matches.forEach((itemIndexes, revisionIndex) => {
      if (!itemIndexes.length || itemIndexes.some(index => skipped.has(index))) return;
      const matched = itemIndexes.map(index => pageItems[index]);
      const left = Math.min(...matched.map(item => item.x));
      const right = Math.max(...matched.map(item => item.x + item.width));
      const firstIndex = itemIndexes[0];
      replacements.set(firstIndex, {
        ...pageItems[firstIndex],
        content: revisions[revisionIndex].revised,
        x: left,
        width: right - left
      });
      itemIndexes.slice(1).forEach(index => skipped.add(index));
    });
    pageItems.forEach((item, index) => {
      if (!skipped.has(index)) output.push(replacements.get(index) || item);
    });
  });
  return output;
}

function groupWordElementsIntoLines(elements) {
  const pages = new Map();
  elements.forEach(item => {
    if (!pages.has(item.page)) pages.set(item.page, []);
    pages.get(item.page).push(item);
  });
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, pageItems]) => {
    const lines = [];
    pageItems.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach(item => {
      const tolerance = Math.max(2, item.fontSize * 0.35);
      let line = lines.find(candidate => Math.abs(candidate.y - item.y) <= tolerance);
      if (!line) {
        line = { y: item.y, items: [] };
        lines.push(line);
      }
      line.items.push(item);
      line.y = line.items.reduce((sum, entry) => sum + entry.y, 0) / line.items.length;
    });
    lines.sort((a, b) => a.y - b.y);
    lines.forEach(line => line.items.sort((a, b) => a.x - b.x));
    return { page, lines };
  });
}

function wordRunsForLine(line, TextRun) {
  const runs = [];
  let previous = null;
  line.items.forEach(item => {
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap > Math.max(1.5, item.fontSize * 0.18)) {
        const spaces = Math.min(14, Math.max(1, Math.round(gap / Math.max(2.5, item.fontSize * 0.45))));
        runs.push(new TextRun({ text: " ".repeat(spaces), font: item.fontFamily || previous.fontFamily || "Microsoft YaHei", size: Math.max(10, Math.round(item.fontSize * 2)) }));
      }
    }
    runs.push(new TextRun({
      text: String(item.content || ""),
      font: item.fontFamily || "Microsoft YaHei",
      size: Math.max(10, Math.round(item.fontSize * 2)),
      bold: Number(item.fontWeight) >= 600
    }));
    previous = item;
  });
  return runs;
}

async function buildResumeWordBlob(revisionSource, jobId = currentJobId) {
  if (!window.docx) throw new Error("Word 导出组件尚未加载，请刷新页面后重试。");
  const resume = state.resumes[jobId];
  if (!resume) throw new Error("未找到当前简历。");
  const revisions = latestAcceptedRevisions(revisionSource);
  const { Document, Packer, Paragraph, TextRun, PageBreak } = window.docx;
  const sourceElements = asArray(resume.pdfTextElements);
  const children = [];

  if (sourceElements.length) {
    const revisedElements = applyRevisionsToWordElements(sourceElements, revisions);
    const pages = groupWordElementsIntoLines(revisedElements);
    pages.forEach((page, pageIndex) => {
      if (pageIndex > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
      let previousBottom = 0;
      page.lines.forEach(line => {
        const maxFontSize = Math.max(...line.items.map(item => item.fontSize || 10));
        const firstX = Math.max(0, Math.min(...line.items.map(item => item.x || 0)));
        const before = Math.max(0, line.y - previousBottom);
        children.push(new Paragraph({
          children: wordRunsForLine(line, TextRun),
          indent: { left: Math.round(firstX * 20) },
          spacing: { before: Math.round(before * 20), after: 0 }
        }));
        previousBottom = line.y + maxFontSize * 1.15;
      });
    });
  } else {
    let text = String(resume.extractedText || "");
    revisions.forEach(revision => {
      if (revision.original) text = text.replace(revision.original, revision.revised);
    });
    text.split(/\n+/).filter(line => line.trim() && !/^--- 第 \d+ 页 ---$/.test(line.trim())).forEach(line => {
      children.push(new Paragraph({ children: [new TextRun({ text: line.trim(), font: "Microsoft YaHei", size: 21 })], spacing: { after: 120 } }));
    });
  }

  const firstPage = asArray(resume.pdfPages)[0] || { width: 595.28, height: 841.89 };
  const document = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: Math.round(firstPage.width * 20), height: Math.round(firstPage.height * 20) },
          margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 }
        }
      },
      children
    }]
  });
  return Packer.toBlob(document);
}

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName.replace(/[\\/:*?"<>|]/g, "-");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportResumePdf(event) {
  const button = event?.currentTarget || document.querySelector("[data-export-resume-pdf]");
  const originalHtml = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = "正在生成...";
  }
  try {
    const revisions = state.revisions[currentJobId] || [];
    const blob = await buildResumePdfBlob(revisions);
    const job = getCurrentJob();
    triggerBlobDownload(blob, `${job.company}-${job.title}-岗位定制简历.pdf`);
  } catch (error) {
    alert(error.message || "PDF 简历生成失败，请重试。");
  } finally {
    if (button && document.body.contains(button)) {
      button.disabled = false;
      button.innerHTML = originalHtml;
      window.lucide?.createIcons();
    }
  }
}

async function downloadResumeVersion(versionId, button) {
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add("loading");
  try {
    const resume = state.resumes[currentJobId];
    if (versionId === "original") {
      const originalBlob = await getResumeBlob(currentJobId);
      if (!originalBlob) throw new Error("原 PDF 文件未保存在当前浏览器，请重新上传。");
      triggerBlobDownload(originalBlob, resume?.name || "原始简历.pdf");
      return;
    }

    const versions = state.resumeVersions[currentJobId] || [];
    const version = versions.find(item => item.id === versionId);
    if (!version) throw new Error("未找到该简历版本。");
    let blob = await getResumeVersionBlob(currentJobId, versionId);
    if (!blob) {
      const revisions = (state.revisions[currentJobId] || []).slice(0, version.revisionCount || versions.indexOf(version) + 1);
      blob = await buildResumePdfBlob(revisions);
      await saveResumeVersionBlob(currentJobId, versionId, blob);
    }
    triggerBlobDownload(blob, version.fileName || "岗位优化版.pdf");
  } catch (error) {
    alert(error.message || "简历版本下载失败，请重试。");
  } finally {
    if (document.body.contains(button)) {
      button.disabled = false;
      button.classList.remove("loading");
      button.innerHTML = originalHtml;
      window.lucide?.createIcons();
    }
  }
}

async function runJdReview() {
  const job = getCurrentJob();
  await runAiAction("runJdReviewBtn", "分析中...", async () => {
    const result = await postAi("jd-review", { jd: job.jd, jobTitle: job.title, company: job.company });
    state.jdReviews[currentJobId] = result.data;
    delete state.jdMatches[currentJobId];
    delete state.jobDirections[currentJobId];
    job.updatedAt = new Date().toISOString();
    activeJdSection = "insight";
    saveState();
  });
}

async function runJdMatch() {
  const job = getCurrentJob();
  const resume = state.resumes[currentJobId];
  if (!resume) return;
  await runAiAction("runJdMatchBtn", "匹配分析中...", async () => {
    const context = { jd: job.jd, jdReview: state.jdReviews[currentJobId], resume: resume.extractedText };
    const matchResult = await postAi("jd-match", context);
    const directionResult = await postAi("jd-directions", { ...context, matchResult: matchResult.data });
    state.jdMatches[currentJobId] = matchResult.data;
    state.jobDirections[currentJobId] = directionResult.data;
    activeJdSection = "match";
    saveState();
  });
}

async function runResumeReview() {
  const job = getCurrentJob();
  const resume = state.resumes[currentJobId];
  if (!resume) { showUploadError("请先上传简历。"); return; }
  await runAiAction("runResumeReviewBtn", "批注中...", async () => {
    const result = await postAi("resume-review", { jd: job.jd, jdReview: state.jdReviews[currentJobId], resume: resume.extractedText });
    result.data.createdAt = new Date().toISOString();
    result.data.drafts ||= {};
    state.resumeReviews[currentJobId] ||= [];
    state.resumeReviews[currentJobId].push(result.data);
    activeResumeReviewIndex = null;
    saveState();
  });
}

function toggleSuggestion(index) {
  const review = getLatestResumeReview();
  const issue = asArray(review.paragraphIssues || review.suggestions)[index];
  issue.workflowStatus = issue.workflowStatus === "ignored" ? "pending" : "ignored";
  expandedResolvedComments.delete(getResolvedCommentKey(index));
  saveState();
  render();
}

function toggleSuggestionComplete(index) {
  const review = getLatestResumeReview();
  const issue = asArray(review.paragraphIssues || review.suggestions)[index];
  issue.workflowStatus = ["completed", "saved"].includes(issue.workflowStatus) ? "pending" : "completed";
  expandedResolvedComments.delete(getResolvedCommentKey(index));
  saveState();
  render();
}

function toggleResolvedComment(index) {
  const key = getResolvedCommentKey(index);
  expandedResolvedComments.has(key) ? expandedResolvedComments.delete(key) : expandedResolvedComments.add(key);
  render();
}

function selectReviewComment(index, focusTarget = "comment") {
  activeReviewCommentIndex = index;
  document.querySelectorAll("[data-comment-index]").forEach(item => item.classList.toggle("active", Number(item.dataset.commentIndex) === index));
  document.querySelectorAll("[data-highlight-index]").forEach(item => item.classList.toggle("active", Number(item.dataset.highlightIndex) === index));
  const comment = document.getElementById(`review-comment-${index}`);
  const highlight = document.querySelector(`[data-highlight-index="${index}"]`);
  if (focusTarget === "pdf" && highlight) highlight.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  else comment?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function appendPrompt(title, hint) {
  const editor = $("#supplementEditor");
  const freeform = $("#supplementFreeform");
  if (!editor || !freeform) return;
  const number = editor.querySelectorAll("[data-supplement-entry]").length + 1;
  freeform.insertAdjacentHTML("beforebegin", renderSupplementEntry({ title, hint, answer: "" }, number));
  const entry = freeform.previousElementSibling;
  entry.querySelector(".supplement-answer")?.addEventListener("input", syncSupplementInput);
  entry.querySelector("[data-remove-supplement-entry]")?.addEventListener("click", event => removeSupplementEntry(event.currentTarget));
  syncSupplementInput();
  entry.querySelector(".supplement-answer")?.focus();
}

function removeSupplementEntry(button) {
  const entry = button.closest("[data-supplement-entry]");
  const nextFocus = entry?.nextElementSibling?.matches("[data-supplement-entry]")
    ? entry.nextElementSibling.querySelector(".supplement-answer")
    : entry?.previousElementSibling?.matches("[data-supplement-entry]")
      ? entry.previousElementSibling.querySelector(".supplement-answer")
      : $("#supplementFreeform");
  entry?.remove();
  renumberSupplementEntries();
  syncSupplementInput();
  nextFocus?.focus();
}

function renumberSupplementEntries() {
  document.querySelectorAll("[data-supplement-entry]").forEach((entry, index) => {
    const order = entry.querySelector(".supplement-order");
    if (order) order.textContent = index + 1;
  });
}

function collectSupplementEditor() {
  const entries = [...document.querySelectorAll("[data-supplement-entry]")].map(entry => ({
    title: entry.dataset.title || "",
    hint: entry.dataset.hint || getSupplementPromptHint(entry.dataset.title),
    answer: entry.querySelector(".supplement-answer")?.textContent.trim() || ""
  }));
  const freeform = $("#supplementFreeform")?.textContent.trim() || "";
  const lines = entries.map((entry, index) => `${index + 1}、${entry.title}（${entry.hint}）：\n${entry.answer}`);
  if (freeform) lines.push(freeform);
  return { entries, freeform, text: lines.join("\n\n") };
}

function syncSupplementInput() {
  const input = $("#supplementInput");
  if (input) input.value = collectSupplementEditor().text;
}

function cancelPolish() {
  const review = getLatestResumeReview();
  if (review?.drafts) delete review.drafts[activeSuggestionIndex];
  saveState();
  render();
}

async function polishSuggestion(regenerate) {
  const review = getLatestResumeReview();
  const issue = asArray(review.paragraphIssues || review.suggestions)[activeSuggestionIndex];
  syncSupplementInput();
  const supplement = $("#supplementInput").value.trim();
  const supplementEditor = collectSupplementEditor();
  await runAiAction(regenerate ? "repolishBtn" : "polishResumeBtn", "优化中...", async () => {
    const result = await postAi("resume-polish", { job: getCurrentJob(), jdReview: state.jdReviews[currentJobId], issue, supplement, previousDraft: $("#finalResumeText")?.value || "" });
    review.drafts ||= {};
    review.drafts[activeSuggestionIndex] = { supplement, supplementEntries: supplementEditor.entries, supplementFreeform: supplementEditor.freeform, polished: result.data.revised || result.data.answer || "", reason: result.data.reason || "基于用户补充的真实信息优化表达。" };
    saveState();
  });
}

async function saveResumeVersion() {
  const content = $("#finalResumeText").value.trim();
  if (!content) return;
  const review = getLatestResumeReview();
  const issues = asArray(review.paragraphIssues || review.suggestions);
  const issue = issues[activeSuggestionIndex];
  const reason = review.drafts?.[activeSuggestionIndex]?.reason || "用户确认采用 AI 优化表达。";
  const jobId = currentJobId;
  const job = getCurrentJob();
  const versionId = crypto.randomUUID();
  issue.workflowStatus = "completed";
  issue.manualDraft = content;
  state.revisions[jobId] ||= [];
  state.revisions[jobId].push({ original: issue.original || "", revised: content, reason, pageHint: issue.pageHint || null, relatedCapability: issue.relatedCapability || getIssueOptimizationType(issue), reviewIndex: activeResumeReviewIndex, createdAt: new Date().toISOString() });
  state.resumeVersions[jobId] ||= [];
  const versionNumber = state.resumeVersions[jobId].length + 1;
  const version = {
    id: versionId,
    label: issue.relatedCapability || getIssueOptimizationType(issue),
    fileName: `${job.company}-${job.title}-岗位优化版-v1.${versionNumber}.pdf`,
    original: issue.original || "",
    content,
    reason,
    revisionCount: state.revisions[jobId].length,
    createdAt: new Date().toISOString()
  };
  state.resumeVersions[jobId].push(version);
  saveState();
  activeSuggestionIndex = null;
  render();
  if (state.resumes[jobId]?.type === "application/pdf") {
    try {
      const snapshot = await buildResumePdfBlob(state.revisions[jobId].slice(0, version.revisionCount), jobId);
      await saveResumeVersionBlob(jobId, versionId, snapshot);
    } catch {
      // The version can be rebuilt from its revision snapshot when the user downloads it.
    }
  }
}

async function runAiAction(buttonId, loadingText, action) {
  const button = $(`#${buttonId}`);
  const original = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = loadingText; }
  try {
    await action();
    render();
  } catch (error) {
    if (button) { button.disabled = false; button.innerHTML = original; window.lucide?.createIcons(); }
    alert(error.message || "请求失败，请重试。");
  }
}

async function postAi(kind, payload) {
  const response = await fetch(`/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) throw new Error(json.error || "AI 请求失败，请稍后重试。");
  aiRuntimeStatus = json.mocked
    ? { state: "mock", label: "本次使用模拟结果", detail: "尚未配置 DeepSeek API Key" }
    : { state: "live", label: "DeepSeek 实时响应", detail: "本次结果来自真实 API" };
  return json;
}

function getLatestResumeReview() {
  const reviews = state.resumeReviews[currentJobId] || [];
  if (Number.isInteger(activeResumeReviewIndex) && reviews[activeResumeReviewIndex]) return reviews[activeResumeReviewIndex];
  return reviews.at(-1) || null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") return value.split(/[;；\n]/).map(item => item.trim()).filter(Boolean);
  if (typeof value === "object") return Object.values(value).flatMap(asArray);
  return [String(value)];
}

function getJdCapabilities(review) {
  const raw = review.coreCapabilities || review.capabilityRequirements || review.capabilities || review.capabilityProfile || review.abilityProfile || review.jobCapabilities || review.skills || [];
  const normalize = item => typeof item === "string" ? { name: item, priority: "P1", description: "" } : { name: item.name || item.capability || item.ability || item.title || "岗位能力", priority: item.priority || item.importance || item.weight || item.score || "P1", description: item.description || item.meaning || item.whyImportant || item.importanceReason || "", skills: asArray(item.relatedSkills || item.skills || item.subSkills || item.specificSkills), typicalTasks: asArray(item.typicalTasks || item.tasks || item.workScenarios) };
  if (Array.isArray(raw)) return raw.map(normalize).sort((a, b) => capabilityPriorityRank(a) - capabilityPriorityRank(b)).slice(0, 5);
  if (raw && typeof raw === "object") return Object.entries(raw).map(([name, value]) => normalize({ name, ...(typeof value === "object" ? value : { relatedSkills: value }) })).sort((a, b) => capabilityPriorityRank(a) - capabilityPriorityRank(b)).slice(0, 5);
  return [];
}

function getSkillKeywords(review, capabilities) {
  const raw = review.skillKeywords || review.skill_keywords || {};
  const groups = { P0: [], P1: [], P2: [] };
  if (Array.isArray(raw)) raw.forEach(group => { const priority = normalizeCapabilityPriority(group); groups[priority].push(...asArray(group.keywords || group.skills || group.items)); });
  else if (raw && typeof raw === "object") {
    groups.P0.push(...asArray(raw.P0 || raw.p0 || raw.roleCompetencies || raw.competencies));
    groups.P1.push(...asArray(raw.P1 || raw.p1 || raw.technicalSkills || raw.technical || raw.toolSkills || raw.tools));
    groups.P2.push(...asArray(raw.P2 || raw.p2 || raw.industryKeywords || raw.industry));
  }
  if (!Object.values(groups).some(items => items.length)) groups.P1.push(...capabilities.flatMap(item => item.skills || []));
  const seen = new Set();
  let count = 0;
  Object.keys(groups).forEach(priority => { groups[priority] = groups[priority].filter(item => { const key = String(item).trim().toLowerCase(); if (!key || seen.has(key) || count >= 8) return false; seen.add(key); count += 1; return true; }); });
  return groups;
}

function getResponsibilityBreakdown(review, capabilities) {
  const raw = asArray(review.responsibilityBreakdown || review.responsibilities || review.dutyBreakdown);
  if (raw.length) return raw.map(item => typeof item === "string" ? { responsibility: item, correspondingAbilities: [], workGoal: "" } : item);
  return capabilities.flatMap(item => (item.typicalTasks || []).map(task => ({ responsibility: task, correspondingAbilities: [item.name], workGoal: item.meaning || item.whyImportant || "", basis: item.basis || "" })));
}

function getJdConclusion(review, capabilities, responsibilities) {
  if (typeof review.conclusion === "string") return review.conclusion.trim();
  const takeaways = getJdTakeaways(review, capabilities, responsibilities);
  const capabilityText = takeaways.mostValuedCapabilities.slice(0, 3).join("、") || capabilities.slice(0, 3).map(item => item.name).join("、");
  const responsibilityText = takeaways.mainResponsibilities.slice(0, 2).join("、") || responsibilities.slice(0, 2).map(item => item.responsibility).join("、");
  return `该岗位核心关注${capabilityText || "岗位相关专业能力"}。候选人应重点展示${responsibilityText || "与岗位职责相关"}的经历，并准备能够证明这些能力的具体项目。`;
}

function getJdTakeaways(review, capabilities, responsibilities) {
  const raw = review.keyTakeaways || review.key_takeaways || {};
  const legacyInsight = normalizeDemandInsight(review.demandInsight || review.demand_insight || {});
  const legacyPriorities = legacyInsight.whatTheyReallyCareAbout.length ? legacyInsight.whatTheyReallyCareAbout : capabilities.filter(item => normalizeCapabilityPriority(item) === "P0").map(item => item.name);
  return {
    mainResponsibilities: asArray(raw.mainResponsibilities || raw.responsibilities || responsibilities.map(item => item.responsibility || item.duty || item.task).filter(Boolean)),
    mostValuedCapabilities: asArray(raw.mostValuedCapabilities || raw.valuedCapabilities || legacyPriorities),
    requiredSkillsAndExperience: asArray(raw.requiredSkillsAndExperience || raw.skillsAndExperience || capabilities.flatMap(item => item.skills || []))
  };
}

function normalizeCapabilityPriority(item) {
  const value = String(item.priority || item.importance || "").toLowerCase();
  if (["p0", "core", "核心能力", "核心"].includes(value) || Number(value) >= 5) return "P0";
  if (["p2", "bonus", "加分能力", "加分"].includes(value) || (Number(value) > 0 && Number(value) <= 2)) return "P2";
  return "P1";
}

function capabilityPriorityRank(item) {
  return { P0: 0, P1: 1, P2: 2 }[normalizeCapabilityPriority(item)];
}

function normalizeDemandInsight(value) {
  if (typeof value === "string") return { coreHiringLogic: value, whatTheyReallyCareAbout: [] };
  return { coreHiringLogic: value?.coreHiringLogic || value?.logic || value?.summary || "", whatTheyReallyCareAbout: asArray(value?.whatTheyReallyCareAbout || value?.careAbout || value?.keyPoints) };
}

function normalizeMatchScore(match) {
  const raw = match.matchScore || match.scoreBreakdown || {};
  const overall = clampScore(raw.overall ?? raw.total ?? match.fitScore ?? match.overallMatch ?? 0);
  const dimensions = Array.isArray(raw.dimensions) ? raw.dimensions : asArray(match.matchFactors || match.dimensions);
  const normalized = dimensions.map((item, index) => typeof item === "string" ? { name: item, score: overall, basis: "" } : { name: item.name || item.dimension || ["能力匹配", "经历匹配", "技能匹配"][index] || "匹配因素", score: clampScore(item.score ?? item.value ?? overall), basis: item.basis || item.reason || item.explanation || "" });
  if (!normalized.length) ["能力匹配", "经历匹配", "技能匹配"].forEach(name => normalized.push({ name, score: overall, basis: "旧版匹配记录未拆分该维度依据，重新匹配后可查看。" }));
  return { overall, dimensions: normalized.slice(0, 3) };
}

function normalizeMatchStrengths(match) {
  const raw = Array.isArray(match.matchedStrengths) ? match.matchedStrengths : asArray(match.matched || match.strengths);
  return raw.map(item => typeof item === "string" ? { requirement: "已匹配岗位要求", matchReason: item } : { requirement: item.requirement || item.jobRequirement || item.title || "已匹配岗位要求", matchReason: item.matchReason || item.reason || item.basis || item.description || "" });
}

function normalizeMatchGaps(match) {
  const raw = Array.isArray(match.gaps) ? match.gaps : asArray(match.missing || match.abilityGaps);
  return raw.map(item => typeof item === "string"
    ? { gap: "关键能力证据不足", gapReason: item, priority: "P1" }
    : {
        gap: cleanGapName(item.gap || item.missingCapability || item.capability || item.title || item.requirement || "关键能力证据不足"),
        gapReason: item.gapReason || item.reason || item.basis || item.description || "",
        priority: item.priority || item.importance || "P1"
      })
    .sort((a, b) => capabilityPriorityRank(a) - capabilityPriorityRank(b));
}

function normalizeCompetitionImprovements(value) {
  const raw = Array.isArray(value) ? value : asArray(value?.improvements || value?.optimizationDirections || value?.directions || value?.items);
  return raw.map(item => typeof item === "string"
    ? { problem: "岗位竞争力仍需提升", explanation: "当前经历对该项能力的证明仍不充分。", direction: item, priority: "P1" }
    : {
        problem: item.problem || item.issue || item.title || "岗位竞争力仍需提升",
        explanation: item.explanation || item.description || item.basis || item.reason || "",
        direction: item.direction || item.detail || item.action || item.suggestion || "",
        priority: item.priority || item.importance || "P1"
      })
    .filter(item => item.problem && item.direction)
    .sort((a, b) => capabilityPriorityRank(a) - capabilityPriorityRank(b));
}

function cleanGapName(value) {
  return String(value || "")
    .replace(/^\s*(?:缺少|欠缺|未充分满足)\s*[:：]?\s*/i, "")
    .replace(/\s*[（(][^（）()]*[）)]\s*$/g, "")
    .trim() || "关键能力证据不足";
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function normalizeImportance(value) {
  return Math.max(1, Math.min(5, Number(String(value).match(/\d+/)?.[0] || 3)));
}

function statusClass(status) {
  return { "待投递": "pending", "已投递": "submitted", "面试中": "interview", "已Offer": "offer", "Offer": "offer", "未通过": "rejected" }[status] || "pending";
}

function getCurrentJob() {
  return state.jobs.find(job => job.id === currentJobId);
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

render();
refreshAiRuntimeStatus();
