import { qrDataUrl } from "./qr-code.js";

const REFRESH_MS = 5000;
const RELEASES_URL = "https://github.com/GavinYangAI/Comote/releases";

async function getJson(path, options = {}) {
  const token = localStorage.getItem("comoteApiToken");
  const headers = {
    ...(options.headers ?? {}),
    ...(token ? { "x-comote-token": token } : {}),
  };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

// Resolves to { ok, value, error } so one failing endpoint never blanks the UI.
async function safeGet(path, fallback) {
  try {
    return { ok: true, value: await getJson(path) };
  } catch (error) {
    return { ok: false, value: fallback, error };
  }
}

let activeWechatLoginId = null;
let activeWechatQrUrl = null;
let wechatLoginPollTimer = null;
let activeFeishuLogin = null;
let feishuLoginPollTimer = null;
let refreshTimer = null;
let rendering = false;
let logsOffset = 0;
let logsVisibleLimit = 5;
let logsRefreshEpoch = 0;
let phoneThreadIds = new Set();
let phoneOnly = false;
// threadId -> "feishu" | "wechat"; drives the channel filter chips.
let threadChannels = new Map();
let channelFilter = null; // null = all phone channels
let codexProjects = [];
let selectedProjectPath = null;
let desktopConnected = false;

function getTauriInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
}

// Inside the Tauri webview, <a target="_blank"> to an external site is a no-op,
// so route outbound http(s) links through the system browser. Outside Tauri
// (e.g. the phone hitting the daemon page directly) we leave links untouched.
document.addEventListener("click", (event) => {
  const anchor = event.target.closest?.("a[href]");
  if (!anchor) {
    return;
  }
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href) || href.startsWith("http://127.0.0.1:16208")) {
    return;
  }
  const invoke = getTauriInvoke();
  if (!invoke) {
    return;
  }
  event.preventDefault();
  invoke("open_external", { url: href }).catch(() => {});
});

async function render() {
  if (rendering) {
    return;
  }
  rendering = true;
  try {
    await renderOnce();
  } finally {
    rendering = false;
  }
}

