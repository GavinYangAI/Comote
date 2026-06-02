import { qrDataUrl } from "./qr-code.js";
import {
  tWeb,
  applyTranslations,
  setWebLocale,
  getWebLocale,
  WEB_LOCALES,
  WEB_LOCALE_NAMES,
} from "./i18n.js";

const REFRESH_MS = 5000;

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
let renderQueued = false;
let logsOffset = 0;
let conversationThreads = [];
let conversationShown = 0;

async function render() {
  // Coalesce instead of dropping: a call arriving mid-render queues one more
  // pass so a language switch (onLangChange awaits render()) reliably repaints
  // dynamic tWeb() text at the now-current locale even if it coincides with an
  // in-flight auto-refresh render.
  if (rendering) {
    renderQueued = true;
    return;
  }
  rendering = true;
  try {
    do {
      // Clear before awaiting; any call during this pass re-sets the flag and
      // earns exactly one more iteration — bounded, no spin, no deadlock.
      renderQueued = false;
      await renderOnce();
    } while (renderQueued);
  } finally {
    rendering = false;
  }
}

async function renderOnce() {
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
    safeGet("/api/logs?limit=5&offset=0", { entries: [], total: 0, hasMore: false }),
  ]);
  const [transcript] = await Promise.all([
    safeGet("/api/codex/transcript", []),
  ]);

  // The daemon being unreachable (or token-gated) is the one failure that
  // genuinely blocks everything — surface it explicitly instead of silently.
  if (!status.ok) {
    showLoadError(status.error);
    setBridgeStatus(status.error?.status === 401 ? tWeb("web.status.authRequired") : tWeb("web.status.offline"));
    return;
  }
  hideLoadError();
  setBridgeStatus(status.value.bridge === "running" ? tWeb("web.status.ready") : tWeb("web.status.starting"));

  renderCodexNotice(status.value.connectors.desktop.state);
  // Hide the retry button when there is nothing to retry.
  document.querySelector("#connectDesktop").hidden = status.value.connectors.desktop.state === "connected";
  document.querySelector("#connections").innerHTML = [
    ["Codex Desktop", humanConnectorState(status.value.connectors.desktop.state)],
    [tWeb("web.connectors.phoneCommands"), status.value.connectors.desktop.state === "connected" ? tWeb("web.connectors.available") : tWeb("web.connectors.waitingDesktop")],
    [tWeb("web.connectors.cliFallback"), status.value.connectors.cli.state === "available" ? tWeb("web.connectors.available") : tWeb("web.connectors.unavailable")],
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
  renderLogs(logs);
  renderConversation(transcript);
  await renderThreads(status.value, projects.value);
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
      label: tWeb("web.readiness.step1.label"),
    },
    {
      done: Boolean(wechatConfig.loggedIn || feishuConfig.configured),
      label: tWeb("web.readiness.step2.label"),
    },
    {
      done: identities.length > 0,
      label: tWeb("web.readiness.step3.label"),
    },
    {
      done: wechatRuntime.state === "running" || feishuRuntime.state === "running",
      label: tWeb("web.readiness.step4.label"),
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
            <span class="ready-state ${item.done ? "done" : "todo"}">${item.done ? tWeb("web.readiness.state.done") : tWeb("web.readiness.state.todo")}</span>
          </div>
          <div>
            <div class="ready-step-no">${tWeb("web.readiness.stepNo", { step: index + 1 })}</div>
            <strong>${escapeHtml(item.label)}</strong>
          </div>
        </li>`,
    )
    .join("");
}

function renderIdentities(result) {
  const target = document.querySelector("#identities");
  if (!result.ok) {
    target.innerHTML = sectionError(tWeb("web.connectors.error.identities"));
    return;
  }
  const identities = result.value;
  target.innerHTML =
    identities.length === 0
      ? `<li><strong>${tWeb("web.identities.empty.title")}</strong><div class="meta">${tWeb("web.identities.empty.hint")}</div></li>`
      : identities
          .map(
            (identity) =>
              `<li class="list-row"><span><strong>${escapeHtml(identity.displayName)}</strong><div class="meta">${channelName(identity.channel)} · ${escapeHtml(identity.stableId)} · ${roleName(identity.role)}</div></span><button class="secondary-button" data-remove-identity="${escapeAttr(identity.channel)}|${escapeAttr(identity.stableId)}">${tWeb("web.identities.remove")}</button></li>`,
          )
          .join("");
}

function renderCandidates(result) {
  const target = document.querySelector("#identityCandidates");
  if (!result.ok) {
    target.innerHTML = sectionError(tWeb("web.connectors.error.candidates"));
    return;
  }
  const candidates = result.value;
  target.innerHTML =
    candidates.length === 0
      ? `<li><strong>${tWeb("web.candidates.empty.title")}</strong><div class="meta">${tWeb("web.candidates.empty.hint")}</div></li>`
      : candidates
          .map(
            (identity) =>
              `<li class="list-row"><span><strong>${escapeHtml(identity.displayName)}</strong><div class="meta">${channelName(identity.channel)} · ${escapeHtml(identity.stableId)}</div></span><button data-confirm-identity="${escapeAttr(identity.channel)}|${escapeAttr(identity.stableId)}|${escapeAttr(identity.displayName)}">${tWeb("web.candidates.confirm")}</button></li>`,
          )
          .join("");
}

function renderProjects(result) {
  const target = document.querySelector("#projects");
  if (!result.ok) {
    target.innerHTML = sectionError(tWeb("web.connectors.error.projects"));
    return;
  }
  const projects = result.value;
  target.innerHTML =
    projects.length === 0
      ? `<li>${tWeb("web.projects.empty")}</li>`
      : projects
          .map(
            (project) =>
              `<li><strong>${escapeHtml(project.id)}. ${escapeHtml(project.name)}</strong><div class="meta">${escapeHtml(project.path)}</div><div class="meta">${escapeHtml(project.source)} · ${escapeHtml(project.status)}</div></li>`,
          )
          .join("");
}

function renderWechat(statusResult, configResult, runtimeResult) {
  const wechatConfig = configResult.value ?? {};
  const wechatRuntime = runtimeResult.value ?? { state: "not_configured" };
  const wechatStatus = statusResult.value ?? {};
  const needsRelogin = Boolean(wechatRuntime.needsRelogin);
  const badge = document.querySelector("#wechatBadge");
  badge.textContent = needsRelogin ? tWeb("web.wechat.badge.needsRelogin") : wechatConfig.loggedIn ? tWeb("web.wechat.badge.bound") : tWeb("web.wechat.badge.unbound");
  badge.className = `badge${needsRelogin ? " warning" : wechatConfig.loggedIn ? " success" : ""}`;
  document.querySelector("#wechatStatus").innerHTML = [
    [tWeb("web.wechat.label.status"), needsRelogin ? tWeb("web.wechat.status.invalid") : wechatConfig.loggedIn ? tWeb("web.wechat.status.bound") : tWeb("web.wechat.status.unbound")],
    [tWeb("web.wechat.label.listening"), needsRelogin ? tWeb("web.wechat.listening.offline") : humanRuntimeState(wechatRuntime.state)],
    [tWeb("web.wechat.label.allowedAccount"), wechatConfig.linkedUserName ?? wechatConfig.linkedUserId ?? tWeb("web.wechat.account.waitingScan")],
    [tWeb("web.wechat.label.hostApp"), wechatStatus.externalAgentHostRequired ? tWeb("web.wechat.host.required") : tWeb("web.wechat.host.notRequired")],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  const wechatBindButton = document.querySelector("#startWechatLogin");
  // While a rebind is in flight (activeWechatLoginId set), keep the QR visible
  // even though the daemon still reports the old loggedIn=true config.
  wechatBindButton.textContent = activeWechatLoginId
    ? tWeb("web.wechat.bind.refresh")
    : wechatConfig.loggedIn
      ? tWeb("web.wechat.bind.rebind")
      : tWeb("web.wechat.bind.bind");
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
  const feishuReady = feishuRuntime.state === "running" || feishuRuntime.state === "configured";
  const badge = document.querySelector("#feishuBadge");
  badge.textContent = humanFeishuBadge(feishuRuntime.state);
  badge.className = `badge${feishuReady ? " success" : " warning"}`;
  document.querySelector("#feishuStatus").innerHTML = [
    [tWeb("web.feishu.label.status"), humanFeishuState(feishuRuntime.state)],
    [tWeb("web.feishu.label.connection"), feishuRuntime.state === "running" ? tWeb("web.feishu.connection.listening") : feishuConfig.configured ? tWeb("web.feishu.connection.configured") : tWeb("web.feishu.connection.waitingScan")],
    [tWeb("web.feishu.label.allowedAccount"), feishuConfig.linkedUserName ?? feishuConfig.linkedUserId ?? tWeb("web.feishu.account.waitingConfirm")],
    [tWeb("web.feishu.label.app"), feishuConfig.appId ?? tWeb("web.feishu.app.unset")],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  const feishuForm = document.querySelector("#feishuConfigForm");
  feishuForm.elements.domain.value = feishuConfig.domain ?? "feishu";
  const feishuBindButton = document.querySelector("#startFeishuLogin");
  feishuBindButton.textContent = feishuConfig.configured ? tWeb("web.feishu.bind.rebind") : activeFeishuLogin ? tWeb("web.feishu.bind.refresh") : tWeb("web.feishu.bind.bind");
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
    target.innerHTML = sectionError(tWeb("web.connectors.error.approvals"));
    badge.textContent = tWeb("web.approvals.badge.empty");
    navCount.hidden = true;
    return;
  }
  const approvals = result.value;
  badge.textContent = tWeb("web.approvals.badge.count", { count: approvals.length });
  badge.className = `badge${approvals.length > 0 ? " warning" : " neutral"}`;
  navCount.hidden = approvals.length === 0;
  navCount.textContent = String(approvals.length);
  target.innerHTML =
    approvals.length === 0
      ? `<li><strong>${tWeb("web.approvals.empty.title")}</strong><div class="meta">${tWeb("web.approvals.empty.hint")}</div></li>`
      : approvals
          .map((approval) => {
            const command = approval.params?.command ?? approval.params?.reason ?? approval.method;
            const cwd = approval.params?.cwd ?? "";
            return `<li class="list-row"><span><strong>${escapeHtml(command)}</strong><div class="meta">${escapeHtml(approval.id)}</div><div class="meta">${escapeHtml(cwd)}</div></span><span class="button-row"><button data-approval="${escapeAttr(approval.id)}|accept">${tWeb("web.approvals.accept")}</button><button class="secondary-button" data-approval="${escapeAttr(approval.id)}|decline">${tWeb("web.approvals.decline")}</button></span></li>`;
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

function renderLogs(result) {
  const target = document.querySelector("#logList");
  if (!result.ok) {
    target.innerHTML = sectionError(tWeb("web.connectors.error.logs"));
    return;
  }
  const data = result.value;
  const entries = data.entries ?? [];
  const hasMore = data.hasMore ?? false;
  logsOffset = entries.length;
  if (entries.length === 0) {
    target.innerHTML = `<li><strong>${tWeb("web.logs.empty.title")}</strong><div class="meta">${tWeb("web.logs.empty.hint")}</div></li>`;
    return;
  }
  target.innerHTML = renderLogEntries(entries);
  if (hasMore) {
    const btn = document.createElement("li");
    btn.className = "load-more-item";
    btn.innerHTML = `<button class="secondary-button load-more-btn" id="logsLoadMore">${tWeb("web.logs.loadMore")}</button>`;
    target.appendChild(btn);
  }
}

function renderConversation(result) {
  const target = document.querySelector("#conversationList");
  if (!result.ok) {
    target.innerHTML = `<p class="meta">${tWeb("web.conversation.loadError")}</p>`;
    return;
  }
  conversationThreads = result.value ?? [];
  conversationShown = Math.min(5, conversationThreads.length);
  paintConversation();
}

function paintConversation() {
  const target = document.querySelector("#conversationList");
  if (conversationThreads.length === 0) {
    target.innerHTML = `<p class="meta">${tWeb("web.conversation.empty")}</p>`;
    return;
  }
  const html = conversationThreads
    .slice(0, conversationShown)
    .map((thread) => {
      const messages = thread.messages
        .slice(-12)
        .map(
          (message) =>
            `<div class="chat-msg chat-${message.role === "user" ? "user" : "assistant"}"><span class="chat-role">${message.role === "user" ? tWeb("web.chat.rolePhone") : "Codex"}</span><span class="chat-text">${escapeHtml(message.text)}</span></div>`,
        )
        .join("");
      return `<article class="chat-thread"><div class="meta">${escapeHtml(thread.threadId)}</div>${messages}</article>`;
    })
    .join("");
  const moreBtn =
    conversationShown < conversationThreads.length
      ? `<button class="secondary-button load-more-btn" id="conversationLoadMore">${tWeb("web.conversation.loadMore")}</button>`
      : "";
  target.innerHTML = html + moreBtn;
}


async function renderThreads(status, projectsValue) {
  const target = document.querySelector("#threads");
  const projects = Array.isArray(projectsValue) ? projectsValue : [];
  const primaryProject = projects[0];
  if (status.connectors.desktop.state !== "connected" || !primaryProject) {
    target.innerHTML = `<li><strong>${tWeb("web.threads.disconnected.title")}</strong><div class="meta">${tWeb("web.threads.disconnected.hint")}</div></li>`;
    return;
  }
  const result = await safeGet(`/api/codex/threads?cwd=${encodeURIComponent(primaryProject.path)}`, null);
  if (!result.ok) {
    target.innerHTML = sectionError(tWeb("web.connectors.error.threads"));
    return;
  }
  const threadList = result.value?.data ?? result.value?.threads ?? [];
  target.innerHTML =
    threadList.length === 0
      ? `<li>${tWeb("web.threads.empty", { name: escapeHtml(primaryProject.name) })}</li>`
      : threadList
          .map((thread, index) => {
            const title = thread.title ?? thread.name ?? thread.preview ?? thread.id;
            const cwd = thread.cwd ?? primaryProject.path;
            return `<li class="thread-row" data-thread-id="${escapeAttr(thread.id)}"><div class="thread-row-summary"><strong>${index + 1}. ${escapeHtml(title)}</strong><div class="meta">${escapeHtml(thread.id)}</div><div class="meta">${escapeHtml(cwd)}</div></div><div class="thread-detail" hidden data-offset="0"></div></li>`;
          })
          .join("");
}

function setBridgeStatus(label) {
  const pill = document.querySelector("#bridgeStatus");
  pill.textContent = label;
  pill.className = `status-pill status-${
    label === tWeb("web.status.ready")
      ? "ok"
      : label === tWeb("web.status.authRequired")
        ? "warn"
        : label === tWeb("web.status.offline")
          ? "error"
          : "pending"
  }`;
}

function showLoadError(error) {
  const panel = document.querySelector("#loadError");
  const title = document.querySelector("#loadErrorTitle");
  const detail = document.querySelector("#loadErrorDetail");
  if (error?.status === 401) {
    title.textContent = tWeb("web.loadError.tokenTitle");
    detail.textContent = tWeb("web.loadError.tokenDetail");
  } else {
    title.textContent = tWeb("web.loadError.connTitle");
    detail.textContent = tWeb("web.loadError.connDetail", { message: error?.message ?? "" });
  }
  panel.hidden = false;
}

function hideLoadError() {
  document.querySelector("#loadError").hidden = true;
}

function sectionError(message) {
  return `<li class="list-error"><strong>${escapeHtml(message)}</strong><div class="meta">${tWeb("web.sectionError.retryHint")}</div></li>`;
}


document.querySelector("#retryLoad").addEventListener("click", async () => {
  await render();
});

document.querySelector("#refreshLogs").addEventListener("click", async () => {
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
    button.textContent = tWeb("web.codex.connecting");
  }
  try {
    await getJson("/api/connectors/codex-desktop/auto-connect", { method: "POST" });
  } catch {
    // auto-connect returns 503 when Codex Desktop is closed — the notice banner
    // already tells the user; no need to escalate to a hard error.
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.defaultLabel ?? tWeb("web.codex.retry");
    }
  }
  await render();
}

document.querySelector("#connectDesktop").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = tWeb("web.codex.connecting");
  try {
    await getJson("/api/connectors/codex-desktop/initialize", { method: "POST" });
  } catch (error) {
    window.alert(tWeb("web.codex.connectFailed", { message: error.message }));
  } finally {
    button.disabled = false;
    button.textContent = tWeb("web.codex.retryConnect");
  }
  await render();
});

document.querySelector("#retryCodexConnection").addEventListener("click", async (event) => {
  await connectCodexDesktop({ button: event.currentTarget });
});

document.querySelector("#discoverProjects").addEventListener("click", async () => {
  const button = document.querySelector("#discoverProjects");
  button.disabled = true;
  button.textContent = tWeb("web.projects.refreshing");
  try {
    await guardedAction(() => getJson("/api/projects/discover", { method: "POST" }));
    await render();
  } finally {
    button.disabled = false;
    button.textContent = tWeb("web.projects.refresh");
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

// Surfaces write failures to the user instead of leaving the UI silently stale.
async function guardedAction(action) {
  try {
    return await action();
  } catch (error) {
    if (error.status === 401) {
      window.alert(tWeb("web.action.unauthorized"));
    } else {
      window.alert(tWeb("web.action.failed", { message: error.message }));
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
  button.textContent = tWeb("web.qr.generating");
  setWechatLoginView({ state: "loading" });
  try {
    const result = await getJson("/api/channels/wechat/login/start", { method: "POST" });
    activeWechatLoginId = result.loginId ?? null;
    activeWechatQrUrl = result.qrUrl ?? null;
    setWechatLoginView({
      state: "qr",
      loginId: activeWechatLoginId,
      qrUrl: activeWechatQrUrl,
      message: tWeb("web.wechat.qr.scanHint"),
    });
    await getJson("/api/channels/wechat/runtime/start", { method: "POST" });
    if (activeWechatLoginId) {
      startWechatLoginPolling(activeWechatLoginId);
    }
    await render();
  } catch (error) {
    activeWechatLoginId = null;
    activeWechatQrUrl = null;
    setWechatLoginView({ state: "error", message: tWeb("web.wechat.bind.startFailed", { message: error.message }) });
  } finally {
    button.disabled = false;
    button.textContent = activeWechatLoginId ? tWeb("web.wechat.bind.refresh") : tWeb("web.wechat.bind.bind");
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
          message: tWeb("web.wechat.qr.expired", { state: result.state ?? "unknown" }),
        });
        await render();
        return;
      }
      setWechatLoginView({
        state: "qr",
        loginId,
        qrUrl: activeWechatQrUrl,
        message: tWeb("web.wechat.qr.waiting", { state: humanWechatLoginState(result.state) }),
      });
    } catch (error) {
      setWechatLoginView({
        state: "qr",
        loginId,
        qrUrl: activeWechatQrUrl,
        message: tWeb("web.wechat.qr.checkFailed", { message: error.message }),
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
    target.append(createTextLine(tWeb("web.wechat.view.generating")));
    return;
  }
  if (state === "empty") {
    target.append(createQrGlyph());
    target.append(createTextLine(tWeb("web.wechat.view.emptyHint")));
    return;
  }
  if (state === "bound") {
    target.append(createStrongLine(tWeb("web.wechat.view.boundTitle")));
    target.append(
      createTextLine(
        userName
          ? tWeb("web.wechat.view.allowedAccount", { name: userName })
          : userId
            ? tWeb("web.wechat.view.allowedAccount", { name: userId })
            : tWeb("web.wechat.view.account", { account: accountId ?? tWeb("web.wechat.view.confirmed") }),
      ),
    );
    target.append(createTextLine(tWeb("web.wechat.view.boundHint")));
    return;
  }
  if (state === "error") {
    target.append(createStrongLine(tWeb("web.qr.needRebind")));
    target.append(createTextLine(message ?? tWeb("web.wechat.view.bindFailed")));
    return;
  }

  target.classList.add("has-qr");
  const imageSource = normalizeQrImageSource(qrUrl);
  if (!imageSource) {
    target.append(createStrongLine(tWeb("web.qr.invalidTitle")));
    target.append(createTextLine(tWeb("web.wechat.view.invalidHint")));
    return;
  }
  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = tWeb("web.wechat.view.imageAlt");
  target.append(image);
  target.append(createStrongLine(tWeb("web.wechat.view.scanStrong")));
  target.append(createTextLine(message ?? tWeb("web.wechat.view.scanHint")));
  if (loginId) {
    const code = document.createElement("code");
    code.textContent = tWeb("web.qr.loginSession", { loginId });
    target.append(code);
  }
}

async function startFeishuBinding(button) {
  clearFeishuLoginPolling();
  button.disabled = true;
  button.textContent = tWeb("web.qr.generating");
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
      message: tWeb("web.feishu.qr.scanHint"),
    });
    startFeishuLoginPolling(result);
  } catch (error) {
    activeFeishuLogin = null;
    setFeishuLoginView({ state: "error", message: tWeb("web.feishu.bind.startFailed", { message: error.message }) });
  } finally {
    button.disabled = false;
    button.textContent = activeFeishuLogin ? tWeb("web.feishu.bind.refresh") : tWeb("web.feishu.bind.bind");
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
        setFeishuLoginView({ state: "error", message: tWeb("web.feishu.bind.incomplete", { state: humanFeishuLoginState(result.state) }) });
        await render();
        return;
      }
      setFeishuLoginView({
        state: "qr",
        qrUrl: login.qrUrl,
        loginId: login.loginId,
        message: tWeb("web.feishu.qr.waiting", { state: humanFeishuLoginState(result.state) }),
      });
    } catch (error) {
      setFeishuLoginView({
        state: "qr",
        qrUrl: login.qrUrl,
        loginId: login.loginId,
        message: tWeb("web.feishu.qr.checkFailed", { message: error.message }),
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
    target.append(createTextLine(tWeb("web.feishu.view.generating")));
    return;
  }
  if (state === "empty") {
    target.append(createQrGlyph());
    target.append(createTextLine(tWeb("web.feishu.view.emptyHint")));
    return;
  }
  if (state === "bound") {
    target.append(createStrongLine(tWeb("web.feishu.view.boundTitle")));
    target.append(
      createTextLine(
        userName
          ? tWeb("web.feishu.view.allowedAccount", { name: userName })
          : userId
            ? tWeb("web.feishu.view.allowedAccount", { name: userId })
            : tWeb("web.feishu.view.app", { app: appId ?? tWeb("web.feishu.connection.configured") }),
      ),
    );
    target.append(createTextLine(tWeb("web.feishu.view.boundHint")));
    return;
  }
  if (state === "error") {
    target.append(createStrongLine(tWeb("web.qr.needRebind")));
    target.append(createTextLine(message ?? tWeb("web.feishu.view.bindFailed")));
    return;
  }
  target.classList.add("has-qr");
  const imageSource = normalizeQrImageSource(qrUrl);
  if (!imageSource) {
    target.append(createStrongLine(tWeb("web.qr.invalidTitle")));
    target.append(createTextLine(tWeb("web.feishu.view.invalidHint")));
    return;
  }
  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = tWeb("web.feishu.view.imageAlt");
  target.append(image);
  target.append(createStrongLine(tWeb("web.feishu.view.scanStrong")));
  target.append(createTextLine(message ?? tWeb("web.feishu.view.scanHint")));
  if (loginId) {
    const code = document.createElement("code");
    code.textContent = tWeb("web.qr.loginSession", { loginId });
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
  if (state === "scanned") return tWeb("web.wechatLogin.scanned");
  if (state === "confirmed") return tWeb("web.wechatLogin.confirmed");
  if (state === "pending" || state === "waiting" || state === "wait") return tWeb("web.wechatLogin.waiting");
  return state ?? tWeb("web.wechatLogin.waiting");
}

function channelName(channel) {
  if (channel === "wechat") return tWeb("web.channelName.wechat");
  if (channel === "feishu") return tWeb("web.channelName.feishu");
  return channel;
}

function roleName(role) {
  if (role === "owner") return tWeb("web.role.owner");
  if (role === "member") return tWeb("web.role.member");
  return role;
}

function humanFeishuBadge(state) {
  if (state === "running") return tWeb("web.feishuBadge.listening");
  if (state === "configured") return tWeb("web.feishuBadge.enabled");
  return tWeb("web.feishuBadge.needsSetup");
}

function humanFeishuState(state) {
  if (state === "running") return tWeb("web.feishuState.listening");
  if (state === "configured") return tWeb("web.feishuState.configured");
  if (state === "reserved") return tWeb("web.feishuState.needsSetup");
  if (state === "not_configured") return tWeb("web.feishuState.notConfigured");
  return tWeb("web.feishuState.unbound");
}

function humanFeishuLoginState(state) {
  if (state === "pending") return tWeb("web.feishuLogin.waiting");
  if (state === "confirmed") return tWeb("web.feishuLogin.confirmed");
  if (state === "access_denied") return tWeb("web.feishuLogin.cancelled");
  if (state === "expired") return tWeb("web.feishuLogin.expired");
  if (state === "timeout") return tWeb("web.feishuLogin.timeout");
  return state ?? tWeb("web.feishuLogin.waiting");
}

function humanConnectorState(state) {
  if (state === "connected") return tWeb("web.connector.connected");
  if (state === "available") return tWeb("web.connector.available");
  return tWeb("web.connector.disconnected");
}

function humanRuntimeState(state) {
  if (state === "running") return tWeb("web.runtime.listening");
  if (state === "configured") return tWeb("web.runtime.ready");
  return tWeb("web.runtime.needsSetup");
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
const NAV_LABEL_KEYS = {
  connectPhone: "web.nav.connectPhone",
  phoneCommands: "web.nav.phoneCommands",
  approvals: "web.approvals.title",
  users: "web.nav.users",
  conversation: "web.nav.conversation",
  logs: "web.nav.logs",
  advanced: "web.nav.advanced",
  about: "web.about.title",
};

function setupNavigation() {
  const navItems = [...document.querySelectorAll(".nav-item")];
  const eyebrow = document.querySelector("#topEyebrow");

  function activate(sectionId) {
    for (const item of navItems) {
      item.classList.toggle("active", item.getAttribute("href") === `#${sectionId}`);
    }
    if (NAV_LABEL_KEYS[sectionId]) {
      eyebrow.textContent = tWeb(NAV_LABEL_KEYS[sectionId]);
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

  const sections = Object.keys(NAV_LABEL_KEYS)
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
        `<div class="chat-msg chat-${message.role === "user" ? "user" : "assistant"}"><span class="chat-role">${message.role === "user" ? tWeb("web.chat.rolePhone") : "Codex"}</span><span class="chat-text">${escapeHtml(message.text)}</span></div>`,
    )
    .join("");
}

