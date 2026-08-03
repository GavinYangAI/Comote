import { describeIdentity } from "./authorization.js";
import { normalizeChannelMessage } from "./channel.js";
import { t } from "./i18n/index.js";
import { classifyMedia, resolveWithinProject } from "./paths.js";
import { buildFileDeliveries } from "./file-delivery.js";
import { scanLocalProjects as defaultScanLocalProjects } from "./local-projects.js";

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

// Upper bound for the one-time-message identity sets (welcome card /
// unauthorized notice). They persist across restarts, so cap them and evict
// oldest-first rather than letting a scan of random strangers grow the state
// file forever. Worst case an evicted identity sees the notice once more.
const MAX_REMEMBERED_IDENTITIES = 500;
const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high"];
const MODEL_PICKER_TYPES = new Set(["choose_model", "choose_reasoning"]);

// Adds `key` to a Set that behaves as a FIFO of at most
// MAX_REMEMBERED_IDENTITIES entries (Sets iterate in insertion order).
function rememberIdentity(set, key) {
  set.add(key);
  while (set.size > MAX_REMEMBERED_IDENTITIES) {
    set.delete(set.values().next().value);
  }
}

export class CommandRouter {
  constructor({
    authorization,
    projects,
    sessions,
    codexDesktop = null,
    codexCli = null,
    outboundQueue = null,
    persist = null,
    persisted = {},
    maxTurnsPerHour = 60,
    transcript = null,
    scanLocalProjects = defaultScanLocalProjects,
    getPreferredConnector = null,
  }) {
    this.authorization = authorization;
    this.projects = projects;
    this.sessions = sessions;
    this.codexDesktop = codexDesktop;
    this.codexCli = codexCli;
    this.outboundQueue = outboundQueue;
    this.persist = typeof persist === "function" ? persist : null;
    this.transcript = transcript;
    this.getPreferredConnector = typeof getPreferredConnector === "function"
      ? getPreferredConnector
      : () => "desktop";
    // Headless/Linux fallback project source: enumerates folders under a root
    // when there is no Codex Desktop to list workspaces. Injectable for tests.
    this.scanLocalProjects = scanLocalProjects;
    // Routing state is restored from disk so a daemon restart does not lose
    // the phone user's current project / session context.
    this.currentProjectByIdentity = new Map(persisted.currentProjectByIdentity ?? []);
    this.lastProjectsByIdentity = new Map();
    this.pendingByIdentity = new Map();
    // identityKey -> { channel, conversationId, accountId }
    this.conversationByIdentity = new Map(persisted.conversationByIdentity ?? []);
    // Codex threadId -> conversation, so the return path can find the chat.
    this.threadBindings = new Map(persisted.threadBindings ?? []);
    // Codex threadId -> the latest model/reasoning settings observed from the
    // app-server or selected through /model. This is persisted so a restarted
    // daemon can still annotate live cards before the next resume call.
    this.threadSettingsById = new Map(persisted.threadSettingsById ?? []);
    // Cost guard: identityKey -> array of turn-start epoch ms.
    this.maxTurnsPerHour = maxTurnsPerHour;
    this.turnTimestamps = new Map();
    // identityKey sets for one-time first-contact messaging. Persisted (capped)
    // so a daemon restart does not replay the welcome card / unauthorized
    // notice to everyone who already saw it.
    this.noticedIdentities = new Set((persisted.noticedIdentities ?? []).slice(-MAX_REMEMBERED_IDENTITIES));
    this.greetedIdentities = new Set((persisted.greetedIdentities ?? []).slice(-MAX_REMEMBERED_IDENTITIES));
  }

  preferredConnector() {
    return this.getPreferredConnector() === "cli" ? "cli" : "desktop";
  }

  isDesktopAvailable() {
    return this.codexDesktop?.getStatus?.().state === "connected";
  }

  isCliAvailable() {
    if (!this.codexCli?.runPrompt) {
      return false;
    }
    return this.codexCli.getStatus?.().state !== "not_found";
  }

  connectorForNextSession() {
    if (this.preferredConnector() === "cli" && this.isCliAvailable()) {
      return "cli";
    }
    if (this.isDesktopAvailable()) {
      return "desktop";
    }
    return this.isCliAvailable() ? "cli" : null;
  }

  // Serializable routing state for persistence. Transient UI state
  // (pending prompts, last project list) is intentionally not persisted.
  snapshot() {
    return {
      currentProjectByIdentity: [...this.currentProjectByIdentity],
      conversationByIdentity: [...this.conversationByIdentity],
      threadBindings: [...this.threadBindings],
      threadSettingsById: [...this.threadSettingsById],
      noticedIdentities: [...this.noticedIdentities],
      greetedIdentities: [...this.greetedIdentities],
    };
  }

  // Throws a user-facing error when an identity exceeds its hourly turn budget,
  // otherwise reserves one unit of quota. The reservation is tentative: callers
  // MUST refundTurnStart() if the turn fails to actually start, so a turn that
  // never reaches Codex (e.g. desktop disconnected) does not burn the user's
  // hourly budget. The timestamp returned identifies this reservation so the
  // refund removes exactly the unit that was reserved.
  enforceTurnRate(identity) {
    const key = this.identityKey(identity);
    const now = Date.now();
    const windowStart = now - 3600_000;
    const recent = (this.turnTimestamps.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= this.maxTurnsPerHour) {
      throw new Error(t("cmd.rate.limit", { max: this.maxTurnsPerHour }));
    }
    recent.push(now);
    this.turnTimestamps.set(key, recent);
    return now;
  }

  // Refunds a reservation made by enforceTurnRate when the turn failed to start.
  // `reservation` is the timestamp enforceTurnRate returned; if omitted, the most
  // recent reservation for the identity is dropped.
  refundTurnStart(identity, reservation = null) {
    const key = this.identityKey(identity);
    const recent = this.turnTimestamps.get(key);
    if (!recent || recent.length === 0) {
      return;
    }
    const index = reservation == null ? recent.length - 1 : recent.lastIndexOf(reservation);
    if (index >= 0) {
      recent.splice(index, 1);
    }
    this.turnTimestamps.set(key, recent);
  }

