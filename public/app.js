import { qrDataUrl } from "./qr-code.js";
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

// Generic per-channel login state: id -> { loginId, pollTimer, startCtx }.
const activeLogin = {};
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
    approvals,
    logs,
  ] = await Promise.all([
    safeGet("/api/status", null),
    safeGet("/api/identities", []),
    safeGet("/api/identities/candidates", []),
    safeGet("/api/projects", []),
    safeGet("/api/channels", []),
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

  renderReadiness(status.value, identities, channels);
  renderIdentities(identities);
  renderCandidates(candidates);
  renderProjects(projects);
  renderChannels(channels);
  renderChannelDropdown(channels);
  renderApprovals(approvals);
  renderLogs(logs);
  renderConversation(transcript);
  await renderThreads(status.value, projects.value);
}

function renderReadiness(status, identitiesResult, channels) {
  const section = document.querySelector("#readiness");
  const list = document.querySelector("#readinessList");
  const identities = identitiesResult.ok ? identitiesResult.value : [];
  const desktopState = status?.connectors?.desktop?.state;
  const { bound, running } = readinessFromChannels(channels);

  const items = [
    {
      done: desktopState === "connected" || desktopState === "available",
      label: tWeb("web.readiness.step1.label"),
    },
    {
      done: bound,
      label: tWeb("web.readiness.step2.label"),
    },
    {
      done: identities.length > 0,
      label: tWeb("web.readiness.step3.label"),
    },
    {
      done: running,
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
      await guardedAction(() =>
        getJson(`/api/channels/${encodeURIComponent(id)}/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(readChannelForm(id)),
        }),
      );
      await render();
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
  const badgeClass = `badge${pending ? " pending" : badge.tone === "success" ? " success" : badge.tone === "warning" ? " warning" : ""}`;
  const icon = ch.icon ?? (ch.displayName ?? "")[0] ?? "";
  const summary = channelSummaryLine(ch, tWeb);
  const expanded = expandedChannelId === ch.id;
  const toggleLabel = expanded ? tWeb("web.channel.collapse") : tWeb("web.channel.manage");
  return `
    <article class="channel-row ${expanded ? "expanded" : ""}" data-channel="${escapeAttr(ch.id)}">
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
  const desc = ch.descriptionKey ? tWeb(ch.descriptionKey) : "";
  if (expanded) {
    return `<article class="channel-add-tile expanded" data-channel="${escapeAttr(ch.id)}">
      <div class="channel-row-head" data-toggle="${escapeAttr(ch.id)}" style="padding:0 0 8px">
        <div class="channel-tile ${escapeAttr(ch.id)}-icon" aria-hidden="true">${escapeHtml(icon)}</div>
        <div class="ch-name">${escapeHtml(ch.displayName ?? ch.id)}</div>
        <button type="button" class="secondary-button" data-toggle="${escapeAttr(ch.id)}" style="margin-left:auto">${escapeHtml(tWeb("web.channel.collapse"))} ▴</button>
      </div>
      ${channelDetailHtml(ch)}</article>`;
  }
  return `<article class="channel-add-tile" data-channel="${escapeAttr(ch.id)}">
    <div class="channel-tile ${escapeAttr(ch.id)}-icon" aria-hidden="true">${escapeHtml(icon)}</div>
    <div class="ch-name">${escapeHtml(ch.displayName ?? ch.id)}</div>
    <div class="ch-sub">${escapeHtml(desc)}</div>
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
    affHtml = qrAreaHtml(ch); // the <id>LoginResult scan area, painted by paintChannelCardResting
  }
  // bound qr channel: still show its resting QR area (account summary) on expand
  const qrResting = ch.binding === "qr" && !aff ? qrAreaHtml(ch) : "";
  const rows = channelRows(ch, tWeb).map((r) => `<dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd>`).join("");
  const setup = channelSetup(ch, tWeb);
  const setupHtml = setup ? `<details class="channel-setup"><summary>${escapeHtml(tWeb("web.channel.howTo"))} ▸</summary><ol>${setup.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>${setup.link ? `<a href="${escapeAttr(setup.link.url)}" target="_blank" rel="noopener">↗ ${escapeHtml(setup.link.label)}</a>` : ""}</details>` : "";
  const button = channelBoundButton(ch, tWeb, { activeLoginId: activeLogin[ch.id]?.loginId ?? null });
  const actionBtn = ch.binding === "qr"
    ? `<button type="button" class="btn-primary-card" data-bind="${escapeAttr(ch.id)}">${escapeHtml(button.label)}</button>`
    : `<button type="button" class="btn-primary-card" data-save-config="${escapeAttr(ch.id)}">${escapeHtml(tWeb("web.channel.save"))}</button>`;
  return `${affHtml}${qrResting}${rows ? `<dl class="kv status-rows">${rows}</dl>` : ""}${channelConfigFormHtml(ch)}${setupHtml}<div class="actions card-actions">${actionBtn}</div>`;
}

// The qr scan area (extracted from the old channelCardHtml qr branch) so both the
// pending-scan affordance and a bound qr channel's resting summary can render it.
function qrAreaHtml(ch) {
  return `<div id="${escapeAttr(ch.id)}LoginResult" class="qr-result">
    <div class="qr-glyph"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#c4c2bc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-7M17 21v-4"/></svg></div>
    <span>${escapeHtml(tWeb("web.channel.qr.scanHint"))}</span>
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
      if (field.type === "select") {
        const options = field.options
          .map((opt) => `<option value="${escapeAttr(opt.value)}"${String(opt.value) === String(field.value) ? " selected" : ""}>${escapeHtml(opt.label)}</option>`)
          .join("");
        return `<div class="config-field"><label class="domain-label">${escapeHtml(field.label)}</label><label class="select-wrap"><select name="${escapeAttr(field.name)}">${options}</select></label></div>`;
      }
      if (field.type === "checkbox") {
        return `<label class="config-field"><input name="${escapeAttr(field.name)}" type="checkbox"${field.value ? " checked" : ""}> <span>${escapeHtml(field.label)}</span></label>`;
      }
      const inputType = field.secret || field.type === "password" ? "password" : "text";
      return `<div class="config-field"><label class="domain-label">${escapeHtml(field.label)}</label><input name="${escapeAttr(field.name)}" type="${inputType}" value="${escapeAttr(field.value ?? "")}"></div>`;
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

function renderCodexNotice(state) {
  const notice = document.querySelector("#codexNotice");
  notice.hidden = state === "connected" || state === "available";
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
  target.append(createStrongLine(tWeb("web.channel.qr.scanHint")));
  if (view.message) {
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
  setupChannelCards();
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