async function renderOnce() {
  const logsLimit = Math.max(logsVisibleLimit, 5);
  const logsRequestEpoch = logsRefreshEpoch;
  const [
    status,
    identities,
    candidates,
    projects,
    wechatStatus,
    wechatConfig,
    wechatRuntime,
    feishuStatus,
    feishuConfig,
    feishuRuntime,
    approvals,
    logs,
  ] = await Promise.all([
    safeGet("/api/status", null),
    safeGet("/api/identities", []),
    safeGet("/api/identities/candidates", []),
    safeGet("/api/projects", []),
    safeGet("/api/channels/wechat/status", {}),
    safeGet("/api/channels/wechat/config", {}),
    safeGet("/api/channels/wechat/runtime", { state: "not_configured" }),
    safeGet("/api/channels/feishu/status", {}),
    safeGet("/api/channels/feishu/config", {}),
    safeGet("/api/channels/feishu/runtime", { state: "not_configured" }),
    safeGet("/api/approvals", []),
    safeGet(`/api/logs?limit=${logsLimit}&offset=0`, { entries: [], total: 0, hasMore: false }),
  ]);
  const [phoneThreads] = await Promise.all([
    safeGet("/api/codex/phone-threads", []),
  ]);
  const phoneThreadList = phoneThreads.ok ? phoneThreads.value ?? [] : [];
  // Tolerates both the new [{threadId, channel}] shape and the old [threadId].
  phoneThreadIds = new Set(phoneThreadList.map((entry) => String(entry?.threadId ?? entry)));
  threadChannels = new Map(
    phoneThreadList
      .filter((entry) => entry && typeof entry === "object" && entry.channel)
      .map((entry) => [String(entry.threadId), entry.channel]),
  );

  // The daemon being unreachable (or token-gated) is the one failure that
  // genuinely blocks everything — surface it explicitly instead of silently.
  if (!status.ok) {
    showLoadError(status.error);
    setBridgeStatus(status.error?.status === 401 ? "需要授权" : "离线");
    return;
  }
  hideLoadError();
  setBridgeStatus(status.value.bridge === "running" ? "就绪" : "启动中");

  renderCodexNotice(status.value.connectors.desktop.state);
  // Hide the retry button when there is nothing to retry.
  document.querySelector("#connectDesktop").hidden = status.value.connectors.desktop.state === "connected";
  document.querySelector("#connections").innerHTML = [
    ["Codex Desktop", humanConnectorState(status.value.connectors.desktop.state)],
    ["手机命令", status.value.connectors.desktop.state === "connected" ? "可用" : "等待 Codex Desktop"],
    ["Codex CLI 备用", status.value.connectors.cli.state === "available" ? "可用" : "不可用"],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");

  renderReadiness(status.value, wechatConfig, feishuConfig, identities, wechatRuntime, feishuRuntime);
  renderIdentities(identities);
  renderCandidates(candidates);
  renderProjects(projects);
  renderWechat(wechatStatus, wechatConfig, wechatRuntime);
  renderFeishu(feishuStatus, feishuConfig, feishuRuntime);
  renderApprovals(approvals);
  renderLogs(logs, logsLimit, logsRequestEpoch);
  await renderThreads(status.value);
}

function renderReadiness(status, wechatConfigResult, feishuConfigResult, identitiesResult, wechatRuntimeResult, feishuRuntimeResult) {
  const section = document.querySelector("#readiness");
  const list = document.querySelector("#readinessList");
  const wechatConfig = wechatConfigResult.value ?? {};
  const feishuConfig = feishuConfigResult.value ?? {};
  const identities = identitiesResult.ok ? identitiesResult.value : [];
  const wechatRuntime = wechatRuntimeResult.value ?? {};
  const feishuRuntime = feishuRuntimeResult.value ?? {};
  const desktopState = status?.connectors?.desktop?.state;

  const items = [
    {
      done: desktopState === "connected" || desktopState === "available",
      label: "连接 Codex Desktop",
      hint: "打开 Codex Desktop 后会自动连接。",
    },
    {
      done: Boolean(wechatConfig.loggedIn || feishuConfig.configured),
      label: "绑定一个手机通道",
      hint: "在下方「连接手机」绑定微信或飞书。",
    },
    {
      done: identities.length > 0,
      label: "确认一个授权用户",
      hint: "手机首次发消息后，在「授权用户」里确认。",
    },
    {
      done: wechatRuntime.state === "running" || feishuRuntime.state === "running",
      label: "通道开始监听",
      hint: "绑定完成后通道会自动监听。",
    },
  ];
  // Hide the whole section once setup is complete — no clutter for return users.
  section.hidden = items.every((item) => item.done);

  // SVG icons for each step
  const stepIcons = [
    // Step 1: Desktop connection
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>`,
    // Step 2: Bind channel (phone icon)
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`,
    // Step 3: Authorize user (person icon)
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>`,
    // Step 4: Start listening (arrow icon)
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
  ];

  list.innerHTML = items
    .map(
      (item, index) =>
        `<li class="ready-item ${item.done ? "done" : "todo"}">
          <div class="ready-top">
            <div class="ready-mark" aria-hidden="true">${stepIcons[index]}</div>
            <span class="ready-state ${item.done ? "done" : "todo"}">${item.done ? "已完成" : "待办"}</span>
          </div>
          <div>
            <div class="ready-step-no">第 ${index + 1} 步</div>
            <strong>${escapeHtml(item.label)}</strong>
          </div>
        </li>`,
    )
    .join("");
}

function renderIdentities(result) {
  const target = document.querySelector("#identities");
  if (!result.ok) {
    target.innerHTML = sectionError("无法加载已授权用户");
    return;
  }
  const identities = result.value;
  target.innerHTML =
    identities.length === 0
      ? `<li class="empty-state-row"><strong>暂无已授权用户</strong><div class="meta">绑定微信或飞书后，在这里确认可控制 Comote 的账号。</div></li>`
      : identities
          .map(
            (identity) =>
              `<li class="list-row identity-row">
                <span class="identity-row-main">
                  <span class="identity-row-title">
                    <strong>${escapeHtml(identity.displayName)}</strong>
                    <span class="identity-channel">${channelName(identity.channel)} · ${roleName(identity.role)}</span>
                  </span>
                  <span class="identity-stable-id">${escapeHtml(identity.stableId)}</span>
                </span>
                <span class="identity-row-action">
                  <button class="secondary-button" data-remove-identity="${escapeAttr(identity.channel)}|${escapeAttr(identity.stableId)}">移除</button>
                </span>
              </li>`,
          )
          .join("");
}

function renderCandidates(result) {
  const target = document.querySelector("#identityCandidates");
  if (!result.ok) {
    target.innerHTML = sectionError("无法加载待确认用户");
    return;
  }
  const candidates = result.value;
  target.innerHTML =
    candidates.length === 0
      ? `<li class="empty-state-row"><strong>暂无待确认用户</strong><div class="meta">手机端首次发消息后，会出现在这里等待本机确认。</div></li>`
      : candidates
          .map(
            (identity) =>
              `<li class="list-row identity-row">
                <span class="identity-row-main">
                  <span class="identity-row-title">
                    <strong>${escapeHtml(identity.displayName)}</strong>
                    <span class="identity-channel">${channelName(identity.channel)}</span>
                  </span>
                  <span class="identity-stable-id">${escapeHtml(identity.stableId)}</span>
                </span>
                <span class="identity-row-action">
                  <button data-confirm-identity="${escapeAttr(identity.channel)}|${escapeAttr(identity.stableId)}|${escapeAttr(identity.displayName)}">确认</button>
                </span>
              </li>`,
          )
          .join("");
}

function renderProjects(result) {
  const picker = document.querySelector("#conversationProjectPicker");
  codexProjects = result.ok && Array.isArray(result.value) ? result.value : [];

  if (codexProjects.length === 0) {
    picker.hidden = true;
    selectedProjectPath = null;
    updateProjectComboLabel();
    return;
  }

  // Keep the prior selection if it still exists; otherwise default to the first project.
  const stillExists = codexProjects.some((p) => p.path === selectedProjectPath);
  if (!stillExists) {
    selectedProjectPath = codexProjects[0].path;
  }

  picker.hidden = false;
  updateProjectComboLabel();
  paintProjectComboList("");
}

function updateProjectComboLabel() {
  const label = document.querySelector("#projectComboLabel");
  const project = selectedProject();
  label.textContent = project ? project.name : "选择项目";
}

function paintProjectComboList(query) {
  const list = document.querySelector("#projectComboList");
  const needle = query.trim().toLowerCase();
  const matches = codexProjects.filter(
    (p) => p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    list.innerHTML = `<li class="project-combo-empty">无匹配项目</li>`;
    return;
  }
  list.innerHTML = matches
    .map(
      (project) =>
        `<li class="project-combo-option${project.path === selectedProjectPath ? " selected" : ""}" role="option" data-path="${escapeAttr(project.path)}" aria-selected="${project.path === selectedProjectPath}"><span class="project-combo-name">${escapeHtml(project.name)}</span><span class="project-combo-path">${escapeHtml(project.path)}</span></li>`,
    )
    .join("");
}

function selectedProject() {
  return codexProjects.find((p) => p.path === selectedProjectPath) ?? codexProjects[0] ?? null;
}

function renderWechat(statusResult, configResult, runtimeResult) {
  const wechatConfig = configResult.value ?? {};
  const wechatRuntime = runtimeResult.value ?? { state: "not_configured" };
  const wechatStatus = statusResult.value ?? {};
  const needsRelogin = Boolean(wechatRuntime.needsRelogin);
  const badge = document.querySelector("#wechatBadge");
  badge.textContent = needsRelogin ? "需重新绑定" : wechatConfig.loggedIn ? "已绑定" : "未绑定";
  badge.className = `badge${needsRelogin ? " warning" : wechatConfig.loggedIn ? " success" : ""}`;
  document.querySelector("#wechatStatus").innerHTML = [
    ["状态", needsRelogin ? "登录已失效" : wechatConfig.loggedIn ? "已绑定" : "未绑定"],
    ["监听", needsRelogin ? "已掉线，请重新绑定微信" : humanRuntimeState(wechatRuntime.state)],
    ["允许账号", wechatConfig.linkedUserName ?? wechatConfig.linkedUserId ?? "等待扫码"],
    ["宿主应用", wechatStatus.externalAgentHostRequired ? "需要" : "不需要"],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  const wechatBindButton = document.querySelector("#startWechatLogin");
  // While a rebind is in flight (activeWechatLoginId set), keep the QR visible
  // even though the daemon still reports the old loggedIn=true config.
  wechatBindButton.textContent = activeWechatLoginId
    ? "刷新二维码"
    : wechatConfig.loggedIn
      ? "重新绑定微信"
      : "绑定微信";
  if (!activeWechatLoginId) {
    setWechatLoginView(
      wechatConfig.loggedIn
        ? { state: "bound", accountId: wechatConfig.accountId, userId: wechatConfig.linkedUserId, userName: wechatConfig.linkedUserName }
        : { state: "empty" },
    );
  }

  const wechatForm = document.querySelector("#wechatConfigForm");
  wechatForm.elements.enabled.checked = Boolean(wechatConfig.enabled);
  wechatForm.elements.accountId.value = wechatConfig.accountId ?? "default";
}

function renderFeishu(statusResult, configResult, runtimeResult) {
  const feishuConfig = configResult.value ?? {};
  const feishuRuntime = runtimeResult.value ?? { state: "not_configured" };
  const needsRelogin = Boolean(feishuRuntime.needsRelogin);
  const feishuReady = feishuRuntime.state === "running" || feishuRuntime.state === "configured";
  const badge = document.querySelector("#feishuBadge");
  badge.textContent = needsRelogin ? "需重新绑定" : humanFeishuBadge(feishuRuntime.state);
  badge.className = `badge${feishuReady && !needsRelogin ? " success" : " warning"}`;
  document.querySelector("#feishuStatus").innerHTML = [
    ["状态", needsRelogin ? "登录已失效" : humanFeishuState(feishuRuntime.state)],
    ["连接", needsRelogin ? "请重新绑定飞书" : feishuRuntime.state === "running" ? "WebSocket 监听中" : feishuConfig.configured ? "已配置" : "待扫码"],
    ["允许账号", feishuConfig.linkedUserName ?? feishuConfig.linkedUserId ?? "等待确认"],
    ["应用", needsRelogin ? feishuRuntime.lastError ?? "凭证不可用" : feishuConfig.appId ?? "未设置"],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  const feishuForm = document.querySelector("#feishuConfigForm");
  feishuForm.elements.domain.value = feishuConfig.domain ?? "feishu";
  const feishuBindButton = document.querySelector("#startFeishuLogin");
  feishuBindButton.textContent = feishuConfig.configured ? "重新绑定飞书" : activeFeishuLogin ? "刷新二维码" : "绑定飞书";
  if (!activeFeishuLogin) {
    setFeishuLoginView(
      feishuConfig.configured
        ? { state: "bound", appId: feishuConfig.appId, userId: feishuConfig.linkedUserId, userName: feishuConfig.linkedUserName }
        : { state: "empty" },
    );
  }
}

function renderApprovals(result) {
  const target = document.querySelector("#approvalsList");
  const badge = document.querySelector("#approvalsBadge");
  const navCount = document.querySelector("#approvalsNavCount");
  if (!result.ok) {
    target.innerHTML = sectionError("无法加载待审批操作");
    badge.textContent = "—";
    navCount.hidden = true;
    return;
  }
  const approvals = result.value;
  badge.textContent = `${approvals.length} 项待处理`;
  badge.className = `badge${approvals.length > 0 ? " warning" : " neutral"}`;
  navCount.hidden = approvals.length === 0;
  navCount.textContent = String(approvals.length);
  target.innerHTML =
    approvals.length === 0
      ? `<li><strong>暂无待审批操作</strong><div class="meta">Codex 命令和文件修改审批会显示在这里。</div></li>`
      : approvals
          .map((approval) => {
            const command = approval.params?.command ?? approval.params?.reason ?? approval.method;
            const cwd = approval.params?.cwd ?? "";
            return `<li class="list-row"><span><strong>${escapeHtml(command)}</strong><div class="meta">${escapeHtml(approval.id)}</div><div class="meta">${escapeHtml(cwd)}</div></span><span class="button-row"><button data-approval="${escapeAttr(approval.id)}|accept">批准</button><button class="secondary-button" data-approval="${escapeAttr(approval.id)}|decline">拒绝</button></span></li>`;
          })
          .join("");
}

function renderLogEntries(entries) {
  return entries
    .map((entry) => {
      const detail = entry.detail ? `<div class="meta">${escapeHtml(JSON.stringify(entry.detail))}</div>` : "";
      return `<li class="log-row log-${escapeAttr(entry.level)}"><span class="log-time">${escapeHtml(formatTime(entry.at))}</span><span><strong>${escapeHtml(entry.message)}</strong>${detail}</span></li>`;
    })
    .join("");
}

function resetLogVisibleLimit() {
  logsVisibleLimit = 5;
  logsOffset = 0;
  logsRefreshEpoch += 1;
}

function renderLogs(result, requestedLimit = 5, requestEpoch = logsRefreshEpoch) {
  const target = document.querySelector("#logList");
  if (requestEpoch !== logsRefreshEpoch) {
    return;
  }
  if (requestedLimit < logsVisibleLimit) {
    return;
  }
  if (!result.ok) {
    target.innerHTML = sectionError("无法加载运行日志");
    return;
  }
  const data = result.value;
  const entries = data.entries ?? [];
  const hasMore = data.hasMore ?? false;
  logsOffset = entries.length;
  logsVisibleLimit = Math.max(logsVisibleLimit, logsOffset, 5);
  if (entries.length === 0) {
    target.innerHTML = `<li><strong>暂无日志</strong><div class="meta">确认用户、处理命令、审批等事件会记录在这里。</div></li>`;
    return;
  }
  target.innerHTML = renderLogEntries(entries);
  if (hasMore) {
    const btn = document.createElement("li");
    btn.className = "load-more-item";
    btn.innerHTML = `<button class="secondary-button load-more-btn" id="logsLoadMore">加载更多</button>`;
    target.appendChild(btn);
  }
}



let lastThreadList = [];
let lastPaintSignature = null;
const expandedThreadStates = new Map();

async function renderThreads(status) {
  const target = document.querySelector("#threads");
  const project = selectedProject();
  desktopConnected = status.connectors.desktop.state === "connected";

  if (status.connectors.desktop.state !== "connected" || !project) {
    lastThreadList = [];
    lastPaintSignature = null;
    target.innerHTML = `<li><strong>未连接</strong><div class="meta">打开 Codex Desktop 后，这里会显示已有对话。</div></li>`;
    return;
  }
  const result = await safeGet(`/api/codex/threads?cwd=${encodeURIComponent(project.path)}`, null);
  if (!result.ok) {
    lastThreadList = [];
    lastPaintSignature = null;
    target.innerHTML = sectionError("无法加载 Codex 对话");
    return;
  }
  lastThreadList = result.value?.data ?? result.value?.threads ?? [];
  paintThreads();
  await refreshExpandedThreadDetails();
}

// A signature of what paintThreads would render. When it is unchanged we skip
// the repaint entirely so the periodic 5s refresh never wipes an expanded
// conversation (or the user's scroll position).
function threadListSignature(visible) {
  return `${phoneOnly ? "1" : "0"}:${channelFilter ?? ""}:${visible
    .map((thread) => {
      const threadId = String(thread.id ?? "");
      return `${threadId}~${phoneThreadIds.has(threadId) ? 1 : 0}~${threadChannels.get(threadId) ?? ""}`;
    })
    .join("|")}`;
}

function defaultExpandedThreadState() {
  return {
    open: false,
    html: "",
    loaded: "",
    offset: "0",
  };
}

function syncExpandedThreadState(row) {
  const threadId = row?.dataset?.threadId;
  const panel = row?.querySelector?.(".thread-detail");
  if (!threadId || !panel) {
    return;
  }
  const current = expandedThreadStates.get(threadId) ?? defaultExpandedThreadState();
  expandedThreadStates.set(threadId, {
    ...current,
    open: !panel.hidden,
    html: panel.innerHTML,
    loaded: panel.dataset.loaded ?? "",
    offset: panel.dataset.offset ?? "0",
  });
}

function syncExpandedThreadStates(target) {
  for (const row of target.querySelectorAll("li[data-thread-id]")) {
    syncExpandedThreadState(row);
  }
}

function updateThreadToggle(row, isExpanded) {
  const toggle = row?.querySelector?.(".thread-toggle-btn");
  if (!toggle) {
    return;
  }
  toggle.setAttribute("aria-expanded", String(isExpanded));
  toggle.setAttribute("aria-label", isExpanded ? "收回" : "展开");
  toggle.setAttribute("title", isExpanded ? "收回" : "展开");
}

function findThreadRow(threadId) {
  return [...document.querySelectorAll("#threads li[data-thread-id]")].find((row) => row.dataset.threadId === threadId);
}

function channelDisplayName(channel) {
  if (channel === "feishu") return "飞书";
  if (channel === "wechat") return "微信";
  return "";
}

function threadRowHtml(thread, index, fallbackCwd) {
  const threadId = String(thread.id ?? "");
  const title = thread.title ?? thread.name ?? thread.preview ?? threadId;
  const cwd = thread.cwd ?? fallbackCwd;
  const isPhone = phoneThreadIds.has(threadId);
  const channelLabel = channelDisplayName(threadChannels.get(threadId));
  const badge = isPhone
    ? `<span class="thread-badge">手机${channelLabel ? `·${channelLabel}` : ""}</span>`
    : "";
  const state = expandedThreadStates.get(threadId) ?? defaultExpandedThreadState();
  const expanded = state.open === true;
  return `<li class="thread-row${expanded ? " expanded" : ""}" data-thread-id="${escapeAttr(threadId)}"><div class="thread-row-summary"><div class="thread-row-main"><strong>${index + 1}. ${escapeHtml(title)}</strong>${badge}<div class="meta">${escapeHtml(threadId)}</div><div class="meta">${escapeHtml(cwd)}</div></div><button class="thread-toggle-btn" type="button" aria-expanded="${expanded}" aria-label="${expanded ? "收回" : "展开"}" title="${expanded ? "收回" : "展开"}"></button></div><div class="thread-detail" ${expanded ? "" : "hidden"} data-offset="${escapeAttr(state.offset)}" data-loaded="${escapeAttr(state.loaded)}">${state.html ?? ""}</div></li>`;
}

function pruneExpandedThreadStates(visible) {
  const visibleIds = new Set(visible.map((thread) => String(thread.id ?? "")));
  for (const threadId of expandedThreadStates.keys()) {
    if (!visibleIds.has(threadId)) {
      expandedThreadStates.delete(threadId);
    }
  }
}

// Repaints the cached thread list, applying the 仅手机渠道 filter. Kept separate
// from renderThreads so toggling the filter doesn't re-fetch from Codex.
function paintThreads() {
  const target = document.querySelector("#threads");
  const project = selectedProject();
  const fallbackPath = project?.path ?? "";
  const visible = phoneOnly
    ? lastThreadList.filter((thread) => {
        const threadId = String(thread.id ?? "");
        if (!phoneThreadIds.has(threadId)) {
          return false;
        }
        return !channelFilter || threadChannels.get(threadId) === channelFilter;
      })
    : lastThreadList;

  if (visible.length === 0) {
    const channelName = channelDisplayName(channelFilter);
    const label = phoneOnly
      ? channelName
        ? `没有 ${channelName} 渠道的对话。`
        : "没有经手机渠道的对话。"
      : `未找到${project ? ` ${escapeHtml(project.name)}` : ""}的对话。`;
    target.innerHTML = `<li>${label}</li>`;
    lastPaintSignature = null;
    return;
  }

  const signature = threadListSignature(visible);
  if (signature === lastPaintSignature) {
    return;
  }

  syncExpandedThreadStates(target);
  pruneExpandedThreadStates(visible);
  target.innerHTML = visible.map((thread, index) => threadRowHtml(thread, index, fallbackPath)).join("");
  lastPaintSignature = signature;
}

async function refreshExpandedThreadDetails() {
  const rows = [...document.querySelectorAll("#threads li[data-thread-id]")].filter((row) => {
    const panel = row.querySelector(".thread-detail");
    return panel && !panel.hidden && panel.dataset.loaded === "1";
  });
  await Promise.all(rows.map((row) => refreshThreadDetail(row)));
}

function setBridgeStatus(label) {
  const pill = document.querySelector("#bridgeStatus");
  pill.textContent = label;
  pill.className = `status-pill status-${
    label === "就绪" ? "ok" : label === "需要授权" ? "warn" : label === "离线" ? "error" : "pending"
  }`;
}

function showLoadError(error) {
  const panel = document.querySelector("#loadError");
  const title = document.querySelector("#loadErrorTitle");
  const detail = document.querySelector("#loadErrorDetail");
  if (error?.status === 401) {
    title.textContent = "需要本地 API token";
    detail.textContent = "daemon 设置了 COMOTE_LOCAL_API_TOKEN，当前浏览器未授权。";
  } else {
    title.textContent = "无法连接本地 daemon";
    detail.textContent = `请确认 Comote daemon 正在运行。${error?.message ?? ""}`;
  }
  panel.hidden = false;
}

function hideLoadError() {
  document.querySelector("#loadError").hidden = true;
}

function sectionError(message) {
  return `<li class="list-error"><strong>${escapeHtml(message)}</strong><div class="meta">稍后会自动重试。</div></li>`;
}


document.querySelector("#retryLoad").addEventListener("click", async () => {
  await render();
});

document.querySelector("#refreshLogs").addEventListener("click", async () => {
  resetLogVisibleLimit();
  await render();
});

document.querySelector("#identityForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await guardedAction(() =>
    getJson("/api/identities/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
  form.reset();
  await render();
});

document.querySelector("#identityCandidates").addEventListener("click", async (event) => {
  const value = event.target?.dataset?.confirmIdentity;
  if (!value) {
    return;
  }
  const [channel, stableId, displayName] = value.split("|");
  await guardedAction(() =>
    getJson("/api/identities/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, stableId, displayName }),
    }),
  );
  await render();
});

document.querySelector("#identities").addEventListener("click", async (event) => {
  const value = event.target?.dataset?.removeIdentity;
  if (!value) {
    return;
  }
  const [channel, stableId] = value.split("|");
  await guardedAction(() =>
    getJson(`/api/identities/${encodeURIComponent(channel)}/${encodeURIComponent(stableId)}`, {
      method: "DELETE",
    }),
  );
  await render();
});

async function connectCodexDesktop({ button = null } = {}) {
  if (button) {
    button.disabled = true;
    button.textContent = "连接中...";
  }
  try {
    await getJson("/api/connectors/codex-desktop/auto-connect", { method: "POST" });
  } catch {
    // auto-connect returns 503 when Codex Desktop is closed — the notice banner
    // already tells the user; no need to escalate to a hard error.
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.defaultLabel ?? "重试";
    }
  }
  await render();
}

document.querySelector("#connectDesktop").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "连接中...";
  try {
    await getJson("/api/connectors/codex-desktop/initialize", { method: "POST" });
  } catch (error) {
    window.alert(`连接 Codex Desktop 失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "重试连接 Codex Desktop";
  }
  await render();
});