  bindThreadForIdentity(identity, threadId, projectPath = null) {
    if (!threadId) {
      return;
    }
    const conversation = this.conversationByIdentity.get(this.identityKey(identity));
    if (conversation) {
      // Record the initiating identity's stableId so channel card buttons
      // (Feishu cancel/pushfile) can verify the clicker owns the thread and a
      // different group member cannot act on another user's live card.
      this.threadBindings.set(threadId, {
        ...conversation,
        projectPath: projectPath ?? null,
        ownerStableId: identity?.stableId ?? null,
      });
    }
  }

  getThreadBinding(threadId) {
    return this.threadBindings.get(threadId) ?? null;
  }

  handleMessage(rawMessage) {
    const message = normalizeChannelMessage(rawMessage);
    if (!this.authorization.isAuthorized(message.identity)) {
      return this.deniedReply();
    }

    const [command, ...args] = message.text.split(/\s+/);
    const rest = args.join(" ").trim();

    try {
      switch (command) {
        case "/help":
          return this.text(this.helpText());
        case "/status":
          return this.text(this.statusText(message.identity));
        case "/current":
          return this.text(this.statusText(message.identity));
        case "/projects":
          return this.text(this.projectsText());
        case "/open":
          return this.text(this.openProject(message.identity, rest));
        case "/sessions":
          return this.text(this.sessionsText(message.identity));
        case "/use":
          return this.text(this.useSession(message.identity, rest));
        case "/switch":
          return this.text(this.useSession(message.identity, rest));
        case "/tail":
          return this.text(this.tailText(message.identity, rest));
        case "/new":
          return this.text(this.newSession(message.identity, rest));
        default:
          // A mistyped slash command gets a short nudge toward /help instead of
          // the full help wall; anything else falls back to the catalog.
          if (command.startsWith("/")) {
            return this.text(this.unknownCommandText(command));
          }
          return this.text(this.helpText());
      }
    } catch (error) {
      return { kind: "error", text: error.message };
    }
  }

  async handleMessageAsync(rawMessage) {
    const message = normalizeChannelMessage(rawMessage);
    const key = this.identityKey(message.identity);
    if (!this.authorization.isAuthorized(message.identity)) {
      if (!this.noticedIdentities.has(key)) {
        rememberIdentity(this.noticedIdentities, key);
        return { kind: "notice", text: this.unauthorizedNoticeText() };
      }
      return this.deniedReply();
    }
    const reply = await this.dispatchAuthorizedMessage(message);
    const output = !this.greetedIdentities.has(key)
      ? (() => {
          rememberIdentity(this.greetedIdentities, key);
          return this.prependWelcome(reply);
        })()
      : reply;
    const startedThreadId = this.startedDesktopThreadForReply(message.identity, reply);
    if (startedThreadId && output && typeof output === "object") {
      // Runtime-only routing metadata: non-enumerable so the public command
      // reply contract and persisted/outbound semantic shape stay unchanged.
      Object.defineProperty(output, "startedThreadId", {
        value: startedThreadId,
        enumerable: false,
        configurable: true,
      });
    }
    return output;
  }

  startedDesktopThreadForReply(identity, reply) {
    if (!reply || typeof reply.text !== "string") return null;
    const key = this.identityKey(identity);
    const projectPath = this.currentProjectByIdentity.get(key);
    if (!projectPath) return null;
    const active = this.sessions.getActiveSession(projectPath, key);
    if (!active) return null;
    const connector = active.connector
      ?? (String(active.id).startsWith("cli_") ? "cli" : "desktop");
    if (connector !== "desktop") return null;
    const submitted = reply.text === t("cmd.send.processing", { id: active.id })
      || reply.text === t("cmd.new.sentDesktop", { id: active.id });
    return submitted ? active.id : null;
  }

  async dispatchAuthorizedMessage(message) {
    if (message.conversation) {
      this.conversationByIdentity.set(this.identityKey(message.identity), message.conversation);
    }

    const [command, ...args] = message.text.split(/\s+/);
    const rest = args.join(" ").trim();

    try {
      if (command === "/sessions") {
        return await this.sessionsTextAsync(message.identity, { choose: true });
      }
      if (command === "/projects") {
        return await this.projectsTextAsync(message.identity);
      }
      if (command === "/open") {
        return await this.openProjectAsync(message.identity, rest);
      }
      if (command === "/new") {
        return this.text(await this.newSessionAsync(message.identity, rest));
      }
      if (command === "/use") {
        return this.text(await this.useSessionAsync(message.identity, rest));
      }
      if (command === "/switch") {
        return this.text(await this.useSessionAsync(message.identity, rest));
      }
      if (command === "/current") {
        return this.text(this.statusText(message.identity));
      }
      if (command === "/tail") {
        return this.text(await this.tailTextAsync(message.identity, rest));
      }
      if (command === "/file") {
        return await this.handleFileCommand(message.identity, rest);
      }
      if (command === "/automode") {
        return this.text(await this.setAutoModeAsync(message.identity, rest));
      }
      if (command === "/model") {
        return await this.modelTextAsync(message.identity);
      }
      if (command === "/cancel") {
        // While a picker is open, /cancel is the escape hatch out of the
        // selection state (B-10); only otherwise does it cancel a Codex turn.
        const pendingKey = this.identityKey(message.identity);
        const pending = this.pendingByIdentity.get(pendingKey);
        if (pending?.type === "choose_project"
          || pending?.type === "choose_session"
          || MODEL_PICKER_TYPES.has(pending?.type)) {
          this.pendingByIdentity.delete(pendingKey);
          return this.text(t("cmd.picker.cancelled"));
        }
        return this.text(await this.cancelActiveTurn(message.identity));
      }
      if (command === "/approve") {
        return this.approvalResolution(await this.resolveApproval(rest, "accept", message.identity));
      }
      if (command === "/deny") {
        return this.approvalResolution(await this.resolveApproval(rest, "decline", message.identity));
      }
      if (!command.startsWith("/")) {
        return await this.handlePlainText(message.identity, message.text, message.attachments);
      }
      // A leading-slash command that matched none of the async handlers above is
      // an unknown command: nudge toward /help instead of silently routing it or
      // dumping the whole catalog. (/help, /status, etc. are served by the sync
      // switch below, so only genuinely-unknown slashes reach the nudge there.)
      // handleMessage re-normalizes; normalizeChannelMessage is idempotent.
      return this.handleMessage(message);
    } catch (error) {
      return { kind: "error", text: error.message };
    }
  }