document.querySelector("#threads").addEventListener("click", async (event) => {
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
      moreLi.innerHTML = `<button class="secondary-button thread-load-more-btn">${tWeb("web.threads.loadMore")}</button>`;
      frag.appendChild(moreLi.firstChild);
    }
    panel.appendChild(frag);
    return;
  }

  const panel = row.querySelector(".thread-detail");
  if (!panel) {
    return;
  }
  const isExpanded = !panel.hidden;
  panel.hidden = isExpanded;
  if (isExpanded) {
    return;
  }
  // First expand — check if already loaded
  if (panel.dataset.loaded === "1") {
    return;
  }
  panel.dataset.loaded = "1";
  panel.innerHTML = `<div class="meta">${tWeb("web.threads.loading")}</div>`;
  const threadId = row.dataset.threadId;
  const firstResult = await safeGet(
    `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=5&offset=0`,
    null,
  );
  if (!firstResult.ok || !firstResult.value) {
    panel.innerHTML = `<div class="meta">${tWeb("web.threads.loadError")}</div>`;
    return;
  }
  const messages = (firstResult.value.messages ?? []).slice().reverse();
  const hasMore = firstResult.value.hasMore ?? false;
  panel.dataset.offset = String(messages.length);
  if (messages.length === 0) {
    panel.innerHTML = `<div class="meta">${tWeb("web.threads.noLocal")}</div>`;
    return;
  }
  let html = renderThreadMessages(messages);
  if (hasMore) {
    html += `<button class="secondary-button thread-load-more-btn">${tWeb("web.threads.loadMore")}</button>`;
  }
  panel.innerHTML = html;
});