document.querySelector("#retryCodexConnection").addEventListener("click", async (event) => {
  await connectCodexDesktop({ button: event.currentTarget });
});

document.querySelector("#discoverProjects").addEventListener("click", async () => {
  const button = document.querySelector("#discoverProjects");
  button.disabled = true;
  button.textContent = "刷新中...";
  try {
    await guardedAction(() => getJson("/api/projects/discover", { method: "POST" }));
    await render();
  } finally {
    button.disabled = false;
    button.textContent = "刷新";
  }
});


document.querySelector("#approvalsList").addEventListener("click", async (event) => {
  const value = event.target?.dataset?.approval;
  if (!value) {
    return;
  }
  const [id, decision] = value.split("|");
  await guardedAction(() =>
    getJson(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
  );
  await render();
});

document.querySelector("#wechatConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await guardedAction(() =>
    getJson("/api/channels/wechat/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: form.elements.enabled.checked, accountId: data.accountId || "default" }),
    }),
  );
  await render();
});

document.querySelector("#startWechatLogin").addEventListener("click", async (event) => {
  await startWechatBinding(event.currentTarget);
});

document.querySelector("#startFeishuLogin").addEventListener("click", async (event) => {
  await startFeishuBinding(event.currentTarget);
});

async function loadDockIconPreference() {
  const showDockIconToggle = document.querySelector("#showDockIcon");
  const status = document.querySelector("#dockIconSettingStatus");
  if (!showDockIconToggle || !status) {
    return;
  }
  const invoke = getTauriInvoke();
  if (!invoke) {
    showDockIconToggle.disabled = true;
    status.textContent = "仅 Comote 桌面端可用";
    return;
  }
  // The Dock icon is a macOS-only concept; hide the whole row elsewhere
  // (Windows has no Dock). The keep-alive toggle in the same card stays.
  try {
    const platform = await invoke("get_platform");
    if (platform !== "macos") {
      showDockIconToggle.closest("label")?.setAttribute("hidden", "");
      return;
    }
  } catch {
    // If the platform probe fails, fall through and show the toggle as before.
  }
  try {
    const showDockIcon = await invoke("get_show_dock_icon");
    showDockIconToggle.checked = Boolean(showDockIcon);
    status.textContent = showDockIconToggle.checked ? "开启后 Dock 中一直显示 Comote。" : "关闭后只保留托盘入口。";
  } catch (error) {
    showDockIconToggle.disabled = true;
    status.textContent = `读取失败：${error}`;
  }
}

