import { qrDataUrl } from "./qr-code.js";
import {
  threadListSignature,
  newTranscriptMessages,
  transcriptRefreshLimit,
  advanceRefreshCursor,
  resolveRefreshTotal,
  shouldSkipPanelRefresh,
} from "./thread-view.js";
import {
  channelBadge,
  channelRows,
  channelFormSpec,
  channelBoundButton,
  isBound,
  isConnected,
  partitionChannels,
  channelSummaryLine,
  bindingAffordance,
  channelSetup,
  channelLastError,
  normalizedLoginView,
  restingLoginView,
  readinessFromChannels,
} from "./channel-view.js";
import {
  tWeb,
  applyTranslations,
  setWebLocale,
  getWebLocale,
  WEB_LOCALES,
  WEB_LOCALE_NAMES,
} from "./i18n.js";

const REFRESH_MS = 5000;
const QR_POLL_MS = 2500;

async function getJson(path, options = {}) {
  const token = localStorage.getItem("comoteApiToken");
  const headers = {
    ...(options.headers ?? {}),
    ...(token ? { "x-comote-token": token } : {}),
  };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      detail = null;
    }
    const error = new Error(detail?.error ?? `Request failed: ${response.status}`);
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

// --- Tauri desktop bridge ---------------------------------------------------
// The desktop UI runs in a remote-origin webview where <a target="_blank"> is a
// no-op (the OS just swallows the click), so external links go nowhere. When
// running inside Tauri we route http(s) links through the open_external command,
// which opens them in the system default browser. In a plain browser there is no
// Tauri global, so links keep their normal behavior.
function tauriInvoke(command, args) {
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  if (typeof invoke !== "function") {
    return null;
  }
  return invoke(command, args);
}

const isTauri = typeof window.__TAURI__ !== "undefined";

// Treat the daemon's own origin as internal so in-app navigation (and the boot
// page) is never hijacked; only genuinely external http(s) links are diverted.
function isExternalHttpLink(anchor) {
  if (!anchor || anchor.target === "_self") {
    return false;
  }
  const href = anchor.getAttribute("href") || "";
  if (!/^https?:\/\//i.test(href)) {
    return false;
  }
  try {
    return new URL(anchor.href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

if (isTauri) {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target.closest && event.target.closest("a[href]");
      if (!anchor || !isExternalHttpLink(anchor)) {
        return;
      }
      event.preventDefault();
      const result = tauriInvoke("open_external", { url: anchor.href });
      if (result && typeof result.catch === "function") {
        result.catch((error) => console.error("open_external failed", error));
      }
    },
    true,
  );
}

// Wires the "keep daemon alive after quit" toggle. Only meaningful inside the
// desktop app (the preference is read by the Rust quit path). In a plain
// browser the panel remains visible for discoverability, with controls disabled.
function setDesktopSettingStatus(element, key, isError = false) {
  if (!element) return;
  element.dataset.i18n = key;
  element.textContent = tWeb(key);
  element.classList.toggle("is-error", isError);
}

async function setupKeepAliveToggle() {
  const panel = document.querySelector("#keepAlivePanel");
  const checkbox = document.querySelector("#keepDaemonAlive");
  const status = document.querySelector("#keepDaemonAliveStatus");
  if (!panel || !checkbox) {
    return;
  }
  if (!isTauri) {
    checkbox.disabled = true;
    setDesktopSettingStatus(status, "web.advanced.desktopOnly");
    return;
  }
  try {
    const enabled = await tauriInvoke("get_keep_daemon_alive");
    checkbox.checked = Boolean(enabled);
    checkbox.disabled = false;
  } catch (error) {
    console.error("get_keep_daemon_alive failed", error);
    checkbox.disabled = true;
    setDesktopSettingStatus(status, "web.advanced.settingLoadError", true);
  }
  checkbox.addEventListener("change", async () => {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    try {
      await tauriInvoke("set_keep_daemon_alive", { enabled: desired });
      setDesktopSettingStatus(status, "web.advanced.keepAliveHint");
    } catch (error) {
      console.error("set_keep_daemon_alive failed", error);
      checkbox.checked = !desired; // revert on failure
      setDesktopSettingStatus(status, "web.advanced.settingSaveError", true);
    } finally {
      checkbox.disabled = false;
    }
  });
}

// Wires the operating-system login startup entry. Registration is owned by
// the desktop shell; in a normal browser the control remains visible but
// disabled so users know where the feature lives and why it cannot be changed.
async function setupLaunchAtLoginToggle() {
  const checkbox = document.querySelector("#launchAtLogin");
  const status = document.querySelector("#launchAtLoginStatus");
  if (!checkbox || !status) {
    return;
  }
  const showState = (enabled) => {
    setDesktopSettingStatus(
      status,
      enabled
        ? "web.advanced.launchAtLoginEnabled"
        : "web.advanced.launchAtLoginDisabled",
    );
  };
  if (!isTauri) {
    checkbox.disabled = true;
    setDesktopSettingStatus(status, "web.advanced.desktopOnly");
    return;
  }
  try {
    const state = await tauriInvoke("get_launch_at_login");
    checkbox.checked = Boolean(state && state.enabled);
    checkbox.disabled = !(state && state.supported);
    showState(checkbox.checked);
  } catch (error) {
    console.error("get_launch_at_login failed", error);
    checkbox.disabled = true;
    setDesktopSettingStatus(status, "web.advanced.settingLoadError", true);
  }
  checkbox.addEventListener("change", async () => {
    const desired = checkbox.checked;
    checkbox.disabled = true;
    setDesktopSettingStatus(status, "web.advanced.settingSaving");
    try {
      const state = await tauriInvoke("set_launch_at_login", { enabled: desired });
      checkbox.checked = Boolean(state && state.enabled);
      showState(checkbox.checked);
    } catch (error) {
      console.error("set_launch_at_login failed", error);
      checkbox.checked = !desired;
      setDesktopSettingStatus(status, "web.advanced.settingSaveError", true);
    } finally {
      checkbox.disabled = false;
    }
  });
}

// Generic per-channel login state: id -> { loginId, pollTimer, startCtx }.
const activeLogin = {};
let globalManagerLogin = null;
let globalManagerSnapshot = null;
let expandedChannelId = null; // accordion: at most one channel expanded at a time
let lastChannels = []; // latest fetched list, so toggle handlers can re-render
let accordionUserDecided = false; // once the user toggles any channel, stop auto-expanding pending
// Latest channel list from GET /api/channels, kept so event handlers
// (bind/save) can look a channel's meta up by id without re-fetching.
let channelsById = {};
let refreshTimer = null;
let rendering = false;
let renderQueued = false;
let logsOffset = 0;
let conversationThreads = [];
let conversationShown = 0;
// D-5/E-5: "Codex 对话" panel state — the user's project selection (remembered
// in memory across re-renders), the accumulated thread pages, and the opaque
// nextCursor for the "load more" button.
let threadsProjectPath = null; // user's explicit selection; null = follow projects[0]
let threadsLoadedProject = null; // { name, path } of the project the list belongs to
let threadsItems = []; // accumulated thread list (all loaded pages, newest first)
let threadsCursor = null; // nextCursor for the next page; null = no more pages
let threadsPagedBeyondFirst = false; // user clicked "load more" at least once
const THREADS_PAGE_SIZE = 20;

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
    channelsResult,
    globalManagerResult,
    approvals,
    logs,
  ] = await Promise.all([
    safeGet("/api/status", null),
    safeGet("/api/identities", []),
    safeGet("/api/identities/candidates", []),
    safeGet("/api/projects", []),
    safeGet("/api/channels", []),
    safeGet("/api/global-manager", { status: "unbound", enabled: false }),
    safeGet("/api/approvals", []),
    safeGet("/api/logs?limit=5&offset=0", { entries: [], total: 0, hasMore: false }),
  ]);
  // [{...meta, status, runtime, config}] — one registry-driven list drives the
  // cards, the readiness wizard, and the advanced channel dropdown.
  const channels = channelsResult.value ?? [];
  channelsById = Object.fromEntries(channels.map((ch) => [ch.id, ch]));
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

  renderCodexNotice(status.value.connectors.desktop);
  // Hide the retry button when there is nothing to retry.
  document.querySelector("#connectDesktop").hidden = status.value.connectors.desktop.state === "connected";
  const desktopConnector = status.value.connectors.desktop;
  const connectionRows = [
    ["Codex Desktop", humanConnectorState(desktopConnector.state)],
    [tWeb("web.connectors.phoneCommands"), desktopConnector.state === "connected" ? tWeb("web.connectors.available") : tWeb("web.connectors.waitingDesktop")],
    [tWeb("web.connectors.cliFallback"), status.value.connectors.cli.state === "available" ? tWeb("web.connectors.available") : tWeb("web.connectors.unavailable")],
  ];
  if (desktopConnector.command) {
    connectionRows.push([tWeb("web.codexNotice.commandLabel"), escapeHtml(desktopConnector.command)]);
  }
  if (desktopConnector.state !== "connected" && desktopConnector.lastError) {
    connectionRows.push([tWeb("web.codexNotice.title"), escapeHtml(desktopConnector.lastError)]);
  }
  document.querySelector("#connections").innerHTML = connectionRows
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");

  renderReadiness(status.value, identities, channels);
  renderIdentities(identities);
  renderCandidates(candidates);
  renderProjects(projects);
  renderChannels(channels);
  renderGlobalManager(globalManagerResult);
  renderChannelDropdown(channels);
  renderApprovals(approvals);
  renderLogs(logs);
  renderConversation(transcript);
  await renderThreads(status.value, projects.value);
}