  unauthorizedNoticeText() {
    return [
      t("cmd.auth.noticeIntro"),
      t("cmd.auth.noticePending"),
      t("cmd.auth.noticeAction"),
    ].join("\n");
  }

  deniedReply() {
    return {
      kind: "denied",
      text: t("cmd.auth.denied"),
    };
  }

  // A short nudge for a mistyped /slash command. Keeps the signal that the
  // command was wrong without re-printing the full help body every time.
  unknownCommandText(command) {
    return t("cmd.unknown.nudge", { command });
  }

  // The one-time onboarding card shown on an identity's first authorized
  // message. Deliberately NOT the full 13-line catalog: a "you're connected"
  // line, the handful of highest-value commands, and how to start a turn (just
  // type). For Feishu/钉钉/微信 — which have no native command menu — this is the
  // primary command-discovery surface, so it must stay short and scannable.
  welcomeText() {
    return [
      t("cmd.welcome.title"),
      t("cmd.welcome.intro"),
      "",
      t("cmd.welcome.topCommands"),
      "",
      t("cmd.welcome.howToTalk"),
    ].join("\n");
  }

  prependWelcome(reply) {
    const banner = this.welcomeText();
    if (reply && typeof reply.text === "string" && reply.text) {
      return { ...reply, text: `${banner}\n\n${reply.text}` };
    }
    return { kind: "text", text: banner };
  }

  text(text) {
    return { kind: "text", text };
  }

  approvalResolution(text) {
    const reply = this.text(text);
    Object.defineProperty(reply, "approvalResolution", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    return reply;
  }

  // A text reply that also describes a clickable picker. Channels that render
  // cards (Feishu) turn `picker` into buttons; others fall back to `text`.
  picker(text, { pickKind, items }) {
    return { kind: "text", text, picker: { pickKind, items } };
  }

  async cancelThread(threadId) {
    if (!threadId) {
      throw new Error("threadId is required");
    }
    if (!this.codexDesktop?.cancelTurn) {
      throw new Error(t("cmd.cancel.unavailable"));
    }
    await this.codexDesktop.cancelTurn({ threadId });
    return { ok: true };
  }

  identityKey(identity) {
    return `${identity.channel}:${identity.stableId}`;
  }

  helpText() {
    return [t("cmd.help.title"), t("cmd.help.body"), t("cmd.model.help")].join("\n");
  }

  statusText(identity) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    const activeSession = projectPath
      ? this.sessions.getActiveSession(projectPath, this.identityKey(identity))
      : null;
    return [
      t("cmd.status.title"),
      t("cmd.status.user", { user: describeIdentity(identity) }),
      t("cmd.status.project", { project: projectPath ?? t("cmd.status.none") }),
      t("cmd.status.session", { session: activeSession?.title ?? t("cmd.status.none") }),
    ].join("\n");
  }

  async setAutoModeAsync(identity, value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== "true" && normalized !== "false") {
      throw new Error(t("cmd.automode.usage"));
    }
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    if (!this.codexDesktop?.updateThreadSettings) {
      throw new Error(t("cmd.approve.unavailable"));
    }