document.querySelector("#showDockIcon")?.addEventListener("change", async (event) => {
  const toggle = event.currentTarget;
  const status = document.querySelector("#dockIconSettingStatus");
  const invoke = getTauriInvoke();
  if (!invoke) {
    toggle.disabled = true;
    if (status) status.textContent = "仅 Comote 桌面端可用";
    return;
  }
  const nextValue = toggle.checked;
  toggle.disabled = true;
  if (status) status.textContent = "正在保存…";
  try {
    const saved = await invoke("set_show_dock_icon", { show: nextValue });
    toggle.checked = Boolean(saved);
    if (status) {
      status.textContent = toggle.checked
        ? "开启后 Dock 中一直显示 Comote。"
        : "已隐藏 Dock 图标，可从托盘重新打开；如仍显示，重启 Comote 后完全生效。";
    }
  } catch (error) {
    toggle.checked = !nextValue;
    if (status) status.textContent = `保存失败：${error}`;
  } finally {
    toggle.disabled = false;
  }
});

const KEEP_DAEMON_ALIVE_ON = "退出后台服务仍保持在线，手机可继续连接。";
const KEEP_DAEMON_ALIVE_OFF = "退出 Comote 时一并优雅关闭后台服务。";

async function loadKeepDaemonAlivePreference() {
  const toggle = document.querySelector("#keepDaemonAlive");
  const status = document.querySelector("#keepDaemonAliveStatus");
  if (!toggle || !status) {
    return;
  }
  const invoke = getTauriInvoke();
  if (!invoke) {
    toggle.disabled = true;
    status.textContent = "仅 Comote 桌面端可用";
    return;
  }
  try {
    const enabled = await invoke("get_keep_daemon_alive");
    toggle.checked = Boolean(enabled);
    status.textContent = toggle.checked ? KEEP_DAEMON_ALIVE_ON : KEEP_DAEMON_ALIVE_OFF;
  } catch (error) {
    toggle.disabled = true;
    status.textContent = `读取失败：${error}`;
  }
}

