import { describeIdentity } from "./authorization.js";
import { normalizeChannelMessage } from "./channel.js";
import { t } from "./i18n/index.js";
import { classifyMedia, resolveWithinProject } from "./paths.js";
import { buildFileDeliveries } from "./file-delivery.js";

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

export class CommandRouter {
  constructor({
    authorization,
    projects,
    sessions,
    codexDesktop = null,
    codexCli = null,
    outboundQueue = null,
    persisted = {},
    maxTurnsPerHour = 60,
    transcript = null,
  }) {
    this.authorization = authorization;
    this.projects = projects;
    this.sessions = sessions;
    this.codexDesktop = codexDesktop;
    this.codexCli = codexCli;
    this.outboundQueue = outboundQueue;
    this.transcript = transcript;
    // Routing state is restored from disk so a daemon restart does not lose
    // the phone user's current project / session context.
    this.currentProjectByIdentity = new Map(persisted.currentProjectByIdentity ?? []);
    this.lastProjectsByIdentity = new Map();
    this.pendingByIdentity = new Map();
    // identityKey -> { channel, conversationId, accountId }
    this.conversationByIdentity = new Map(persisted.conversationByIdentity ?? []);
    // Codex threadId -> conversation, so the return path can find the chat.
    this.threadBindings = new Map(persisted.threadBindings ?? []);
    // Cost guard: identityKey -> array of turn-start epoch ms.
    this.maxTurnsPerHour = maxTurnsPerHour;
    this.turnTimestamps = new Map();
    // identityKey sets for one-time first-contact messaging.
    this.noticedIdentities = new Set();
    this.greetedIdentities = new Set();
  }

  // Serializable routing state for persistence. Transient UI state
  // (pending prompts, last project list) is intentionally not persisted.
  snapshot() {
    return {
      currentProjectByIdentity: [...this.currentProjectByIdentity],
      conversationByIdentity: [...this.conversationByIdentity],
      threadBindings: [...this.threadBindings],
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
        this.noticedIdentities.add(key);
        return { kind: "notice", text: this.unauthorizedNoticeText() };
      }
      return this.deniedReply();
    }
    const reply = await this.dispatchAuthorizedMessage(message);
    if (!this.greetedIdentities.has(key)) {
      this.greetedIdentities.add(key);
      return this.prependWelcome(reply);
    }
    return reply;
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
        return this.text(this.tailText(message.identity, rest));
      }
      if (command === "/file") {
        return await this.handleFileCommand(message.identity, rest);
      }
      if (command === "/cancel") {
        return this.text(await this.cancelActiveTurn(message.identity));
      }
      if (command === "/approve") {
        return this.text(await this.resolveApproval(rest, "accept"));
      }
      if (command === "/deny") {
        return this.text(await this.resolveApproval(rest, "decline"));
      }
      if (!command.startsWith("/")) {
        return await this.handlePlainText(message.identity, message.text, message.attachments);
      }
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

  welcomeText() {
    return [t("cmd.auth.welcome"), "", this.helpText()].join("\n");
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
    return [t("cmd.help.title"), t("cmd.help.body")].join("\n");
  }

  statusText(identity) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    const activeSession = projectPath ? this.sessions.getActiveSession(projectPath) : null;
    return [
      t("cmd.status.title"),
      t("cmd.status.user", { user: describeIdentity(identity) }),
      t("cmd.status.project", { project: projectPath ?? t("cmd.status.none") }),
      t("cmd.status.session", { session: activeSession?.title ?? t("cmd.status.none") }),
    ].join("\n");
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
    const localProjects = this.projects.listProjects();
    const key = this.identityKey(identity);
    if (localProjects.length > 0) {
      this.lastProjectsByIdentity.set(key, localProjects);
      this.pendingByIdentity.set(key, { type: "choose_project" });
    }
    if (localProjects.length === 0) {
      return this.text(this.projectsText());
    }
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
    return this.pickerFromSessions(entries);
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
    const session = this.sessions.useSession(projectPath, selector);
    return t("cmd.use.switched", { title: session.title, id: session.id });
  }

  tailText(identity, countText) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath);
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
    }
    const count = Math.min(Math.max(Number(countText || 5) || 5, 1), 20);
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
        const resumed = await this.resumeDesktopThread(thread.id, projectPath);
        const activeThread = resumed?.thread ?? thread;
        const title = this.threadTitle(activeThread, thread);
        const threadId = activeThread.id ?? thread.id;
        this.bindThreadForIdentity(identity, threadId, projectPath);
        this.sessions.upsertExternalSession({ projectPath, id: threadId, title });
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
    try {
      if (this.codexDesktop?.getStatus?.().state === "connected") {
        const started = await this.codexDesktop.startThread({ cwd: projectPath });
        const threadId = started.thread.id;
        this.bindThreadForIdentity(identity, threadId, projectPath);
        this.transcript?.record(threadId, "user", message);
        await this.codexDesktop.startTurn({ threadId, text: message, cwd: projectPath, images });
        this.sessions.upsertExternalSession({
          projectPath,
          id: threadId,
          title: message || threadId,
          messages: message ? [{ role: "user", text: message }] : [],
        });
        this.pendingByIdentity.delete(key);
        return t("cmd.new.sentDesktop", { id: threadId });
      }
      if (this.codexCli?.runPrompt) {
        const result = await this.codexCli.runPrompt({ cwd: projectPath, text: message, images });
        this.sessions.upsertExternalSession({
          projectPath,
          id: result.id,
          title: message || result.id,
          messages: message ? [{ role: "user", text: message }] : [],
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

    if (pending?.type === "choose_project") {
      return this.chooseProject(identity, trimmed);
    }
    if (pending?.type === "choose_session") {
      if (!/^\d+$/.test(trimmed)) {
        return this.text(t("cmd.session.replyNumberOrNew"));
      }
      return this.text(await this.useSessionAsync(identity, trimmed));
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
    if (!this.sessions.getActiveSession(projectPath)) {
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
    const activeSession = this.sessions.getActiveSession(projectPath);
    if (!activeSession) {
      throw new Error(t("cmd.session.needActive"));
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
    return this.codexDesktop.resumeThread({ threadId, cwd });
  }

  async resolveApproval(selector, decision) {
    if (!selector) {
      throw new Error(decision === "accept" ? t("cmd.approve.usage") : t("cmd.deny.usage"));
    }
    if (!this.codexDesktop?.resolveApproval) {
      throw new Error(t("cmd.approve.unavailable"));
    }
    await this.codexDesktop.resolveApproval(selector, decision);
    return decision === "accept"
      ? t("cmd.approve.approved", { selector })
      : t("cmd.deny.rejected", { selector });
  }

  async cancelActiveTurn(identity) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath);
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

function isThreadNotFoundError(error) {
  return /thread not found/i.test(error?.message ?? String(error));
}