    const enabled = normalized === "true";
    await this.resumeDesktopThread(activeSession.id, projectPath);
    await this.codexDesktop.updateThreadSettings({
      threadId: activeSession.id,
      approvalsReviewer: enabled ? "auto_review" : "user",
    });
    return t(enabled ? "cmd.automode.enabled" : "cmd.automode.disabled", { id: activeSession.id });
  }

  getThreadSettings(threadId) {
    const settings = this.threadSettingsById.get(threadId);
    return settings ? { ...settings } : null;
  }

  rememberThreadSettings(threadId, ...responses) {
    if (!threadId) {
      return null;
    }
    const sources = responses.flatMap((response) => [response?.thread, response]).filter(Boolean);
    const current = this.threadSettingsById.get(threadId) ?? {};
    const next = { ...current };
    const model = firstStringSetting(sources, ["model", "modelId", "model_id"]);
    const reasoningEffort = firstDefinedSetting(sources, [
      "reasoningEffort",
      "reasoning_effort",
    ]);
    if (typeof model === "string" && model.trim()) {
      next.model = model.trim();
    }
    if (reasoningEffort !== undefined) {
      next.reasoningEffort = typeof reasoningEffort === "string"
        ? reasoningEffort.trim() || null
        : reasoningEffort;
    }
    if (next.model === undefined && next.reasoningEffort === undefined) {
      return current.model || next.reasoningEffort !== undefined ? next : null;
    }
    this.threadSettingsById.set(threadId, next);
    return { ...next };
  }

  async modelTextAsync(identity) {
    const { projectPath, activeSession } = this.requireModelSession(identity);
    const resumed = await this.resumeDesktopThread(activeSession.id, projectPath);
    const current = this.rememberThreadSettings(activeSession.id, resumed, activeSession)
      ?? this.getThreadSettings(activeSession.id)
      ?? {};
    let models = [];
    if (this.codexDesktop?.listModels) {
      try {
        models = normalizeModelOptions(await this.codexDesktop.listModels());
      } catch (error) {
        if (!isMethodMissingError(error)) {
          throw error;
        }
      }
    }
    if (models.length === 0 && current.model) {
      models = [{
        value: current.model,
        label: current.model,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
      }];
    }
    if (models.length === 0) {
      throw new Error(t("cmd.model.unavailable"));
    }
    const items = models.map((model, index) => ({
      label: model.label,
      index: String(index + 1),
    }));
    const key = this.identityKey(identity);
    this.pendingByIdentity.set(key, {
      type: "choose_model",
      projectPath,
      threadId: activeSession.id,
      models,
      current,
    });
    const currentLine = formatCurrentModelSettings(current);
    const text = [
      t("cmd.model.choose"),
      currentLine,
      models.map((model, index) => `${index + 1}. ${model.label}`).join("\n"),
      t("cmd.model.replyNumber"),
    ].filter(Boolean).join("\n\n");
    return this.picker(text, { pickKind: "model", items });
  }

  async chooseModel(identity, selector) {
    const key = this.identityKey(identity);
    const pending = this.pendingByIdentity.get(key);
    if (pending?.type !== "choose_model") {
      return this.text(t("cmd.model.expired"));
    }
    const model = pending.models[Number(selector) - 1];
    if (!model || String(Number(selector)) !== String(selector)) {
      return this.text(`${t("cmd.model.notFound")}\n${t("cmd.model.replyNumber")}`);
    }
    const efforts = model.reasoningEfforts.length > 0
      ? model.reasoningEfforts
      : normalizeReasoningOptions([
          pending.current?.model === model.value ? pending.current.reasoningEffort : null,
          model.defaultReasoningEffort,
          ...DEFAULT_REASONING_EFFORTS,
        ]);
    const items = efforts.map((effort, index) => ({
      label: effort.label,
      index: String(index + 1),
    }));
    this.pendingByIdentity.set(key, {
      type: "choose_reasoning",
      projectPath: pending.projectPath,
      threadId: pending.threadId,
      model,
      reasoningEfforts: efforts,
    });
    const text = [
      t("cmd.model.selected", { model: model.label }),
      t("cmd.model.chooseReasoning"),
      efforts.map((effort, index) => `${index + 1}. ${effort.label}`).join("\n"),
      t("cmd.model.replyNumber"),
    ].join("\n\n");
    return this.picker(text, { pickKind: "reasoning", items });
  }

  async chooseReasoning(identity, selector) {
    const key = this.identityKey(identity);
    const pending = this.pendingByIdentity.get(key);
    if (pending?.type !== "choose_reasoning") {
      return this.text(t("cmd.model.expired"));
    }
    const effort = pending.reasoningEfforts[Number(selector) - 1];
    if (!effort || String(Number(selector)) !== String(selector)) {
      return this.text(`${t("cmd.model.notFound")}\n${t("cmd.model.replyNumber")}`);
    }
    await this.resumeDesktopThread(pending.threadId, pending.projectPath);
    await this.codexDesktop.updateThreadSettings({
      threadId: pending.threadId,
      model: pending.model.value,
      reasoningEffort: effort.value,
    });
    this.rememberThreadSettings(pending.threadId, {
      model: pending.model.value,
      reasoningEffort: effort.value,
    });
    void Promise.resolve(this.persist?.()).catch(() => {});
    this.pendingByIdentity.delete(key);
    return t("cmd.model.changed", {
      model: pending.model.label,
      reasoningEffort: effort.label,
    });
  }

  requireModelSession(identity) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    const connector = activeSession.connector
      ?? (String(activeSession.id).startsWith("cli_") ? "cli" : "desktop");
    if (connector !== "desktop") {
      throw new Error(t("cmd.model.desktopOnly"));
    }
    const desktopStatus = this.codexDesktop?.getStatus?.();
    if (desktopStatus && desktopStatus.state !== "connected") {
      throw new Error(t("cmd.desktop.notConnected"));
    }
    if (!this.codexDesktop?.updateThreadSettings) {
      throw new Error(t("cmd.model.unavailable"));
    }
    return { projectPath, activeSession };
  }

  projectsText() {
    const projects = this.projects.listProjects();
    if (projects.length === 0) {
      return t("cmd.projects.none");
    }
    return projects
      .map((project) => `${project.id}. ${project.name}\n   ${project.path}\n   status: ${project.status}`)
      .join("\n\n");
  }

  async projectsTextAsync(identity) {
    if (this.codexDesktop?.getStatus?.().state === "connected" && this.codexDesktop?.listProjects) {
      const desktopProjects = await this.codexDesktop.listProjects();
      if (desktopProjects.length > 0) {
        const key = this.identityKey(identity);
        this.lastProjectsByIdentity.set(key, desktopProjects);
        this.pendingByIdentity.set(key, { type: "choose_project" });
        return this.pickerFromProjects(desktopProjects, t("cmd.projects.chooseDesktop"));
      }
      const key = this.identityKey(identity);
      this.lastProjectsByIdentity.set(key, []);
      this.pendingByIdentity.delete(key);
      return this.text(t("cmd.projects.noDesktop"));
    }
    const key = this.identityKey(identity);
    let localProjects = this.projects.listProjects();
    // No desktop and an empty store (typical on a fresh headless/Linux box):
    // scan the local project root so /projects is a real list, not a dead end.
    if (localProjects.length === 0) {
      const scanned = this.scanLocalProjects?.() ?? [];
      if (scanned.length > 0) {
        this.projects.replaceProjects(scanned);
        localProjects = this.projects.listProjects();
      }
    }
    if (localProjects.length === 0) {
      return this.text(this.projectsText());
    }
    this.lastProjectsByIdentity.set(key, localProjects);
    this.pendingByIdentity.set(key, { type: "choose_project" });
    return this.pickerFromProjects(localProjects, t("cmd.projects.available"));
  }

  openProject(identity, selector) {
    if (!selector) {
      throw new Error(t("cmd.open.usage"));
    }
    const project = this.projects.resolveProject(selector);
    if (project.status === "excluded") {
      throw new Error(t("cmd.open.excluded", { path: project.path }));
    }
    this.currentProjectByIdentity.set(this.identityKey(identity), project.path);
    return t("cmd.open.entered", { name: project.name, path: project.path });
  }

  async openProjectAsync(identity, selector) {
    const opened = this.openProjectFromLastList(identity, selector) ?? this.openProject(identity, selector);
    const sessionsReply = await this.sessionsTextAsync(identity, { choose: true });
    return { kind: "text", text: `${opened}\n\n${sessionsReply.text}`, picker: sessionsReply.picker };
  }

  openProjectFromLastList(identity, selector) {
    if (!selector || isAbsolutePath(selector)) {
      return null;
    }
    const projects = this.lastProjectsByIdentity.get(this.identityKey(identity)) ?? [];
    const project = projects[Number(selector) - 1];
    if (!project) {
      return null;
    }
    this.currentProjectByIdentity.set(this.identityKey(identity), project.path);
    return t("cmd.open.entered", { name: project.name, path: project.path });
  }

  formatProjects(projects) {
    return projects
      .map((project, index) => {
        const id = project.id ?? String(index + 1);
        const activeTag = project.active ? `  ${t("cmd.projects.activeTag")}` : "";
        return [
          `${id}. ${project.name}${activeTag}`,
          `   ${project.path}`,
          `   ${t("cmd.projects.sourceLabel", { source: this.projectSourceLabel(project) })}`,
          `   status: ${project.status}`,
        ].join("\n");
      })
      .join("\n\n");
  }

  pickerFromProjects(projects, title) {
    const items = projects.map((project, index) => ({
      label: project.name,
      index: String(index + 1),
    }));
    const text = [title, this.formatProjects(projects), t("cmd.projects.replyNumber")].join("\n\n");
    return { kind: "text", text, picker: { pickKind: "project", items } };
  }

  projectSourceLabel(project) {
    switch (project.source) {
      case "codex-cli":
      case "cli":
        return "CLI";
      case "codex-desktop+cli":
        return "Desktop + CLI";
      case "codex-desktop":
      case "desktop":
        return "Desktop";
      default:
        return project.source ?? "unknown";
    }
  }

  sessionsText(identity) {
    const projectPath = this.requireCurrentProject(identity);
    const sessions = this.sessions.listSessions(projectPath);
    if (sessions.length === 0) {
      return t("cmd.session.none");
    }
    return sessions.map((session, index) => `${index + 1}. ${session.title}\n   ${session.id}`).join("\n\n");
  }

  pickerFromSessions(entries, { preamble = "" } = {}) {
    // entries: [{ label, index }] already including the "0. 新建对话" row.
    const lines = entries.map((entry) => `${entry.index}. ${entry.label}`);
    const text = [preamble, t("cmd.session.choose"), lines.join("\n\n")]
      .filter(Boolean)
      .join("\n\n");
    return { kind: "text", text, picker: { pickKind: "session", items: entries } };
  }

  async sessionsTextAsync(identity, { choose = false } = {}) {
    const projectPath = this.requireCurrentProject(identity);
    const key = this.identityKey(identity);
    if (choose) {
      this.pendingByIdentity.set(key, { type: "choose_session", projectPath });
    }
    if (this.codexDesktop?.getStatus?.().state === "connected") {
      const response = await this.codexDesktop.listThreads({ cwd: projectPath });
      const threads = response.data ?? response.threads ?? [];
      const entries = [
        { label: t("cmd.session.newLabel"), index: "0" },
        ...threads.map((thread, index) => ({
          label: this.threadTitle(thread),
          index: String(index + 1),
        })),
      ];
      return this.pickerFromSessions(entries);
    }
    const sessions = this.sessions.listSessions(projectPath);
    const entries = [
      { label: t("cmd.session.newLabel"), index: "0" },
      ...sessions.map((session, index) => ({
        label: session.title,
        index: String(index + 1),
      })),
    ];
    // Degraded path: the desktop connector is down, so this list is only
    // Comote's local cache. Say so — a silent downgrade reads as "my
    // conversations are gone" to the IM user.
    return this.pickerFromSessions(entries, { preamble: t("cmd.session.desktopOffline") });
  }

  // Asks Codex Desktop for the latest N user/assistant messages on a thread.
  // Falls back to the local Comote transcript when the desktop call fails or
  // returns nothing recognizable. Each returned line is already truncated.
  async recentDesktopThreadLines(threadId, limit = 3) {
    if (!threadId) {
      return [];
    }
    if (this.codexDesktop?.listRecentMessages) {
      try {
        const result = await this.codexDesktop.listRecentMessages({ threadId, limit });
        if (result?.messages?.length) {
          return result.messages.map((message) => this.formatTranscriptLine(message));
        }
      } catch {
        // fall through to local transcript
      }
    }
    if (!this.transcript) {
      return [];
    }
    const page = this.transcript.listThread(threadId, { limit, offset: 0 });
    const messages = page?.messages ?? [];
    // listThread returns newest-first; reverse for chronological reading.
    return messages
      .slice()
      .reverse()
      .map((message) => this.formatTranscriptLine(message));
  }

  formatTranscriptLine(message) {
    const role = message.role === "user" ? t("cmd.transcript.you") : "Codex";
    const text = String(message.text ?? "").trim();
    return `**${role}：** ${text}`;
  }

  useSession(identity, selector) {
    const projectPath = this.requireCurrentProject(identity);
    const session = this.sessions.useSession(
      projectPath,
      selector,
      this.identityKey(identity),
      this.connectorForNextSession(),
    );
    return t("cmd.use.switched", { title: session.title, id: session.id });
  }

  tailText(identity, countText) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    const count = clampTailCount(countText);
    const messages = activeSession.messages.slice(-count);
    if (messages.length === 0) {
      return t("cmd.tail.empty");
    }
    return messages.map((message) => `${message.role}: ${message.text}`).join("\n");
  }

  // Async /tail. Desktop threads never append to the local session.messages
  // (the return path records into the Transcript instead), so the old
  // in-memory read was permanently empty for them (B-5). Desktop sessions go
  // through recentDesktopThreadLines (desktop RPC with a local-transcript
  // fallback); locally-created sessions (session_NNNN / cli_*) keep the
  // original in-memory read.
  async tailTextAsync(identity, countText) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    const count = clampTailCount(countText);
    const isLocalSession = /^(session|cli)_/.test(String(activeSession.id));
    if (!isLocalSession) {
      const lines = await this.recentDesktopThreadLines(activeSession.id, count);
      if (lines.length > 0) {
        return lines.join("\n");
      }
    }
    const messages = activeSession.messages.slice(-count);
    if (messages.length === 0) {
      return t("cmd.tail.empty");
    }
    return messages.map((message) => `${message.role}: ${message.text}`).join("\n");
  }

  async useSessionAsync(identity, selector) {
    const projectPath = this.requireCurrentProject(identity);
    const key = this.identityKey(identity);
    if (selector === "0") {
      this.pendingByIdentity.set(key, { type: "await_new_session_message", projectPath });
      return t("cmd.session.promptFirstMessage");
    }
    if (this.codexDesktop?.getStatus?.().state === "connected") {
      const response = await this.codexDesktop.listThreads({ cwd: projectPath });
      const threads = response.data ?? response.threads ?? [];
      const thread = threads[Number(selector) - 1] ?? threads.find((candidate) => candidate.id === selector);
      if (thread) {
        this.rememberThreadSettings(thread.id, thread);
        const connector = this.connectorForNextSession();
        const resumed = connector === "desktop"
          ? await this.resumeDesktopThread(thread.id, projectPath)
          : null;
        const activeThread = resumed?.thread ?? thread;
        const title = this.threadTitle(activeThread, thread);
        const threadId = activeThread.id ?? thread.id;
        this.bindThreadForIdentity(identity, threadId, projectPath);
        this.sessions.upsertExternalSession({
          projectPath,
          id: threadId,
          title,
          identityKey: key,
          connector,
        });
        this.pendingByIdentity.delete(key);
        const recent = await this.recentDesktopThreadLines(threadId, 3);
        const recentBlock = recent.length > 0
          ? `\n\n${t("cmd.use.recentHeader", { count: recent.length })}\n${recent.join("\n")}`
          : `\n\n${t("cmd.use.noHistory")}`;
        return `${t("cmd.use.resumed", { title })}${recentBlock}\n\n${t("cmd.use.continueHint")}`;
      }
    }
    const result = this.useSession(identity, selector);
    this.pendingByIdentity.delete(key);
    return result;
  }

  newSession(identity, message) {
    const projectPath = this.requireCurrentProject(identity);
    const session = this.sessions.createSession({
      projectPath,
      title: message || "New Comote session",
      firstMessage: message,
      identityKey: this.identityKey(identity),
      connector: this.connectorForNextSession(),
    });
    return t("cmd.new.created", { title: session.title, id: session.id });
  }

  async newSessionAsync(identity, message, attachments = []) {
    const projectPath = this.requireCurrentProject(identity);
    const key = this.identityKey(identity);
    if (!message) {
      this.pendingByIdentity.set(key, { type: "await_new_session_message", projectPath });
      return t("cmd.session.promptFirstMessage");
    }
    // Reserve quota up front; refund it if the turn never actually starts so a
    // failed hand-off to Codex does not count against the user's hourly budget.
    const reservation = this.enforceTurnRate(identity);
    const images = this.collectImagePaths(attachments, projectPath);
    const connector = this.connectorForNextSession();
    try {
      if (connector === "desktop") {
        const started = await this.codexDesktop.startThread({ cwd: projectPath });
        const threadId = started.thread.id;
        this.rememberThreadSettings(threadId, started);
        this.bindThreadForIdentity(identity, threadId, projectPath);
        this.transcript?.record(threadId, "user", message);
        await this.codexDesktop.startTurn({ threadId, text: message, cwd: projectPath, images });
        this.sessions.upsertExternalSession({
          projectPath,
          id: threadId,
          title: message || threadId,
          messages: message ? [{ role: "user", text: message }] : [],
          identityKey: key,
          connector: "desktop",
        });
        this.pendingByIdentity.delete(key);
        return t("cmd.new.sentDesktop", { id: threadId });
      }
      if (connector === "cli") {
        const result = await this.codexCli.runPrompt({ cwd: projectPath, text: message, images });
        this.bindThreadForIdentity(identity, result.id, projectPath);
        this.transcript?.record(result.id, "user", message);
        if (result.output) {
          this.transcript?.record(result.id, "assistant", result.output);
        }
        this.sessions.upsertExternalSession({
          projectPath,
          id: result.id,
          title: message || result.id,
          messages: message ? [{ role: "user", text: message }] : [],
          identityKey: key,
          connector: "cli",
        });
        this.pendingByIdentity.delete(key);
        return t("cmd.new.startedCli", { name: message || result.id, output: result.output });
      }
      this.pendingByIdentity.delete(key);
      return this.newSession(identity, message);
    } catch (error) {
      this.refundTurnStart(identity, reservation);
      throw error;
    }
  }

  async handlePlainText(identity, text, attachments = []) {
    const key = this.identityKey(identity);
    const trimmed = text.trim();
    const pending = this.pendingByIdentity.get(key);

    if (pending?.type === "choose_project"
      || pending?.type === "choose_session"
      || MODEL_PICKER_TYPES.has(pending?.type)) {
      if (/^\d+$/.test(trimmed)) {
        if (pending.type === "choose_project") {
          return this.chooseProject(identity, trimmed);
        }
        if (pending.type === "choose_session") {
          return this.text(await this.useSessionAsync(identity, trimmed));
        }
        if (pending.type === "choose_model") {
          return await this.chooseModel(identity, trimmed);
        }
        return this.text(await this.chooseReasoning(identity, trimmed));
      }
      // Non-numeric input while a picker is open (B-10): hint once (with the
      // /cancel escape), then on the second consecutive miss give up on the
      // picker and let the message fall through as a normal one below.
      // Without this the selection state swallows every plain message forever.
      if (!pending.pickerMisses) {
        this.pendingByIdentity.set(key, { ...pending, pickerMisses: 1 });
        const base = pending.type === "choose_project"
          ? t("cmd.projects.replyNumber")
          : pending.type === "choose_session"
            ? t("cmd.session.replyNumberOrNew")
            : t("cmd.model.replyNumber");
        return this.text(`${base}\n${t("cmd.picker.escapeHint")}`);
      }
      this.pendingByIdentity.delete(key);
    }
    if (pending?.type === "await_new_session_message") {
      if (!trimmed) {
        return this.text(t("cmd.session.promptFirstMessage"));
      }
      return this.text(await this.newSessionAsync(identity, trimmed, attachments));
    }

    const projectPath = this.currentProjectByIdentity.get(key);
    if (!projectPath) {
      return this.projectsTextAsync(identity);
    }
    if (!this.sessions.getActiveSession(projectPath, key)) {
      return this.sessionsTextAsync(identity, { choose: true });
    }
    return this.text(await this.sendToActiveSession(identity, text, attachments));
  }

  // Collects the local image attachments for the current turn and resolves each
  // to an absolute path inside the project root. The base adapter has already
  // downloaded inbound attachments into `.comote/uploads/` and stamped a
  // `localPath` (relative) + `kind` onto each; here we keep only the images and
  // re-run them through resolveWithinProject so a path escape is rejected before
  // the file is ever handed to Codex as an image.
  collectImagePaths(attachments, projectPath) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    const images = [];
    for (const attachment of attachments) {
      const localPath = attachment?.localPath;
      if (!localPath) {
        continue;
      }
      const kind = attachment?.kind ?? classifyMedia(localPath);
      if (kind !== "image") {
        continue;
      }
      const safePath = resolveWithinProject(projectPath, localPath);
      if (safePath) {
        images.push(safePath);
      }
    }
    return images;
  }

  async chooseProject(identity, selector) {
    const key = this.identityKey(identity);
    const opened = this.openProjectFromLastList(identity, selector);
    if (!opened) {
      return this.text([
        t("cmd.choose.notFound"),
        t("cmd.choose.retry"),
      ].join("\n"));
    }
    const sessionsReply = await this.sessionsTextAsync(identity, { choose: true });
    return { kind: "text", text: `${opened}\n\n${sessionsReply.text}`, picker: sessionsReply.picker };
  }

  async sendToActiveSession(identity, text, attachments = []) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    const connector = activeSession.connector
      ?? (String(activeSession.id).startsWith("cli_") ? "cli" : "desktop");
    if (connector === "cli") {
      // Older Comote versions stored a synthetic cli_* id, which Codex cannot
      // resume. New CLI sessions persist the real thread id from JSONL output.
      if (String(activeSession.id).startsWith("cli_")) {
        throw new Error(t("cmd.session.cliNoResume"));
      }
      if (!this.isCliAvailable()) {
        throw new Error(t("cmd.cli.notAvailable"));
      }
      const reservation = this.enforceTurnRate(identity);
      const images = this.collectImagePaths(attachments, projectPath);
      try {
        this.bindThreadForIdentity(identity, activeSession.id, projectPath);
        const result = await this.codexCli.runPrompt({
          cwd: projectPath,
          text,
          images,
          resumeId: activeSession.id,
        });
        this.transcript?.record(activeSession.id, "user", text);
        if (result.output) {
          this.transcript?.record(activeSession.id, "assistant", result.output);
        }
        return t("cmd.send.cliCompleted", { id: activeSession.id, output: result.output });
      } catch (error) {
        this.refundTurnStart(identity, reservation);
        throw error;
      }
    }
    if (this.codexDesktop?.getStatus?.().state !== "connected") {
      throw new Error(t("cmd.desktop.notConnected"));
    }
    // Reserve quota up front; refund it if the turn never actually starts.
    const reservation = this.enforceTurnRate(identity);
    this.bindThreadForIdentity(identity, activeSession.id, projectPath);
    const images = this.collectImagePaths(attachments, projectPath);
    try {
      await this.resumeDesktopThread(activeSession.id, projectPath);
      this.transcript?.record(activeSession.id, "user", text);
      try {
        await this.codexDesktop.startTurn({ threadId: activeSession.id, text, cwd: projectPath, images });
      } catch (error) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }
        await this.resumeDesktopThread(activeSession.id, projectPath);
        await this.codexDesktop.startTurn({ threadId: activeSession.id, text, cwd: projectPath, images });
      }
    } catch (error) {
      this.refundTurnStart(identity, reservation);
      throw error;
    }
    return t("cmd.send.processing", { id: activeSession.id });
  }

  async resumeDesktopThread(threadId, cwd = null) {
    if (!this.codexDesktop?.resumeThread) {
      return null;
    }
    const result = await this.codexDesktop.resumeThread({ threadId, cwd });
    this.rememberThreadSettings(threadId, result);
    return result;
  }

  // Resolves a pending Codex approval by short code or id. `identity` is the
  // resolver's IM identity — the text path (/approve, /deny) and all three
  // channel button runtimes pass their clicker identity, and when the
  // approval's thread has a recorded owner, only that owner may resolve it
  // (B-4). `identity` is null only for trusted local callers (the desktop web
  // UI resolves via the connector directly), which skips the gate — the
  // machine owner is implicitly allowed. An ownership rejection throws with
  // `code = "not_owner"` so callers can tell it apart from retriable faults
  // (RPC timeout etc.) — the approval is only deleted after a successful
  // resolve, so retriable faults lose nothing.
  async resolveApproval(selector, decision, identity = null) {
    if (!selector) {
      throw new Error(decision === "accept" ? t("cmd.approve.usage") : t("cmd.deny.usage"));
    }
    if (!this.codexDesktop?.resolveApproval) {
      throw new Error(t("cmd.approve.unavailable"));
    }
    if (identity) {
      const approval = this.findPendingApproval(selector);
      // Approvals without a threadId, or whose thread has no recorded owner
      // binding (e.g. a turn started from the desktop UI, or a binding lost to
      // an old snapshot), cannot be attributed to anyone: they stay resolvable
      // by any authorized identity, which is the pre-existing behavior.
      const owner = approval?.threadId
        ? this.getThreadBinding(approval.threadId)?.ownerStableId ?? null
        : null;
      if (owner && owner !== identity.stableId) {
        const error = new Error(t("cmd.approve.notOwner"));
        error.code = "not_owner";
        throw error;
      }
    }
    await this.codexDesktop.resolveApproval(selector, decision);
    if (decision === "acceptForSession") {
      return t("cmd.approve.acceptedForSession", { selector });
    }
    return decision === "accept"
      ? t("cmd.approve.approved", { selector })
      : t("cmd.deny.rejected", { selector });
  }

  // Looks up a pending approval on the desktop connector by short code or id.
  // Returns null when the connector cannot enumerate approvals (older mocks /
  // connectors) — the ownership gate then degrades to "cannot attribute".
  findPendingApproval(selector) {
    const pending = this.codexDesktop?.listPendingApprovals?.() ?? [];
    return pending.find((a) => a?.shortCode === selector || a?.id === selector) ?? null;
  }

  async cancelActiveTurn(identity) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath, this.identityKey(identity));
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    if (!this.codexDesktop?.cancelTurn) {
      throw new Error(t("cmd.cancel.unavailable"));
    }
    await this.codexDesktop.cancelTurn({ threadId: activeSession.id, cwd: projectPath });
    return t("cmd.cancel.cancelled", { id: activeSession.id });
  }

  // Pushes a project-internal file to the user's chat. The path is fenced
  // inside the current project (resolveWithinProject) before any filesystem
  // access; out-of-project or missing paths return a text message and never
  // enqueue. The media reply is delivered by the channel runtime (Tasks 5/6).
  async handleFileCommand(identity, rawPath) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    if (!projectPath) {
      return this.text(t("cmd.file.needOpen"));
    }
    const arg = (rawPath ?? "").trim();
    if (!arg) {
      return this.text(t("cmd.file.usage"));
    }
    const safePath = resolveWithinProject(projectPath, arg);
    if (!safePath) {
      return this.text(t("cmd.file.outOfBounds"));
    }
    const { existsSync } = await import("node:fs");
    const { basename } = await import("node:path");
    if (!existsSync(safePath)) {
      return this.text(t("cmd.file.notFound", { arg }));
    }
    const conversation = this.conversationByIdentity.get(this.identityKey(identity));
    if (!conversation) {
      return this.text(t("cmd.file.noConversation"));
    }
    if (!this.outboundQueue) {
      return this.text(t("cmd.file.queueUnavailable"));
    }
    const deliveries = await buildFileDeliveries({ path: safePath, fileName: basename(safePath) });
    // A fresh stamp makes each /file re-send even when the path repeats (the
    // outbound queue dedupes media by path otherwise).
    const stamp = Date.now();
    deliveries.forEach((reply, i) => {
      this.outboundQueue.enqueue({
        channel: conversation.channel,
        conversationId: conversation.conversationId,
        ...(conversation.accountId ? { accountId: conversation.accountId } : {}),
        ...reply,
        dedupeKey: `file:${conversation.conversationId}:${safePath}:${stamp}:${i}`,
      });
    });
    return { kind: "ignored" };
  }

  requireCurrentProject(identity) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    if (!projectPath) {
      throw new Error(t("cmd.project.needOpen"));
    }
    return projectPath;
  }

  threadTitle(thread, fallback = {}) {
    return (
      thread?.title ??
      thread?.name ??
      thread?.preview ??
      fallback?.title ??
      fallback?.name ??
      fallback?.preview ??
      thread?.id ??
      fallback?.id
    );
  }
}