document.querySelector("#keepDaemonAlive")?.addEventListener("change", async (event) => {
  const toggle = event.currentTarget;
  const status = document.querySelector("#keepDaemonAliveStatus");
  const invoke = getTauriInvoke();
  if (!invoke) {
    toggle.disabled = true;
    if (status) status.textContent = "仅 Comote 桌面端可用";
    return;
  }
  const nextValue = toggle.checked;
  toggle.disabled = true;
  if (status) status.textContent = "正在保存…";
  try {
    const saved = await invoke("set_keep_daemon_alive", { enabled: nextValue });
    toggle.checked = Boolean(saved);
    if (status) status.textContent = toggle.checked ? KEEP_DAEMON_ALIVE_ON : KEEP_DAEMON_ALIVE_OFF;
  } catch (error) {
    toggle.checked = !nextValue;
    if (status) status.textContent = `保存失败：${error}`;
  } finally {
    toggle.disabled = false;
  }
});

// Surfaces write failures to the user instead of leaving the UI silently stale.
async function guardedAction(action) {
  try {
    return await action();
  } catch (error) {
    if (error.status === 401) {
      window.alert("操作未授权：daemon 设置了本地 API token。");
    } else {
      window.alert(`操作失败：${error.message}`);
    }
    return null;
  }
}

function renderCodexNotice(state) {
  const notice = document.querySelector("#codexNotice");
  notice.hidden = state === "connected" || state === "available";
}

async function startWechatBinding(button) {
  clearWechatLoginPolling();
  button.disabled = true;
  button.textContent = "生成二维码...";
  setWechatLoginView({ state: "loading" });
  try {
    const result = await getJson("/api/channels/wechat/login/start", { method: "POST" });
    activeWechatLoginId = result.loginId ?? null;
    activeWechatQrUrl = result.qrUrl ?? null;
    setWechatLoginView({
      state: "qr",
      loginId: activeWechatLoginId,
      qrUrl: activeWechatQrUrl,
      message: "请用手机微信扫码，Comote 会自动保持监听。",
    });
    await getJson("/api/channels/wechat/runtime/start", { method: "POST" });
    if (activeWechatLoginId) {
      startWechatLoginPolling(activeWechatLoginId);
    }
    await render();
  } catch (error) {
    activeWechatLoginId = null;
    activeWechatQrUrl = null;
    setWechatLoginView({ state: "error", message: `微信绑定启动失败：${error.message}` });
  } finally {
    button.disabled = false;
    button.textContent = activeWechatLoginId ? "刷新二维码" : "绑定微信";
  }
}

function startWechatLoginPolling(loginId) {
  clearWechatLoginPolling();
  wechatLoginPollTimer = setInterval(async () => {
    try {
      const result = await getJson(
        `/api/channels/wechat/login/status?loginId=${encodeURIComponent(loginId)}`,
      );
      if (isWechatLoginConfirmed(result)) {
        clearWechatLoginPolling();
        activeWechatLoginId = null;
        activeWechatQrUrl = null;
        await getJson("/api/channels/wechat/runtime/start", { method: "POST" });
        setWechatLoginView({ state: "bound", accountId: result.accountId, userId: result.userId, userName: result.userName });
        await render();
        return;
      }
      if (isWechatLoginFailed(result)) {
        clearWechatLoginPolling();
        activeWechatLoginId = null;
        activeWechatQrUrl = null;
        setWechatLoginView({
          state: "error",
          message: `二维码已失效，请重新绑定微信。状态：${result.state ?? "unknown"}`,
        });
        await render();
        return;
      }
      setWechatLoginView({
        state: "qr",
        loginId,
        qrUrl: activeWechatQrUrl,
        message: `等待扫码确认：${humanWechatLoginState(result.state)}`,
      });
    } catch (error) {
      setWechatLoginView({
        state: "qr",
        loginId,
        qrUrl: activeWechatQrUrl,
        message: `正在等待扫码，状态检查暂时失败：${error.message}`,
      });
    }
  }, 2500);
}