document.querySelector("#logList").addEventListener("click", async (event) => {
  const btn = event.target.closest("#logsLoadMore");
  if (!btn) {
    return;
  }
  btn.disabled = true;
  btn.textContent = tWeb("web.threads.loading");
  const result = await safeGet(`/api/logs?limit=5&offset=${logsOffset}`, { entries: [], total: 0, hasMore: false });
  if (!result.ok) {
    btn.disabled = false;
    btn.textContent = tWeb("web.logs.loadMore");
    return;
  }
  const newEntries = result.value.entries ?? [];
  const newHasMore = result.value.hasMore ?? false;
  logsOffset += newEntries.length;
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
    li.innerHTML = `<button class="secondary-button load-more-btn" id="logsLoadMore">${tWeb("web.logs.loadMore")}</button>`;
    target.appendChild(li);
  }
});

document.querySelector("#conversationList").addEventListener("click", (event) => {
  if (!event.target.closest("#conversationLoadMore")) {
    return;
  }
  conversationShown += 5;
  paintConversation();
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

function populateLangSelect() {
  const sel = document.querySelector("#langSelect");
  if (!sel) {
    return;
  }
  sel.innerHTML = "";
  for (const loc of WEB_LOCALES) {
    const opt = document.createElement("option");
    opt.value = loc;
    opt.textContent = WEB_LOCALE_NAMES[loc];
    sel.appendChild(opt);
  }
  sel.value = getWebLocale();
  sel.addEventListener("change", onLangChange);
}

async function onLangChange(event) {
  const locale = event.target.value;
  try {
    await getJson("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    });
  } catch {
    // Keep going; still switch the UI even if persisting the preference failed.
  }
  setWebLocale(locale);
  applyTranslations(document);
  await render(); // re-run the main render so dynamic tWeb() strings update
}

async function init() {
  setupNavigation();
  setBridgeStatus(tWeb("web.status.starting"));
  const settings = await safeGet("/api/settings", { locale: "zh", supported: ["zh"] });
  setWebLocale(settings.value?.locale ?? "zh");
  applyTranslations(document);
  populateLangSelect();
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
      versionEl.textContent = tWeb("web.version.withUpdate", { current, latest: data.latest });
    } else if (current) {
      versionEl.textContent = tWeb("web.version.latest", { current });
    } else {
      versionEl.textContent = tWeb("web.version.noCurrent");
    }
  }
  if (banner) {
    if (data?.hasUpdate && data.latest) {
      banner.hidden = false;
      const latestEl = document.querySelector("#updateLatestVersion");
      const currentEl = document.querySelector("#updateCurrentVersion");
      const linkEl = document.querySelector("#updateDownloadLink");
      if (latestEl) latestEl.textContent = data.latest;
      if (currentEl) currentEl.textContent = current ?? tWeb("web.version.unknown");
      if (linkEl) {
        linkEl.href = data.releaseUrl ?? "https://github.com/GavinYangAI/comote/releases";
      }
    } else {
      banner.hidden = true;
    }
  }
  const aboutCurrent = document.querySelector("#aboutCurrentVersion");
  const aboutLatest = document.querySelector("#aboutLatestVersion");
  const aboutLink = document.querySelector("#aboutReleasesLink");
  if (aboutCurrent) aboutCurrent.textContent = current ?? tWeb("web.version.unknown");
  if (aboutLatest) {
    if (data?.latest) {
      aboutLatest.textContent = data.hasUpdate
        ? tWeb("web.about.latestHasUpdate", { latest: data.latest })
        : tWeb("web.about.latestUpToDate", { latest: data.latest });
    } else if (data?.error) {
      aboutLatest.textContent = tWeb("web.about.checkFailed", { error: data.error });
    } else {
      aboutLatest.textContent = tWeb("web.about.noRelease");
    }
  }
  if (aboutLink && data?.releaseUrl) {
    aboutLink.href = data.releaseUrl;
  }
}

document.querySelector("#refreshConnect")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = tWeb("web.button.refreshing");
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
  button.textContent = tWeb("web.button.refreshing");
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
  button.textContent = tWeb("web.about.checking");
  try {
    await getJson("/api/version/check", { method: "POST" });
    await refreshVersionStatus();
  } catch (error) {
    window.alert(tWeb("web.about.checkUpdateFailed", { message: error.message }));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

init().catch((error) => {
  setBridgeStatus(tWeb("web.status.error"));
  showLoadError(error);
  console.error(error);
});