function renderGlobalManager(result) {
  const manager = result.ok ? result.value : { status: "unbound", enabled: false, lastError: result.error?.message };
  globalManagerSnapshot = manager;
  if (manager.manager && globalManagerLogin) {
    clearInterval(globalManagerLogin.pollTimer);
    globalManagerLogin = null;
  }
  const status = manager.status ?? "unbound";
  const labels = {
    unbound: [tWeb("web.globalManager.status.unbound"), "neutral"],
    ready: [tWeb("web.globalManager.status.ready"), "success"],
    offline: [tWeb("web.globalManager.status.offline"), "pending"],
    stale: [tWeb("web.globalManager.status.stale"), "pending"],
    degraded: [tWeb("web.globalManager.status.degraded"), "pending"],
  };
  const [label, tone] = labels[status] ?? labels.unbound;
  const badge = document.querySelector("#globalManagerStatus");
  badge.textContent = label;
  badge.className = `badge ${tone}`;
  const configured = Boolean(manager.configured);
  document.querySelector("#globalManagerDescription").textContent = manager.manager
    ? tWeb("web.globalManager.boundAs", { name: manager.manager.displayName ?? manager.manager.stableId })
    : configured
      ? tWeb("web.globalManager.useCurrent")
      : tWeb("web.globalManager.scanHint");
  const rows = [
    [tWeb("web.globalManager.row.app"), manager.appId ?? manager.configuredAppId ?? tWeb("web.globalManager.value.none")],
    [tWeb("web.globalManager.row.user"), manager.manager?.displayName ?? tWeb("web.globalManager.value.none")],
    [tWeb("web.globalManager.row.runtime"), manager.runtime ?? tWeb("web.globalManager.value.none")],
  ];
  if (manager.lastError) rows.push([tWeb("web.globalManager.row.error"), manager.lastError]);
  document.querySelector("#globalManagerDetails").innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  const bind = document.querySelector("#globalManagerBind");
  bind.hidden = status !== "unbound" && status !== "stale";
  bind.textContent = configured ? tWeb("web.globalManager.useButton") : tWeb("web.globalManager.bind");
  document.querySelector("#globalManagerTest").hidden = status !== "ready";
  document.querySelector("#globalManagerUnbind").hidden = status === "unbound";
  document.querySelector("#globalManagerRescan").hidden = !configured;
  document.querySelector("#globalManagerWarning").hidden = !configured;

  const qrBox = document.querySelector("#globalManagerLoginResult");
  if (globalManagerLogin?.lastView) {
    qrBox.hidden = false;
    renderQrInto("globalManagerLoginResult", globalManagerLogin.lastView);
  } else {
    qrBox.hidden = true;
    qrBox.innerHTML = "";
  }
}