function clearWechatLoginPolling() {
  if (wechatLoginPollTimer) {
    clearInterval(wechatLoginPollTimer);
    wechatLoginPollTimer = null;
  }
}

function setWechatLoginView({ state, qrUrl = null, loginId = null, accountId = null, userId = null, userName = null, message = null }) {
  const target = document.querySelector("#wechatLoginResult");
  target.replaceChildren();
  target.className = "qr-result";

  if (state === "loading") {
    target.append(createQrGlyph());
    target.append(createTextLine("正在生成微信二维码..."));
    return;
  }
  if (state === "empty") {
    target.append(createQrGlyph());
    target.append(createTextLine("点击「绑定微信」后，二维码会显示在这里"));
    return;
  }
  if (state === "bound") {
    target.append(createStrongLine("微信已绑定"));
    target.append(
      createTextLine(
        userName
          ? `允许账号：${userName}`
          : userId
            ? `允许账号：${userId}`
            : `账号：${accountId ?? "已确认"}`,
      ),
    );
    target.append(createTextLine("收到手机消息后，会在本机确认用户身份。"));
    return;
  }
  if (state === "error") {
    target.append(createStrongLine("需要重新绑定"));
    target.append(createTextLine(message ?? "微信绑定失败。"));
    return;
  }

  target.classList.add("has-qr");
  const imageSource = normalizeQrImageSource(qrUrl);
  if (!imageSource) {
    target.append(createStrongLine("二维码已失效"));
    target.append(createTextLine("请点击“刷新二维码”重新绑定微信。"));
    return;
  }
  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = "微信绑定二维码";
  target.append(image);
  target.append(createStrongLine("用手机微信扫码绑定"));
  target.append(createTextLine(message ?? "扫码后 Comote 会自动完成绑定并保持监听。"));
  if (loginId) {
    const code = document.createElement("code");
    code.textContent = `登录会话：${loginId}`;
    target.append(code);
  }
}

async function startFeishuBinding(button) {
  clearFeishuLoginPolling();
  button.disabled = true;
  button.textContent = "生成二维码...";
  setFeishuLoginView({ state: "loading" });
  try {
    const domain = new FormData(document.querySelector("#feishuConfigForm")).get("domain")?.toString() ?? "feishu";
    const result = await getJson("/api/channels/feishu/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    activeFeishuLogin = result;
    setFeishuLoginView({
      state: "qr",
      qrUrl: result.qrUrl,
      loginId: result.loginId,
      message: "请用手机飞书扫码，Comote 会自动创建机器人并开启 WebSocket。",
    });
    startFeishuLoginPolling(result);
  } catch (error) {
    activeFeishuLogin = null;
    setFeishuLoginView({ state: "error", message: `飞书绑定启动失败：${error.message}` });
  } finally {
    button.disabled = false;
    button.textContent = activeFeishuLogin ? "刷新二维码" : "绑定飞书";
  }
}

function startFeishuLoginPolling(login) {
  clearFeishuLoginPolling();
  feishuLoginPollTimer = setInterval(async () => {
    try {
      const result = await getJson(
        `/api/channels/feishu/login/status?loginId=${encodeURIComponent(login.loginId)}&domain=${encodeURIComponent(login.domain ?? "feishu")}&interval=${encodeURIComponent(login.interval ?? 5)}&expireIn=${encodeURIComponent(login.expireIn ?? 600)}`,
      );
      if (result.state === "confirmed" && result.appId) {
        clearFeishuLoginPolling();
        activeFeishuLogin = null;
        setFeishuLoginView({ state: "bound", appId: result.appId, userId: result.userId, userName: result.userName });
        await render();
        return;
      }
      if (["expired", "access_denied", "timeout", "error"].includes(result.state)) {
        clearFeishuLoginPolling();
        activeFeishuLogin = null;
        setFeishuLoginView({ state: "error", message: `飞书绑定未完成：${humanFeishuLoginState(result.state)}` });
        await render();
        return;
      }
      setFeishuLoginView({
        state: "qr",
        qrUrl: login.qrUrl,
        loginId: login.loginId,
        message: `等待扫码确认：${humanFeishuLoginState(result.state)}`,
      });
    } catch (error) {
      setFeishuLoginView({
        state: "qr",
        qrUrl: login.qrUrl,
        loginId: login.loginId,
        message: `正在等待扫码，状态检查暂时失败：${error.message}`,
      });
    }
  }, 2500);
}

function clearFeishuLoginPolling() {
  if (feishuLoginPollTimer) {
    clearInterval(feishuLoginPollTimer);
    feishuLoginPollTimer = null;
  }
}

function setFeishuLoginView({ state, qrUrl = null, loginId = null, appId = null, userId = null, userName = null, message = null }) {
  const target = document.querySelector("#feishuLoginResult");
  target.replaceChildren();
  target.className = "qr-result";
  if (state === "loading") {
    target.append(createQrGlyph());
    target.append(createTextLine("正在生成飞书二维码..."));
    return;
  }
  if (state === "empty") {
    target.append(createQrGlyph());
    target.append(createTextLine("完成应用授权后，二维码会显示在这里"));
    return;
  }
  if (state === "bound") {
    target.append(createStrongLine("飞书已绑定"));
    target.append(
      createTextLine(
        userName
          ? `允许账号：${userName}`
          : userId
            ? `允许账号：${userId}`
            : `应用：${appId ?? "已配置"}`,
      ),
    );
    target.append(createTextLine("收到飞书消息后，会在本机确认用户身份。"));
    return;
  }
  if (state === "error") {
    target.append(createStrongLine("需要重新绑定"));
    target.append(createTextLine(message ?? "飞书绑定失败。"));
    return;
  }
  target.classList.add("has-qr");
  const imageSource = normalizeQrImageSource(qrUrl);
  if (!imageSource) {
    target.append(createStrongLine("二维码已失效"));
    target.append(createTextLine("请点击“刷新二维码”重新绑定飞书。"));
    return;
  }
  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = "飞书绑定二维码";
  target.append(image);
  target.append(createStrongLine("用手机飞书扫码绑定"));
  target.append(createTextLine(message ?? "扫码后 Comote 会自动完成绑定并开启 WebSocket。"));
  if (loginId) {
    const code = document.createElement("code");
    code.textContent = `登录会话：${loginId}`;
    target.append(code);
  }
}

function createStrongLine(text) {
  const line = document.createElement("strong");
  line.textContent = text;
  return line;
}

function createTextLine(text) {
  const line = document.createElement("span");
  line.textContent = text;
  return line;
}

function createQrGlyph() {
  const wrapper = document.createElement("div");
  wrapper.className = "qr-glyph";
  wrapper.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#c4c2bc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-7M17 21v-4"/></svg>`;
  return wrapper;
}

function normalizeQrImageSource(value) {
  const text = value?.trim?.();
  if (!text) {
    return null;
  }
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(text)) {
    if (/^https?:\/\//i.test(text) && !/\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(text)) {
      return qrDataUrl(text);
    }
    return text;
  }
  if (text.startsWith("<svg")) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 80) {
    return `data:image/png;base64,${text.replace(/\s/g, "")}`;
  }
  return qrDataUrl(text);
}