function firstDefinedSetting(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
        return source[key];
      }
    }
  }
  return undefined;
}

function firstStringSetting(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function normalizeModelOptions(response) {
  let entries = response?.data ?? response?.models ?? response;
  if (entries && !Array.isArray(entries)) {
    entries = entries.models ?? entries.data ?? entries.items ?? [];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    const value = typeof entry === "string"
      ? entry
      : entry?.model ?? entry?.id ?? entry?.slug ?? null;
    if (typeof value !== "string" || !value.trim() || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const reasoningEfforts = normalizeReasoningOptions(
      entry?.supportedReasoningEfforts
        ?? entry?.supported_reasoning_efforts
        ?? entry?.reasoningEfforts
        ?? [],
    );
    const defaultReasoningEffort = normalizeReasoningOptions([
      entry?.defaultReasoningEffort ?? entry?.default_reasoning_effort,
    ])[0]?.value ?? null;
    models.push({
      value,
      label: typeof entry === "string"
        ? value
        : String(entry?.displayName ?? entry?.name ?? value),
      reasoningEfforts,
      defaultReasoningEffort,
    });
  }
  return models;
}

function normalizeReasoningOptions(values) {
  const options = [];
  const seen = new Set();
  for (const entry of Array.isArray(values) ? values : [values]) {
    const value = typeof entry === "string"
      ? entry
      : entry?.reasoningEffort ?? entry?.effort ?? entry?.value ?? entry?.id ?? null;
    if (typeof value !== "string" || !value.trim() || seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({
      value,
      label: typeof entry === "object" && entry?.displayName
        ? String(entry.displayName)
        : value,
    });
  }
  return options;
}

function formatCurrentModelSettings(settings = {}) {
  if (!settings.model && settings.reasoningEffort === undefined) {
    return null;
  }
  return t("cmd.model.current", {
    model: settings.model ?? t("card.model.unknown"),
    reasoningEffort: settings.reasoningEffort ?? t("card.model.defaultReasoning"),
  });
}

function isMethodMissingError(error) {
  if (error?.code === -32601) {
    return true;
  }
  return /method not found|unknown method|no such method|unsupported method|not found.*method/i.test(
    error?.message ?? String(error),
  );
}

function isThreadNotFoundError(error) {
  return /thread not found/i.test(error?.message ?? String(error));
}

// /tail [n]: default 5, clamped to 1..20.
function clampTailCount(countText) {
  return Math.min(Math.max(Number(countText || 5) || 5, 1), 20);
}