function renderReadiness(status, identitiesResult, channels) {
  const section = document.querySelector("#readiness");
  const list = document.querySelector("#readinessList");
  const identities = identitiesResult.ok ? identitiesResult.value : [];
  const desktopState = status?.connectors?.desktop?.state;
  const { bound, running } = readinessFromChannels(channels);

  // Each step carries its dictionary hint (D-2: present in the dict but never
  // rendered before) plus the section anchor an unfinished step links to.
  const items = [
    {
      done: desktopState === "connected" || desktopState === "available",
      label: tWeb("web.readiness.step1.label"),
      hint: tWeb("web.readiness.step1.hint"),
      anchor: "#codexNotice",
    },
    {
      done: bound,
      label: tWeb("web.readiness.step2.label"),
      hint: tWeb("web.readiness.step2.hint"),
      anchor: "#connectPhone",
    },
    {
      done: identities.length > 0,
      label: tWeb("web.readiness.step3.label"),
      hint: tWeb("web.readiness.step3.hint"),
      anchor: "#users",
    },
    {
      done: running,
      label: tWeb("web.readiness.step4.label"),
      hint: tWeb("web.readiness.step4.hint"),
      anchor: "#connectPhone",
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
            <div class="meta ready-hint">${escapeHtml(item.hint)}${item.done ? "" : ` <a href="${escapeAttr(item.anchor)}">${escapeHtml(tWeb("web.readiness.goto"))}</a>`}</div>
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

// --- Generic registry-meta-driven channel cards (replaces renderWechat/renderFeishu) ---

function renderChannels(channels) {
  lastChannels = channels;
  const container = document.querySelector("#channelCards");
  if (!container) return;
  const { connected, available } = partitionChannels(channels);
  // Default: if nothing explicitly expanded yet, expand a pending channel (待配对/待扫码) so
  // the pairing code/QR is visible without a click; else keep collapsed.
  if (expandedChannelId === null && !accordionUserDecided) {
    const pending = connected.find((c) => isConnected(c) && !isBound(c));
    if (pending) expandedChannelId = pending.id;
  }
  const sections = [];
  if (connected.length) {
    sections.push(`<section class="channel-section"><div class="channel-section-title">${escapeHtml(tWeb("web.channel.section.connected"))}</div>${connected.map(connectedRowHtml).join("")}</section>`);
  }
  if (available.length) {
    sections.push(`<section class="channel-section"><div class="channel-section-title">${escapeHtml(tWeb("web.channel.section.available"))}</div><div class="channel-add-grid">${available.map(availableTileHtml).join("")}</div></section>`);
  }
  container.innerHTML = sections.join("");
  channels.forEach(paintChannelCardResting); // repaint any in-flight/resting QR area
}

// One delegated click listener for every channel card's bind / save-config
// button. Set up once against the stable #channelCards container so re-renders
// (which replace the cards' innerHTML) never re-bind or double-bind handlers.
function setupChannelCards() {
  const container = document.querySelector("#channelCards");
  if (!container) {
    return;
  }
  container.addEventListener("click", async (event) => {
    const toggleBtn = event.target.closest("[data-toggle]");
    if (toggleBtn) {
      const id = toggleBtn.dataset.toggle;
      accordionUserDecided = true;
      expandedChannelId = expandedChannelId === id ? null : id;
      renderChannels(lastChannels); // re-render from the last fetched list
      return;
    }
    const bindBtn = event.target.closest("[data-bind]");
    if (bindBtn) {
      const ch = channelsById[bindBtn.dataset.bind];
      if (ch) {
        await startQrLogin(ch);
      }
      return;
    }
    const saveBtn = event.target.closest("[data-save-config]");
    if (saveBtn) {
      const id = saveBtn.dataset.saveConfig;
      const channel = channelsById[id];
      const configForm = container.querySelector(`form[data-config-form="${cssEscapeId(id)}"]`);
      if (configForm && !configForm.reportValidity()) {
        return;
      }
      // D-4: give the button a saving → saved lifecycle instead of silence.
      // guardedAction already alerts on failure and returns null there.
      saveBtn.disabled = true;
      const originalLabel = saveBtn.textContent;
      saveBtn.textContent = tWeb("web.channel.saving");
      const result = await guardedAction(async () => {
        const values = readChannelForm(id);
        if (channel?.credentialBinding) {
          values.enabled = true;
        }
        const config = await getJson(`/api/channels/${encodeURIComponent(id)}/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        });
        // Hybrid channels (currently Feishu) support both QR registration and
        // manually supplied app credentials. A valid manual config is already
        // the binding, so start its WebSocket runtime immediately after save.
        if (channel?.credentialBinding && config?.configured) {
          await getJson(`/api/channels/${encodeURIComponent(id)}/runtime/start`, { method: "POST" });
        }
        return config;
      });
      if (result === null) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
        await render();
        return;
      }
      saveBtn.textContent = tWeb("web.channel.saved");
      // Hold the confirmation for 2s, then re-render (which rebuilds the card
      // and restores the normal save label). A 5s auto-refresh may repaint
      // earlier — harmless, it just shortens the confirmation.
      setTimeout(() => {
        render().catch(() => {});
      }, 2000);
    }
  });
}

// Advanced "manual add user" channel dropdown, populated from the registry list
// so a newly registered channel appears here automatically. Preserves the
// current selection across re-renders.
function renderChannelDropdown(channels) {
  const select = document.querySelector("#identityForm select[name='channel']");
  if (!select) {
    return;
  }
  const previous = select.value;
  select.innerHTML = channels
    .map((ch) => `<option value="${escapeAttr(ch.id)}">${escapeHtml(ch.displayName ?? ch.id)}</option>`)
    .join("");
  if (previous && channels.some((ch) => ch.id === previous)) {
    select.value = previous;
  }
}

// A connected channel: collapsible row. Collapsed = icon+name+summary+badge+管理.
// Expanded = binding affordance (pairing code / QR) + status rows + config form + setup.
function connectedRowHtml(ch) {
  const badge = channelBadge(ch, tWeb);
  const pending = isConnected(ch) && !isBound(ch);
  // The error tone (runtime.lastError) outranks the pending style — a broken
  // channel must look broken even while it is also waiting to be bound.
  const badgeClass = `badge${
    badge.tone === "error"
      ? " error"
      : pending
        ? " pending"
        : badge.tone === "success"
          ? " success"
          : badge.tone === "warning"
            ? " warning"
            : ""
  }`;
  const icon = ch.icon ?? (ch.displayName ?? "")[0] ?? "";
  const summary = channelSummaryLine(ch, tWeb);
  const expanded = expandedChannelId === ch.id;
  const toggleLabel = expanded ? tWeb("web.channel.collapse") : tWeb("web.channel.manage");
  return `
    <article class="channel-row ${expanded ? "expanded" : ""} ${ch.credentialBinding ? "channel-card-hybrid" : ""}" data-channel="${escapeAttr(ch.id)}">
      <div class="channel-row-head" data-toggle="${escapeAttr(ch.id)}">
        <div class="channel-tile ${escapeAttr(ch.id)}-icon" aria-hidden="true">${escapeHtml(icon)}</div>
        <div><div class="ch-name">${escapeHtml(ch.displayName ?? ch.id)}</div>${summary ? `<div class="ch-summary">${escapeHtml(summary)}</div>` : ""}</div>
        <span class="${badgeClass}">${escapeHtml(badge.text)}</span>
        <button type="button" class="secondary-button" data-toggle="${escapeAttr(ch.id)}">${escapeHtml(toggleLabel)} ${expanded ? "▴" : "▾"}</button>
      </div>
      ${expanded ? `<div class="channel-row-body">${channelDetailHtml(ch)}</div>` : ""}
    </article>`;
}

// An available (unconfigured) channel: compact add tile; expands into the same
// config detail when clicked.
function availableTileHtml(ch) {
  const icon = ch.icon ?? (ch.displayName ?? "")[0] ?? "";
  const expanded = expandedChannelId === ch.id;
  const hybridClass = ch.credentialBinding ? " channel-card-hybrid" : "";
  if (expanded) {
    return `<article class="channel-add-tile expanded${hybridClass}" data-channel="${escapeAttr(ch.id)}">
      <div class="channel-row-head channel-add-head" data-toggle="${escapeAttr(ch.id)}">
        <div class="channel-tile ${escapeAttr(ch.id)}-icon" aria-hidden="true">${escapeHtml(icon)}</div>
        <div class="ch-name">${escapeHtml(ch.displayName ?? ch.id)}</div>
        <button type="button" class="secondary-button" data-toggle="${escapeAttr(ch.id)}">${escapeHtml(tWeb("web.channel.collapse"))} ▴</button>
      </div>
      ${channelDetailHtml(ch)}</article>`;
  }
  return `<article class="channel-add-tile${hybridClass}" data-channel="${escapeAttr(ch.id)}">
    <div class="channel-tile ${escapeAttr(ch.id)}-icon" aria-hidden="true">${escapeHtml(icon)}</div>
    <div class="ch-name">${escapeHtml(ch.displayName ?? ch.id)}</div>
    <button type="button" class="btn-primary-card" data-toggle="${escapeAttr(ch.id)}">+ ${escapeHtml(tWeb("web.channel.add"))}</button>
  </article>`;
}

// Shared expanded detail: binding affordance + status rows + config form + setup +
// actions. Reuses channelConfigFormHtml + the QR area for qr channels.
function channelDetailHtml(ch) {
  const aff = bindingAffordance(ch);
  let affHtml = "";
  if (aff?.kind === "pairingCode") {
    affHtml = `<div class="pairing-block"><div class="intro">${escapeHtml(tWeb("web.channel.pairing.intro"))}</div><span class="pairing-code">${escapeHtml(aff.code ?? "—")}</span></div>`;
  } else if (aff?.kind === "qr") {
    affHtml = qrAreaHtml(ch, ch.credentialBinding ? tWeb("web.channel.feishu.manualHint") : null); // the <id>LoginResult scan area, painted by paintChannelCardResting
  }
  // bound qr channel: still show its resting QR area (account summary) on expand
  const qrResting = ch.binding === "qr" && !aff
    ? qrAreaHtml(ch, ch.credentialBinding ? tWeb("web.channel.feishu.manualHint") : null)
    : "";
  // C-1: surface the runtime's recorded lastError as a red row so a bad token
  // (configure "succeeds", runtime start fails) is no longer invisible.
  const lastError = channelLastError(ch);
  const errorHtml = lastError
    ? `<div class="channel-error"><strong>${escapeHtml(tWeb("web.channel.lastError"))}</strong>: ${escapeHtml(lastError)}</div>`
    : "";
  const rows = channelRows(ch, tWeb).map((r) => `<dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd>`).join("");
  const setup = channelSetup(ch, tWeb);
  const setupHtml = setup ? `<details class="channel-setup"><summary>${escapeHtml(tWeb("web.channel.howTo"))} ▸</summary><ol>${setup.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>${setup.link ? `<a href="${escapeAttr(setup.link.url)}" target="_blank" rel="noopener">↗ ${escapeHtml(setup.link.label)}</a>` : ""}</details>` : "";
  const button = channelBoundButton(ch, tWeb, { activeLoginId: activeLogin[ch.id]?.loginId ?? null });
  if (ch.credentialBinding) {
    const statusHtml = rows ? `<dl class="kv status-rows feishu-status-strip">${rows}</dl>` : "";
    const qrHtml = affHtml || qrResting || qrAreaHtml(ch, tWeb("web.channel.feishu.qrDesc"));
    return `${errorHtml}${statusHtml}<div class="feishu-bind-grid">
      <section class="bind-method bind-method-primary">
        <header class="bind-method-head">
          <span class="bind-method-tag">${escapeHtml(tWeb("web.channel.feishu.recommended"))}</span>
          <h4>${escapeHtml(tWeb("web.channel.feishu.bindCredentials"))}</h4>
          <p>${escapeHtml(tWeb("web.channel.feishu.manualHint"))}</p>
        </header>
        ${channelConfigFormHtml(ch)}
        ${setupHtml}
        <div class="actions card-actions"><button type="button" class="btn-primary-card" data-save-config="${escapeAttr(ch.id)}">${escapeHtml(tWeb("web.channel.feishu.bindCredentials"))}</button></div>
      </section>
      <section class="bind-method bind-method-secondary">
        <header class="bind-method-head">
          <span class="bind-method-tag neutral">${escapeHtml(tWeb("web.channel.feishu.alternative"))}</span>
          <h4>${escapeHtml(tWeb("web.channel.feishu.bindQr"))}</h4>
          <p>${escapeHtml(tWeb("web.channel.feishu.qrDesc"))}</p>
        </header>
        ${qrHtml}
        <div class="actions card-actions"><button type="button" class="secondary-button qr-bind-button" data-bind="${escapeAttr(ch.id)}">${escapeHtml(tWeb("web.channel.feishu.bindQr"))}</button></div>
      </section>
    </div>`;
  }
  const actionBtn = ch.binding === "qr"
    ? `<button type="button" class="btn-primary-card" data-bind="${escapeAttr(ch.id)}">${escapeHtml(button.label)}</button>`
    : `<button type="button" class="btn-primary-card" data-save-config="${escapeAttr(ch.id)}">${escapeHtml(tWeb("web.channel.save"))}</button>`;
  return `${errorHtml}${affHtml}${qrResting}${rows ? `<dl class="kv status-rows">${rows}</dl>` : ""}${channelConfigFormHtml(ch)}${setupHtml}<div class="actions card-actions">${actionBtn}</div>`;
}

// The qr scan area (extracted from the old channelCardHtml qr branch) so both the
// pending-scan affordance and a bound qr channel's resting summary can render it.
function qrAreaHtml(ch, message = null) {
  return `<div id="${escapeAttr(ch.id)}LoginResult" class="qr-result">
    <div class="qr-glyph"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#c4c2bc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-7M17 21v-4"/></svg></div>
    <span>${escapeHtml(message ?? tWeb("web.channel.qr.scanHint"))}</span>
  </div>`;
}

// Renders the visible configFields as form inputs. Empty when a channel has no
// visible fields (e.g. wechat: only the hidden accountId field).
function channelConfigFormHtml(ch) {
  const spec = channelFormSpec(ch, tWeb);
  if (spec.length === 0) {
    return "";
  }
  const fields = spec
    .map((field) => {
      const inputId = `channel-${ch.id}-${field.name}`;
      const required = field.required ? " required" : "";
      if (field.type === "select") {
        const options = field.options
          .map((opt) => `<option value="${escapeAttr(opt.value)}"${String(opt.value) === String(field.value) ? " selected" : ""}>${escapeHtml(opt.label)}</option>`)
          .join("");
        return `<div class="config-field"><label class="domain-label" for="${escapeAttr(inputId)}">${escapeHtml(field.label)}</label><label class="select-wrap"><select id="${escapeAttr(inputId)}" name="${escapeAttr(field.name)}"${required}>${options}</select></label></div>`;
      }
      if (field.type === "checkbox") {
        return `<label class="config-field"><input name="${escapeAttr(field.name)}" type="checkbox"${field.value ? " checked" : ""}> <span>${escapeHtml(field.label)}</span></label>`;
      }
      const inputType = field.secret || field.type === "password" ? "password" : "text";
      return `<div class="config-field"><label class="domain-label" for="${escapeAttr(inputId)}">${escapeHtml(field.label)}</label><input id="${escapeAttr(inputId)}" name="${escapeAttr(field.name)}" type="${inputType}" value="${escapeAttr(field.value ?? "")}"${required} autocomplete="off"></div>`;
    })
    .join("");
  return `<form class="stack-form channel-config-form" data-config-form="${escapeAttr(ch.id)}">${fields}</form>`;
}

// While no login is in flight, repaint a qr card's QR area to its resting state
// (bound account summary, or the empty scan hint) from current config. Bind/save
// clicks are handled by the delegated listener in setupChannelCards.
function paintChannelCardResting(ch) {
  if (ch.binding !== "qr") {
    return;
  }
  const active = activeLogin[ch.id];
  if (active) {
    // A login is in flight for this card. A full re-render just rebuilt the card's
    // QR element back to the static scan-hint placeholder; immediately repaint the
    // last live login view so the QR doesn't blink out until the next poll tick.
    // (The poller is keyed by id in module state and re-finds the element by id on
    // its next tick, so it keeps working across the innerHTML rebuild.)
    if (active.lastView) {
      renderQrInto(`${ch.id}LoginResult`, active.lastView);
    }
    return;
  }
  renderQrInto(`${ch.id}LoginResult`, restingLoginView(ch, tWeb));
}

// Reads the current values of a channel's visible config inputs. Returns {} when
// the channel has no form (e.g. wechat) — a safe body for /login/start.
function readChannelForm(id) {
  const ch = channelsById[id];
  const form = document.querySelector(`#channelCards form[data-config-form="${cssEscapeId(id)}"]`);
  const values = {};
  for (const field of channelFormSpec(ch ?? {}, tWeb)) {
    const el = form?.elements?.[field.name];
    if (!el) {
      continue;
    }
    values[field.name] = field.type === "checkbox" ? el.checked : el.value;
  }
  return values;
}

function cssEscapeId(value) {
  return String(value).replace(/["\\]/g, "\\$&");
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

// D-1 (lite): render an event's detail as one `key: value` per line instead of
// a raw JSON blob. Nested objects/arrays keep indented JSON as the value.
function formatLogDetail(detail) {
  if (detail == null) {
    return "";
  }
  if (typeof detail !== "object") {
    return String(detail);
  }
  if (Array.isArray(detail)) {
    return JSON.stringify(detail, null, 2);
  }
  return Object.entries(detail)
    .map(([key, value]) =>
      `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}`)
    .join("\n");
}

function renderLogEntries(entries) {
  return entries
    .map((entry) => {
      const detailText = formatLogDetail(entry.detail);
      const detail = detailText ? `<div class="meta log-detail">${escapeHtml(detailText)}</div>` : "";
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


// Thread-list paint state. The list is refreshed every 5s; without these
// caches each repaint would `innerHTML =` the whole list and wipe any
// expanded conversation (its loaded transcript + scroll position). We keep
// the set of expanded thread ids, a per-thread cache of the loaded detail
// panel, and a signature of the last painted list so an unchanged list is
// skipped entirely.
const expandedThreadIds = new Set();
const threadDetailCache = new Map(); // threadId -> { html, offset, loaded }
let lastThreadSignature = null;

function defaultThreadDetailState() {
  return { html: "", offset: "0", loaded: "", total: "0" };
}

// Snapshot the currently rendered detail panels back into the cache so the
// next repaint can restore them verbatim (transcript html + pagination state).
function syncExpandedThreadStates(target) {
  for (const row of target.querySelectorAll("li[data-thread-id]")) {
    const threadId = row.dataset.threadId;
    const panel = row.querySelector(".thread-detail");
    if (!threadId || !panel) {
      continue;
    }
    if (panel.hidden) {
      expandedThreadIds.delete(threadId);
      continue;
    }
    expandedThreadIds.add(threadId);
    threadDetailCache.set(threadId, {
      html: panel.innerHTML,
      offset: panel.dataset.offset ?? "0",
      loaded: panel.dataset.loaded ?? "",
      total: panel.dataset.total ?? "0",
    });
  }
}

// Drop cached state for threads that are no longer in the list.
function pruneThreadDetailState(threadList) {
  const visibleIds = new Set(threadList.map((thread) => String(thread.id ?? "")));
  for (const threadId of [...expandedThreadIds]) {
    if (!visibleIds.has(threadId)) {
      expandedThreadIds.delete(threadId);
    }
  }
  for (const threadId of [...threadDetailCache.keys()]) {
    if (!visibleIds.has(threadId)) {
      threadDetailCache.delete(threadId);
    }
  }
}

// Repaints the thread list, restoring any expanded detail panels from cache.
// Skips the repaint entirely when the list (and expansion set) is unchanged,
// so the periodic refresh never clobbers an open conversation.
function paintThreads(threadList, primaryProject) {
  const target = document.querySelector("#threads");

  if (threadList.length === 0) {
    expandedThreadIds.clear();
    threadDetailCache.clear();
    lastThreadSignature = null;
    target.innerHTML = `<li>${tWeb("web.threads.empty", { name: escapeHtml(primaryProject.name) })}</li>`;
    return;
  }

  // Signature folds in each thread's revision (message count / updatedAt /
  // latest preview), not just the id set, so new messages in an existing
  // thread still force a repaint instead of being skipped here.
  const signature = threadListSignature(threadList, expandedThreadIds);
  if (signature === lastThreadSignature) {
    return;
  }

  // Capture live panel state before we blow away the DOM.
  syncExpandedThreadStates(target);
  pruneThreadDetailState(threadList);

  target.innerHTML = threadList
    .map((thread, index) => {
      const threadId = String(thread.id ?? "");
      const title = thread.title ?? thread.name ?? thread.preview ?? threadId;
      const cwd = thread.cwd ?? primaryProject.path;
      const expanded = expandedThreadIds.has(threadId);
      const state = threadDetailCache.get(threadId) ?? defaultThreadDetailState();
      // E-7 accessibility: the row toggles on click, so expose it as a
      // focusable button whose aria-expanded tracks the detail panel.
      return `<li class="thread-row" data-thread-id="${escapeAttr(threadId)}" role="button" tabindex="0" aria-expanded="${expanded ? "true" : "false"}"><div class="thread-row-summary"><strong>${index + 1}. ${escapeHtml(title)}</strong><div class="meta">${escapeHtml(threadId)}</div><div class="meta">${escapeHtml(cwd)}</div></div><div class="thread-detail"${expanded ? "" : " hidden"} data-offset="${escapeAttr(state.offset)}" data-loaded="${escapeAttr(state.loaded)}" data-total="${escapeAttr(state.total)}">${expanded ? state.html : ""}</div></li>`;
    })
    .join("");

  lastThreadSignature = signature;
}

// Re-fetch the transcript for every *expanded* detail panel and append any
// messages that arrived since it was loaded. paintThreads restores expanded
// panels from cached HTML, so without this an open conversation would never
// pick up new messages from the 5s poll. Only expanded panels are fetched, so
// the request volume stays one-per-open-conversation. Pagination from "load
// more" is preserved: new (newest) messages are inserted before the load-more
// button and dataset.offset is advanced so older pages still fetch correctly.
async function refreshExpandedThreadDetails(target) {
  for (const row of target.querySelectorAll("li[data-thread-id]")) {
    const threadId = row.dataset.threadId;
    const panel = row.querySelector(".thread-detail");
    if (!threadId || !panel || panel.hidden || panel.dataset.loaded !== "1") {
      continue;
    }
    // Per-panel mutex: skip a panel whose fetch (this refresh or a "load more")
    // is already in flight so a slow/overlapping tick can't read-modify-write the
    // same offset/total/DOM concurrently and duplicate or reorder messages.
    if (shouldSkipPanelRefresh(panel)) {
      continue;
    }
    panel.dataset.refreshing = "1";
    try {
      const prevTotal = Number(panel.dataset.total || 0);
      const total = await refreshPanelTranscript(threadId, panel, prevTotal);
      if (total != null) {
        rememberThreadDetail(row, panel);
      }
    } finally {
      delete panel.dataset.refreshing;
    }
  }
}

// Fetch the newest messages for one expanded panel and append the genuinely-new
// tail. Returns the count the panel is now rendered at (so the caller can cache
// it), or null when the fetch failed. Sizes the page to cover a burst since the
// panel was last rendered — a fixed limit=20 silently dropped the middle of any
// >20-message burst — and advances offset/total by exactly what was appended so
// "load more" and the next refresh's delta stay aligned.
async function refreshPanelTranscript(threadId, panel, prevTotal) {
  // First fetch the default page. Its `total` reveals how big the burst is; if it
  // overflows the default page we re-fetch a page wide enough to carry the whole
  // delta in one newest-first slice (capped), so nothing in the middle is
  // stranded the way a fixed limit=20 used to strand it.
  const probe = await safeGet(
    `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=20&offset=0`,
    null,
  );
  if (!probe.ok || !probe.value) {
    return null;
  }
  let total = probe.value.total ?? prevTotal;
  let page = probe.value.messages;
  const wideLimit = transcriptRefreshLimit(prevTotal, total);
  if (wideLimit > 20) {
    const wide = await safeGet(
      `/api/codex/transcript?threadId=${encodeURIComponent(threadId)}&limit=${wideLimit}&offset=0`,
      null,
    );
    if (wide.ok && wide.value) {
      total = wide.value.total ?? total;
      page = wide.value.messages;
    }
  }
  const newest = newTranscriptMessages(page, prevTotal, total);
  if (newest.length === 0) {
    // Nothing new; only move total forward by what is actually loaded (0), which
    // leaves it at prevTotal so a later burst is still detected.
    const cursor = advanceRefreshCursor(panel.dataset.offset, prevTotal, 0);
    panel.dataset.total = String(cursor.total);
    return cursor.total;
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = renderThreadMessages(newest);
  const frag = document.createDocumentFragment();
  while (tmp.firstChild) {
    frag.appendChild(tmp.firstChild);
  }
  // The panel may currently show only a placeholder (e.g. "no local history")
  // with no rendered messages; drop it before the first real message lands.
  if (!panel.querySelector(".chat-msg")) {
    panel.innerHTML = "";
  }
  const moreBtn = panel.querySelector(".thread-load-more-btn");
  if (moreBtn) {
    panel.insertBefore(frag, moreBtn);
  } else {
    panel.appendChild(frag);
  }
  // Advance the load-more cursor by exactly what we appended. For total (the next
  // refresh's prevTotal): when the page carried the whole delta, prevTotal+appended
  // already equals the server total; when a burst overflowed even the capped wide
  // page, jump straight to the server total so we don't re-fetch — and re-append —
  // the same newest slice next tick (the un-carried middle is "load more" history).
  const cursor = advanceRefreshCursor(panel.dataset.offset, prevTotal, newest.length);
  const nextTotal = resolveRefreshTotal(prevTotal, total, newest.length);
  panel.dataset.total = String(nextTotal);
  panel.dataset.offset = String(cursor.offset);
  return nextTotal;
}

function threadsUrl(cwd, cursor) {
  const params = new URLSearchParams({ cwd, limit: String(THREADS_PAGE_SIZE) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return `/api/codex/threads?${params}`;
}

function resetThreadsPanel() {
  expandedThreadIds.clear();
  threadDetailCache.clear();
  lastThreadSignature = null;
  threadsLoadedProject = null;
  threadsItems = [];
  threadsCursor = null;
  threadsPagedBeyondFirst = false;
}

// Keeps the project <select> in sync with /api/projects while preserving the
// user's selection across the 5s re-renders (options are value=path).
function updateThreadsControls(projects, selected) {
  const controls = document.querySelector("#threadsControls");
  const select = document.querySelector("#threadsProjectSelect");
  if (!controls || !select) {
    return;
  }
  controls.hidden = projects.length === 0;
  select.innerHTML = projects
    .map((project) => `<option value="${escapeAttr(project.path)}">${escapeHtml(project.name)}</option>`)
    .join("");
  if (selected) {
    select.value = selected.path;
  }
}

// The "load more" button is only useful while the server reports another page.
function updateThreadsFooter() {
  const footer = document.querySelector("#threadsFooter");
  if (footer) {
    footer.hidden = !(threadsCursor && threadsItems.length > 0);
  }
}

function threadKey(thread) {
  return String(thread?.id ?? "");
}

async function renderThreads(status, projectsValue) {
  const target = document.querySelector("#threads");
  const projects = Array.isArray(projectsValue) ? projectsValue : [];
  // Honor the user's selection when it still exists; otherwise fall back to
  // the first project (also the initial default).
  const selected = projects.find((project) => project.path === threadsProjectPath) ?? projects[0] ?? null;
  updateThreadsControls(projects, selected);
  if (status.connectors.desktop.state !== "connected" || !selected) {
    resetThreadsPanel();
    updateThreadsFooter();
    target.innerHTML = `<li><strong>${tWeb("web.threads.disconnected.title")}</strong><div class="meta">${tWeb("web.threads.disconnected.hint")}</div></li>`;
    return;
  }
  const result = await safeGet(threadsUrl(selected.path, null), null);
  if (!result.ok) {
    lastThreadSignature = null;
    updateThreadsFooter();
    target.innerHTML = sectionError(tWeb("web.connectors.error.threads"));
    return;
  }
  const firstPage = result.value?.data ?? result.value?.threads ?? [];
  const firstCursor = result.value?.nextCursor ?? null;
  if (threadsLoadedProject?.path !== selected.path) {
    // Project switched (or first paint): drop the old project's pages and
    // any expanded-panel state — it belongs to different threads.
    resetThreadsPanel();
    threadsLoadedProject = { name: selected.name, path: selected.path };
    threadsItems = firstPage;
    threadsCursor = firstCursor;
  } else if (!threadsPagedBeyondFirst) {
    // Same project, only the first page loaded: replace it wholesale so
    // removed/archived threads disappear too.
    threadsItems = firstPage;
    threadsCursor = firstCursor;
  } else {
    // Same project with extra pages loaded: refresh the newest page but keep
    // the older pages the user paged into. Dedupe by id, newest page first;
    // the tail cursor is unaffected by new threads appearing at the top.
    const firstIds = new Set(firstPage.map(threadKey));
    threadsItems = [...firstPage, ...threadsItems.filter((thread) => !firstIds.has(threadKey(thread)))];
  }
  updateThreadsFooter();
  paintThreads(threadsItems, selected);
  // paintThreads restores expanded panels from cache; pull fresh transcripts so
  // new messages show up within the 5s poll instead of being frozen at expand.
  await refreshExpandedThreadDetails(target);
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
  const tokenForm = document.querySelector("#apiTokenForm");
  const tokenInput = document.querySelector("#apiTokenInput");
  if (error?.status === 401) {
    title.textContent = tWeb("web.loadError.tokenTitle");
    detail.textContent = tWeb("web.loadError.tokenDetail");
    tokenForm.hidden = false;
    tokenInput.value = localStorage.getItem("comoteApiToken") ?? "";
    requestAnimationFrame(() => tokenInput.focus());
  } else {
    title.textContent = tWeb("web.loadError.connTitle");
    detail.textContent = tWeb("web.loadError.connDetail", { message: error?.message ?? "" });
    tokenForm.hidden = true;
  }
  panel.hidden = false;
}

function hideLoadError() {
  document.querySelector("#loadError").hidden = true;
  document.querySelector("#apiTokenForm").hidden = true;
}

function sectionError(message) {
  return `<li class="list-error"><strong>${escapeHtml(message)}</strong><div class="meta">${tWeb("web.sectionError.retryHint")}</div></li>`;
}


document.querySelector("#retryLoad").addEventListener("click", async () => {
  await render();
});

document.querySelector("#saveApiToken").addEventListener("click", async () => {
  const input = document.querySelector("#apiTokenInput");
  const token = input.value.trim();
  if (!token) {
    input.focus();
    return;
  }
  localStorage.setItem("comoteApiToken", token);
  await render();
});

document.querySelector("#apiTokenInput").addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.querySelector("#saveApiToken").click();
  }
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

// Channel bind/save buttons are handled by ONE delegated listener on the stable
// #channelCards container (setupChannelCards), wired once in init() — no
// per-card or per-channel listeners here.

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

function renderCodexNotice(desktop) {
  const state = desktop?.state ?? desktop;
  const notice = document.querySelector("#codexNotice");
  notice.hidden = state === "connected" || state === "available";
  if (notice.hidden) {
    return;
  }
  // Show the connector's real failure reason (e.g. "codex executable not
  // found at <path>") instead of only the generic install hint — the reason
  // is what tells the user which of the two fixes applies.
  const errorLine = document.querySelector("#codexNoticeError");
  const lastError = typeof desktop === "object" ? desktop?.lastError : null;
  errorLine.textContent = lastError ?? "";
  errorLine.hidden = !lastError;
  const commandLine = document.querySelector("#codexNoticeCommand");
  const command = typeof desktop === "object" ? desktop?.command : null;
  document.querySelector("#codexNoticeCommandText").textContent = command ?? "";
  commandLine.hidden = !command;
}

// --- Generic QR login: ONE poller for every qr-binding channel (replaces the
// per-channel wechat/feishu start + poll + view code). The backend now starts
// the runtime on confirm and is the single source of truth for the normalized
// {state}, so the frontend fires NO runtime/start and owns no confirm/failure
// vocabulary.

async function startQrLogin(ch) {
  // Rebind-while-polling: kill any running poll timer for this channel BEFORE we
  // overwrite activeLogin[ch.id] with a new object below — otherwise the prior
  // setInterval is orphaned and keeps firing /login/status forever.
  clearInterval(activeLogin[ch.id]?.pollTimer);
  const card = document.querySelector(`#channelCards article[data-channel="${cssEscapeId(ch.id)}"]`);
  const button = card?.querySelector("[data-bind]") ?? null;
  if (button) {
    button.disabled = true;
    button.textContent = tWeb("web.qr.generating");
  }
  // configFields values (feishu: { domain }; wechat: {}). Sent as the login body;
  // the backend takes what it needs and ignores the rest.
  const configValues = readChannelForm(ch.id);
  try {
    const start = await getJson(`/api/channels/${encodeURIComponent(ch.id)}/login/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configValues),
    });
    const startView = normalizedLoginView(start, tWeb);
    activeLogin[ch.id] = { loginId: start.loginId ?? null, startCtx: start, pollTimer: null, lastView: startView };
    renderQrInto(`${ch.id}LoginResult`, startView);
    pollQrLogin(ch, start);
  } catch (error) {
    delete activeLogin[ch.id];
    renderQrInto(`${ch.id}LoginResult`, { phase: "failed", qrUrl: null, accountLine: null, message: error.message });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = activeLogin[ch.id]
        ? tWeb("web.channel.refresh")
        : channelBoundButton(channelsById[ch.id] ?? ch, tWeb, { activeLoginId: null }).label;
    }
  }
}

function pollQrLogin(ch, startCtx) {
  clearInterval(activeLogin[ch.id]?.pollTimer);
  // Carry the start response's opaque fields back to /login/status; the backend
  // takes what it needs (feishu reads domain/interval/expireIn; wechat ignores them).
  const params = new URLSearchParams({ loginId: startCtx.loginId ?? "" });
  for (const k of ["domain", "interval", "expireIn"]) {
    if (startCtx[k] != null) {
      params.set(k, startCtx[k]);
    }
  }
  activeLogin[ch.id].pollTimer = setInterval(async () => {
    try {
      const status = await getJson(`/api/channels/${encodeURIComponent(ch.id)}/login/status?${params}`);
      const view = normalizedLoginView(status, tWeb);
      // Keep the QR image visible while waiting — status responses for pending
      // states omit qrUrl, so fall back to the one from /login/start.
      if (!view.qrUrl) {
        view.qrUrl = startCtx.qrUrl ?? null;
      }
      // Remember the live view so a full #channelCards re-render (5s auto-refresh)
      // can immediately repaint this in-flight QR instead of the static placeholder.
      if (activeLogin[ch.id]) {
        activeLogin[ch.id].lastView = view;
      }
      renderQrInto(`${ch.id}LoginResult`, view);
      if (["confirmed", "expired", "failed"].includes(view.phase)) {
        clearInterval(activeLogin[ch.id].pollTimer);
        if (view.phase === "confirmed") {
          // Backend already started the runtime on confirm — just reload.
          delete activeLogin[ch.id];
          await render();
        } else {
          delete activeLogin[ch.id];
        }
      }
    } catch (error) {
      renderQrInto(`${ch.id}LoginResult`, {
        phase: "pending",
        qrUrl: startCtx.qrUrl ?? null,
        accountLine: null,
        message: tWeb("web.channel.qr.checkFailed", { message: error.message }),
      });
    }
  }, QR_POLL_MS);
}

async function startGlobalManagerQr() {
  clearInterval(globalManagerLogin?.pollTimer);
  const button = document.querySelector("#globalManagerBind");
  button.disabled = true;
  button.textContent = tWeb("web.qr.generating");
  const body = { domain: globalManagerSnapshot?.domain ?? "feishu" };
  try {
    const start = await getJson("/api/channels/feishu-global-manager/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const view = normalizedLoginView(start, tWeb);
    globalManagerLogin = { startCtx: start, lastView: view, pollTimer: null };
    document.querySelector("#globalManagerLoginResult").hidden = false;
    renderQrInto("globalManagerLoginResult", view);
    pollGlobalManagerQr(start);
  } catch (error) {
    globalManagerLogin = { lastView: { phase: "failed", qrUrl: null, accountLine: null, message: error.message }, pollTimer: null };
    document.querySelector("#globalManagerLoginResult").hidden = false;
    renderQrInto("globalManagerLoginResult", globalManagerLogin.lastView);
  } finally {
    button.disabled = false;
    button.textContent = tWeb("web.globalManager.bind");
  }
}

function pollGlobalManagerQr(startCtx) {
  const params = new URLSearchParams({ loginId: startCtx.loginId ?? "" });
  for (const key of ["domain", "interval", "expireIn"]) {
    if (startCtx[key] != null) params.set(key, startCtx[key]);
  }
  globalManagerLogin.pollTimer = setInterval(async () => {
    try {
      const status = await getJson(`/api/channels/feishu-global-manager/login/status?${params}`);
      const view = normalizedLoginView(status, tWeb);
      if (!view.qrUrl) view.qrUrl = startCtx.qrUrl ?? null;
      if (globalManagerLogin) globalManagerLogin.lastView = view;
      document.querySelector("#globalManagerLoginResult").hidden = false;
      renderQrInto("globalManagerLoginResult", view);
      if (!["confirmed", "expired", "failed"].includes(view.phase)) return;
      clearInterval(globalManagerLogin.pollTimer);
      if (view.phase === "confirmed") {
        globalManagerLogin = {
          lastView: {
            phase: "pending",
            qrUrl: null,
            accountLine: null,
            message: tWeb("web.globalManager.bindInChat"),
          },
          pollTimer: null,
        };
        renderQrInto("globalManagerLoginResult", globalManagerLogin.lastView);
        await render();
      }
    } catch (error) {
      if (globalManagerLogin) {
        globalManagerLogin.lastView = {
          phase: "pending",
          qrUrl: startCtx.qrUrl ?? null,
          accountLine: null,
          message: tWeb("web.channel.qr.checkFailed", { message: error.message }),
        };
        renderQrInto("globalManagerLoginResult", globalManagerLogin.lastView);
      }
    }
  }, QR_POLL_MS);
}

// Renders a normalized login view ({ phase, qrUrl, accountLine, message }) into a
// channel's `.qr-result` element. Reuses normalizeQrImageSource + qrDataUrl.
function renderQrInto(elId, view) {
  const target = document.getElementById(elId);
  if (!target) {
    return;
  }
  target.replaceChildren();
  target.className = "qr-result";

  if (view.phase === "empty") {
    target.append(createQrGlyph());
    target.append(createTextLine(view.message ?? tWeb("web.channel.qr.scanHint")));
    return;
  }
  if (view.phase === "confirmed") {
    target.append(createStrongLine(tWeb("web.channel.qr.confirmed")));
    if (view.accountLine) {
      target.append(createTextLine(view.accountLine));
    }
    if (view.message) {
      target.append(createTextLine(view.message));
    }
    return;
  }
  if (view.phase === "expired" || view.phase === "failed") {
    target.append(createStrongLine(tWeb("web.qr.needRebind")));
    target.append(createTextLine(view.message ?? tWeb(`web.channel.qr.${view.phase}`)));
    return;
  }

  // pending / scanned: show the QR image when available, otherwise the hint glyph.
  const imageSource = normalizeQrImageSource(view.qrUrl);
  if (!imageSource) {
    target.append(createQrGlyph());
    target.append(createTextLine(view.message ?? tWeb("web.channel.qr.scanHint")));
    return;
  }
  target.classList.add("has-qr");
  const image = document.createElement("img");
  image.src = imageSource;
  image.alt = tWeb("web.channel.qr.imageAlt");
  target.append(image);
  const scanHint = tWeb("web.channel.qr.scanHint");
  target.append(createStrongLine(scanHint));
  if (view.message && view.message !== scanHint) {
    target.append(createTextLine(view.message));
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

// D-3: prefer the registry's displayName (available for every channel, kept in
// channelsById by renderOnce) so dingtalk/telegram identities don't show a bare
// channel id. The wechat/feishu dictionary names remain as a fallback for the
// window before the first /api/channels response lands.
function channelName(channel) {
  const meta = channelsById[channel];
  if (meta?.displayName) return meta.displayName;
  if (channel === "wechat") return tWeb("web.channelName.wechat");
  if (channel === "feishu") return tWeb("web.channelName.feishu");
  return channel;
}

function roleName(role) {
  if (role === "owner") return tWeb("web.role.owner");
  if (role === "member") return tWeb("web.role.member");
  return role;
}

function humanConnectorState(state) {
  if (state === "connected") return tWeb("web.connector.connected");
  if (state === "available") return tWeb("web.connector.available");
  return tWeb("web.connector.disconnected");
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

  function activate(sectionId) {
    for (const item of navItems) {
      item.classList.toggle("active", item.getAttribute("href") === `#${sectionId}`);
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

// Persist a panel's current state into the module caches so a subsequent 5s
// repaint restores it. Invalidates the paint signature so the change is not
// skipped on the next render.
function rememberThreadDetail(row, panel) {
  const threadId = row?.dataset?.threadId;
  if (!threadId || !panel) {
    return;
  }
  if (panel.hidden) {
    expandedThreadIds.delete(threadId);
  } else {
    expandedThreadIds.add(threadId);
    threadDetailCache.set(threadId, {
      html: panel.innerHTML,
      offset: panel.dataset.offset ?? "0",
      loaded: panel.dataset.loaded ?? "",
      total: panel.dataset.total ?? "0",
    });
  }
  lastThreadSignature = null;
}

// D-5: switching the project re-fetches the thread list from page one.
document.querySelector("#threadsProjectSelect")?.addEventListener("change", async (event) => {
  threadsProjectPath = event.target.value || null;
  // Invalidate the loaded list so renderThreads treats this as a project switch.
  threadsLoadedProject = null;
  await render();
});

// E-5: append the next (older) page using the server's nextCursor.
document.querySelector("#threadsLoadMore")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!threadsCursor || !threadsLoadedProject || button.disabled) {
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = tWeb("web.threads.loading");
  // Capture which project this request belongs to: if the user switches
  // projects while the request is in flight, the stale response must be
  // dropped, not appended to the new project's list.
  const requestedPath = threadsLoadedProject.path;
  try {
    const result = await safeGet(threadsUrl(requestedPath, threadsCursor), null);
    if (threadsLoadedProject?.path !== requestedPath) {
      return;
    }
    if (result.ok && result.value) {
      const page = result.value?.data ?? result.value?.threads ?? [];
      const known = new Set(threadsItems.map(threadKey));
      threadsItems = [...threadsItems, ...page.filter((thread) => !known.has(threadKey(thread)))];
      // An empty page means the cursor is exhausted regardless of what the
      // server echoes back — otherwise trust its nextCursor.
      threadsCursor = page.length > 0 ? result.value?.nextCursor ?? null : null;
      threadsPagedBeyondFirst = true;
      paintThreads(threadsItems, threadsLoadedProject);
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
    updateThreadsFooter();
  }
});

// E-7: thread rows are rendered as role="button" focusable rows; Enter/Space
// must toggle them exactly like a click. Clicks inside the detail panel are
// excluded, mirroring the click handler below.
document.querySelector("#threads").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const row = event.target.closest("li[data-thread-id]");
  if (!row || event.target.closest(".thread-detail")) {
    return;
  }
  event.preventDefault(); // keep Space from scrolling the page
  row.click();
});

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
    // Share the per-panel mutex with the 5s refresh: if a refresh is already
    // appending to this panel, ignore the click so the two don't interleave
    // read-modify-writes on offset/total/DOM.
    if (shouldSkipPanelRefresh(panel)) {
      return;
    }
    const threadId = row.dataset.threadId;
    panel.dataset.refreshing = "1";
    try {
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
      if (nextResult.value.total != null) {
        panel.dataset.total = String(nextResult.value.total);
      }
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
      rememberThreadDetail(row, panel);
    } finally {
      delete panel.dataset.refreshing;
    }
    return;
  }

  const panel = row.querySelector(".thread-detail");
  if (!panel) {
    return;
  }
  const isExpanded = !panel.hidden;
  panel.hidden = isExpanded;
  row.setAttribute("aria-expanded", String(!panel.hidden));
  if (isExpanded) {
    rememberThreadDetail(row, panel);
    return;
  }
  // First expand — check if already loaded
  if (panel.dataset.loaded === "1") {
    rememberThreadDetail(row, panel);
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
    rememberThreadDetail(row, panel);
    return;
  }
  const messages = (firstResult.value.messages ?? []).slice().reverse();
  const hasMore = firstResult.value.hasMore ?? false;
  panel.dataset.offset = String(messages.length);
  // Total message count seen at expand time; the 5s refresh compares against
  // this to detect (and append) only the genuinely new messages.
  panel.dataset.total = String(firstResult.value.total ?? messages.length);
  if (messages.length === 0) {
    panel.innerHTML = `<div class="meta">${tWeb("web.threads.noLocal")}</div>`;
    rememberThreadDetail(row, panel);
    return;
  }
  // E-4: transcripts served from the connector's thread/read fallback (rather
  // than Comote's own relay transcript) get a small origin annotation.
  const sourceNote = firstResult.value.source === "desktop"
    ? `<div class="meta thread-source">${tWeb("web.threads.sourceDesktop")}</div>`
    : "";
  let html = sourceNote + renderThreadMessages(messages);
  if (hasMore) {
    html += `<button class="secondary-button thread-load-more-btn">${tWeb("web.threads.loadMore")}</button>`;
  }
  panel.innerHTML = html;
  rememberThreadDetail(row, panel);
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

// Map the OS/browser language to a supported UI locale. Unmatched → English
// (the most universal fallback for an international audience), NOT zh.
function mapSystemLocale(navLang) {
  const primary = String(navLang || "").toLowerCase().split("-")[0];
  return WEB_LOCALES.includes(primary) ? primary : "en";
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
  // Re-render the version banner too: it sets some strings dynamically (e.g. the
  // Linux npm-command hint) that applyTranslations would otherwise revert.
  await refreshVersionStatus().catch(() => {});
  await render(); // re-run the main render so dynamic tWeb() strings update
}

async function init() {
  setupNavigation();
  setupChannelCards();
  setBridgeStatus(tWeb("web.status.starting"));
  const settings = await safeGet("/api/settings", { locale: "zh", supported: ["zh"], localeExplicit: true });
  let locale = settings.value?.locale ?? "zh";
  // First launch (no committed locale): follow the OS language, English if unmatched,
  // and persist the choice so subsequent launches respect it (and a manual switch).
  if (!settings.value?.localeExplicit) {
    const sys = mapSystemLocale(navigator.language || navigator.languages?.[0]);
    if (sys !== locale) {
      locale = sys;
      try {
        await getJson("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale }),
        });
      } catch {
        // still apply locally even if persisting failed
      }
    }
  }
  setWebLocale(locale);
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
      const suffixEl = document.querySelector("#updateCurrentSuffix");
      const commandLine = document.querySelector("#updateCommandLine");
      const commandText = document.querySelector("#updateCommandText");
      if (latestEl) latestEl.textContent = data.latest;
      if (currentEl) currentEl.textContent = current ?? tWeb("web.version.unknown");
      // Linux installs come from npm: render a copy-pasteable command instead of
      // a download link (CI ships no Linux asset). mac/win keep the link.
      if (data.updateCommand) {
        if (linkEl) linkEl.hidden = true;
        if (suffixEl) suffixEl.textContent = tWeb("web.update.currentSuffixNpm");
        if (commandText) commandText.textContent = data.updateCommand;
        if (commandLine) commandLine.hidden = false;
      } else {
        if (commandLine) commandLine.hidden = true;
        if (linkEl) {
          linkEl.hidden = false;
          linkEl.href = data.downloadUrl ?? data.releaseUrl ?? "https://github.com/GavinYangAI/comote/releases";
        }
        if (suffixEl) suffixEl.textContent = tWeb("web.update.currentSuffix");
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

document.querySelector("#globalManagerBind")?.addEventListener("click", async () => {
  if (globalManagerSnapshot?.configured) {
    window.alert(tWeb("web.globalManager.bindInChat"));
    return;
  }
  await startGlobalManagerQr();
});

document.querySelector("#globalManagerTest")?.addEventListener("click", async () => {
  const result = await guardedAction(() => getJson("/api/global-manager/test", { method: "POST" }));
  if (result) window.alert(tWeb("web.globalManager.testSent"));
  await render();
});

document.querySelector("#globalManagerUnbind")?.addEventListener("click", async () => {
  if (!window.confirm(tWeb("web.globalManager.unbindConfirm"))) return;
  const result = await guardedAction(() => getJson("/api/global-manager", { method: "DELETE" }));
  if (result) await render();
});

document.querySelector("#globalManagerRescan")?.addEventListener("click", async () => {
  await startGlobalManagerQr();
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

setupKeepAliveToggle().catch((error) => console.error(error));
setupLaunchAtLoginToggle().catch((error) => console.error(error));