function isWechatLoginConfirmed(result) {
  return Boolean(result.token && result.accountId) || (result.state === "confirmed" && Boolean(result.accountId));
}

function isWechatLoginFailed(result) {
  return ["expired", "cancelled", "canceled", "failed", "error"].includes(result.state);
}

function humanWechatLoginState(state) {
  if (state === "scanned") return "已扫码，等待确认";
  if (state === "confirmed") return "已确认";
  if (state === "pending" || state === "waiting" || state === "wait") return "等待扫码";
  return state ?? "等待扫码";
}

function channelName(channel) {
  if (channel === "wechat") return "微信";
  if (channel === "feishu") return "飞书";
  return channel;
}

function roleName(role) {
  if (role === "owner") return "所有者";
  if (role === "member") return "成员";
  return role;
}

function humanFeishuBadge(state) {
  if (state === "running") return "监听中";
  if (state === "configured") return "已启用";
  return "需要设置";
}

function humanFeishuState(state) {
  if (state === "running") return "监听中";
  if (state === "configured") return "已配置";
  if (state === "reserved") return "需要设置";
  if (state === "not_configured") return "未配置";
  return "未绑定";
}

function humanFeishuLoginState(state) {
  if (state === "pending") return "等待扫码";
  if (state === "confirmed") return "已确认";
  if (state === "access_denied") return "已取消";
  if (state === "expired") return "已过期";
  if (state === "timeout") return "超时";
  return state ?? "等待扫码";
}

function humanConnectorState(state) {
  if (state === "connected") return "已连接";
  if (state === "available") return "可用";
  return "未连接";
}

function humanRuntimeState(state) {
  if (state === "running") return "监听中";
  if (state === "configured") return "就绪";
  return "需要设置";
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso ?? "";
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// --- Navigation: keep the side-nav highlight and eyebrow in sync with scroll ---
const NAV_LABELS = {
  connectPhone: "连接手机",
  phoneCommands: "从手机使用",
  approvals: "待审批操作",
  users: "授权用户",
  conversation: "Codex 对话",
  logs: "运行日志",
  advanced: "高级设置",
  about: "关于 Comote",
};

function setupNavigation() {
  const navItems = [...document.querySelectorAll(".nav-item")];
  const eyebrow = document.querySelector("#topEyebrow");

  function activate(sectionId) {
    for (const item of navItems) {
      item.classList.toggle("active", item.getAttribute("href") === `#${sectionId}`);
    }
    if (eyebrow) {
      if (NAV_LABELS[sectionId]) {
        eyebrow.textContent = NAV_LABELS[sectionId];
      }
    }
  }

  for (const item of navItems) {
    item.addEventListener("click", () => {
      const sectionId = item.getAttribute("href").slice(1);
      activate(sectionId);
      if (sectionId === "advanced") {
        document.querySelector("#advanced").open = true;
      }
    });
  }

  const sections = Object.keys(NAV_LABELS)
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) {
        activate(visible.target.id);
      }
    },
    { rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.25, 0.5, 1] },
  );
  for (const section of sections) {
    observer.observe(section);
  }
}

function renderThreadMessages(messages) {
  return messages
    .map(
      (message) =>
        `<div class="chat-msg chat-${message.role === "user" ? "user" : "assistant"}"><span class="chat-role">${message.role === "user" ? "手机" : "Codex"}</span><span class="chat-text">${escapeHtml(message.text)}</span></div>`,
    )
    .join("");
}

function updateThreadDetailPanel(row, transcript) {
  const panel = row.querySelector(".thread-detail");
  if (!panel) {
    return;
  }
  const messages = (transcript.messages ?? []).slice().reverse();
  const hasMore = transcript.hasMore ?? false;
  panel.dataset.offset = String(messages.length);
  if (messages.length === 0) {
    panel.innerHTML = `<div class="meta">暂无本地记录</div>`;
    syncExpandedThreadState(row);
    return;
  }
  let html = renderThreadMessages(messages);
  if (hasMore) {
    html += `<button class="secondary-button thread-load-more-btn">加载更多</button>`;
  }
  panel.innerHTML = html;
  syncExpandedThreadState(row);
}

async function refreshThreadDetail(row) {
  const panel = row.querySelector(".thread-detail");
  const threadId = row.dataset.threadId;
  if (!panel || !threadId) {
    return;
  }
  const refreshLimit = Math.max(Number(panel.dataset.offset || 0), 5);
  const result = await safeGet(
    `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=${refreshLimit}&offset=0`,
    null,
  );
  if (!result.ok || !result.value) {
    return;
  }
  const liveRow = findThreadRow(threadId) ?? row;
  updateThreadDetailPanel(liveRow, result.value);
}

async function handleThreadListClick(event) {
  const row = event.target.closest("li[data-thread-id]");
  if (!row) {
    return;
  }
  // Don't toggle if clicking a load-more button inside the detail panel
  if (event.target.closest(".thread-detail")) {
    const btn = event.target.closest(".thread-load-more-btn");
    if (!btn) {
      return;
    }
    const panel = btn.closest(".thread-detail");
    const threadId = row.dataset.threadId;
    const currentOffset = Number(panel.dataset.offset || 0);
    const nextResult = await safeGet(
      `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=20&offset=${currentOffset}`,
      null,
    );
    btn.remove();
    if (!nextResult.ok || !nextResult.value) {
      return;
    }
    const newMessages = (nextResult.value.messages ?? []).slice().reverse();
    const newHasMore = nextResult.value.hasMore ?? false;
    panel.dataset.offset = String(currentOffset + newMessages.length);
    const frag = document.createDocumentFragment();
    const tmp = document.createElement("div");
    tmp.innerHTML = renderThreadMessages(newMessages);
    while (tmp.firstChild) {
      frag.appendChild(tmp.firstChild);
    }
    if (newHasMore) {
      const moreLi = document.createElement("div");
      moreLi.innerHTML = `<button class="secondary-button thread-load-more-btn">加载更多</button>`;
      frag.appendChild(moreLi.firstChild);
    }
    panel.appendChild(frag);
    syncExpandedThreadState(row);
    return;
  }

  await toggleThreadDetail(row);
}

async function toggleThreadDetail(row) {
  const panel = row.querySelector(".thread-detail");
  if (!panel) {
    return;
  }
  const isExpanded = !panel.hidden;
  const nextExpanded = !isExpanded;
  panel.hidden = !nextExpanded;
  row.classList.toggle("expanded", nextExpanded);
  updateThreadToggle(row, nextExpanded);
  syncExpandedThreadState(row);
  if (isExpanded) {
    return;
  }
  // First expand — check if already loaded
  if (panel.dataset.loaded === "1") {
    return;
  }
  panel.dataset.loaded = "1";
  panel.innerHTML = `<div class="meta">加载中…</div>`;
  const threadId = row.dataset.threadId;
  syncExpandedThreadState(row);
  const firstResult = await safeGet(
    `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=5&offset=0`,
    null,
  );
  const liveRow = findThreadRow(threadId) ?? row;
  if (!firstResult.ok || !firstResult.value) {
    const livePanel = liveRow.querySelector(".thread-detail") ?? panel;
    livePanel.innerHTML = `<div class="meta">无法加载记录。</div>`;
    syncExpandedThreadState(liveRow);
    return;
  }
  updateThreadDetailPanel(liveRow, firstResult.value);
}

document.querySelector("#threads").addEventListener("click", handleThreadListClick);
document.querySelector("#phoneOnlyFilter").addEventListener("change", (event) => {
  phoneOnly = event.target.checked;
  const chips = document.querySelector("#channelFilter");
  if (chips) {
    chips.hidden = !phoneOnly;
  }
  if (!phoneOnly) {
    channelFilter = null;
    setActiveChannelChip("");
  }
  paintThreads();
});

for (const chip of document.querySelectorAll("#channelFilter .chan-chip")) {
  chip.addEventListener("click", () => {
    channelFilter = chip.dataset.channel || null;
    setActiveChannelChip(chip.dataset.channel || "");
    paintThreads();
  });
}

function setActiveChannelChip(value) {
  for (const chip of document.querySelectorAll("#channelFilter .chan-chip")) {
    chip.classList.toggle("active", (chip.dataset.channel || "") === value);
  }
}

// --- Searchable project combobox ---
function openProjectCombo() {
  const panel = document.querySelector("#projectComboPanel");
  const trigger = document.querySelector("#projectComboTrigger");
  const search = document.querySelector("#projectComboSearch");
  paintProjectComboList("");
  search.value = "";
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  search.focus();
}

function closeProjectCombo() {
  const panel = document.querySelector("#projectComboPanel");
  const trigger = document.querySelector("#projectComboTrigger");
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

document.querySelector("#projectComboTrigger").addEventListener("click", () => {
  const panel = document.querySelector("#projectComboPanel");
  if (panel.hidden) {
    openProjectCombo();
  } else {
    closeProjectCombo();
  }
});

document.querySelector("#projectComboSearch").addEventListener("input", (event) => {
  paintProjectComboList(event.target.value);
});

document.querySelector("#projectComboList").addEventListener("click", async (event) => {
  const option = event.target.closest(".project-combo-option");
  if (!option) {
    return;
  }
  selectedProjectPath = option.dataset.path;
  updateProjectComboLabel();
  closeProjectCombo();
  await renderThreads({ connectors: { desktop: { state: desktopConnected ? "connected" : "disconnected" } } });
});

// Close the combo when clicking outside it or pressing Escape.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".project-combo")) {
    closeProjectCombo();
  }
});
document.querySelector("#projectComboSearch").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeProjectCombo();
    document.querySelector("#projectComboTrigger").focus();
  }
});

document.querySelector("#logList").addEventListener("click", async (event) => {
  const btn = event.target.closest("#logsLoadMore");
  if (!btn) {
    return;
  }
  btn.disabled = true;
  btn.textContent = "加载中…";
  const result = await safeGet(`/api/logs?limit=5&offset=${logsOffset}`, { entries: [], total: 0, hasMore: false });
  if (!result.ok) {
    btn.disabled = false;
    btn.textContent = "加载更多";
    return;
  }
  const newEntries = result.value.entries ?? [];
  const newHasMore = result.value.hasMore ?? false;
  const visibleCount = logsOffset + newEntries.length;
  logsOffset = visibleCount;
  logsVisibleLimit = Math.max(logsVisibleLimit, visibleCount, 5);
  // Remove the load-more list item
  const loadMoreItem = btn.closest(".load-more-item");
  if (loadMoreItem) {
    loadMoreItem.remove();
  }
  const target = document.querySelector("#logList");
  // Append new log rows
  const tmp = document.createElement("ul");
  tmp.innerHTML = renderLogEntries(newEntries);
  while (tmp.firstChild) {
    target.appendChild(tmp.firstChild);
  }
  if (newHasMore) {
    const li = document.createElement("li");
    li.className = "load-more-item";
    li.innerHTML = `<button class="secondary-button load-more-btn" id="logsLoadMore">加载更多</button>`;
    target.appendChild(li);
  }
});

function startAutoRefresh() {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setInterval(() => {
    if (document.hidden) {
      return;
    }
    render().catch(() => {});
  }, REFRESH_MS);
}

async function init() {
  setupNavigation();
  setBridgeStatus("启动中");
  await loadDockIconPreference();
  await loadKeepDaemonAlivePreference();
  await refreshVersionStatus();
  await render(); // paint immediately with whatever the daemon returns
  startAutoRefresh();
  // Re-check version every 15 minutes so the banner appears without a daemon
  // restart once a release lands.
  setInterval(() => {
    refreshVersionStatus().catch(() => {});
  }, 15 * 60 * 1000);
  // Codex Desktop connection runs in the background so it never blocks paint.
  connectCodexDesktop().catch(() => {});
}

async function refreshVersionStatus() {
  const versionEl = document.querySelector("#sidebarVersion");
  const banner = document.querySelector("#updateNotice");
  const versionResult = await safeGet("/api/version", null);
  const data = versionResult.ok ? versionResult.value : null;
  const current = data?.version ?? null;
  if (versionEl) {
    if (current && data?.hasUpdate && data.latest) {
      versionEl.textContent = `版本 ${current} · 新版 ${data.latest} 可用`;
    } else if (current) {
      versionEl.textContent = `版本 ${current} · 已是最新`;
    } else {
      versionEl.textContent = "版本 · 已是最新";
    }
  }
  if (banner) {
    if (data?.hasUpdate && data.latest) {
      banner.hidden = false;
      const latestEl = document.querySelector("#updateLatestVersion");
      const currentEl = document.querySelector("#updateCurrentVersion");
      const linkEl = document.querySelector("#updateDownloadLink");
      if (latestEl) latestEl.textContent = data.latest;
      if (currentEl) currentEl.textContent = current ?? "未知";
      if (linkEl) {
        linkEl.href = data.downloadUrl ?? data.releaseUrl ?? data.releasesUrl ?? RELEASES_URL;
      }
    } else {
      banner.hidden = true;
    }
  }
  const aboutCurrent = document.querySelector("#aboutCurrentVersion");
  const aboutLatest = document.querySelector("#aboutLatestVersion");
  const aboutLink = document.querySelector("#aboutReleasesLink");
  if (aboutCurrent) aboutCurrent.textContent = current ?? "未知";
  if (aboutLatest) {
    if (data?.latest) {
      aboutLatest.textContent = data.hasUpdate ? `${data.latest}（有新版可下载）` : `${data.latest}（已是最新）`;
    } else if (data?.error) {
      aboutLatest.textContent = `检查失败：${data.error}`;
    } else {
      aboutLatest.textContent = "暂无发布";
    }
  }
  if (aboutLink) {
    aboutLink.href = data?.releasesUrl ?? RELEASES_URL;
  }
}

document.querySelector("#refreshConnect")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "刷新中…";
  try {
    await render();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

document.querySelector("#refreshUsers")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "刷新中…";
  try {
    await render();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

document.querySelector("#aboutCheckUpdate")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "检查中…";
  try {
    await getJson("/api/version/check", { method: "POST" });
    await refreshVersionStatus();
  } catch (error) {
    window.alert(`检查更新失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

init().catch((error) => {
  setBridgeStatus("出错");
  showLoadError(error);
  console.error(error);
});
