import { describeIdentity } from "./authorization.js";
import { normalizeChannelMessage } from "./channel.js";
import { classifyMedia, resolveWithinProject } from "./paths.js";

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

  // Throws a user-facing error when an identity exceeds its hourly turn budget.
  enforceTurnRate(identity) {
    const key = this.identityKey(identity);
    const now = Date.now();
    const windowStart = now - 3600_000;
    const recent = (this.turnTimestamps.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= this.maxTurnsPerHour) {
      throw new Error(`已达到每小时 ${this.maxTurnsPerHour} 次 Codex 任务上限，请稍后再试。`);
    }
    recent.push(now);
    this.turnTimestamps.set(key, recent);
  }

  bindThreadForIdentity(identity, threadId, projectPath = null) {
    if (!threadId) {
      return;
    }
    const conversation = this.conversationByIdentity.get(this.identityKey(identity));
    if (conversation) {
      this.threadBindings.set(threadId, { ...conversation, projectPath: projectPath ?? null });
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
        return await this.handlePlainText(message.identity, message.text);
      }
      // handleMessage re-normalizes; normalizeChannelMessage is idempotent.
      return this.handleMessage(message);
    } catch (error) {
      return { kind: "error", text: error.message };
    }
  }

  unauthorizedNoticeText() {
    return [
      "你好，我是 Comote —— 把这台电脑上的 Codex 桥接到手机的助手。",
      "你的身份还没有被机主确认，暂时不能操作 Codex。",
      "请让机主在 Comote 桌面端的「授权用户」里确认你，确认后即可使用。",
    ].join("\n");
  }

  deniedReply() {
    return {
      kind: "denied",
      text: "这个身份还没有在本机 Comote 里确认，暂时无法控制 Codex。",
    };
  }

  welcomeText() {
    return ["已确认你的身份，欢迎使用 Comote。", "", this.helpText()].join("\n");
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
      throw new Error("Codex Desktop 取消功能当前不可用。");
    }
    await this.codexDesktop.cancelTurn({ threadId });
    return { ok: true };
  }

  identityKey(identity) {
    return `${identity.channel}:${identity.stableId}`;
  }

  helpText() {
    return [
      "Comote 命令",
      "/projects - 列出可用项目",
      "/open <编号|路径> - 选择一个项目",
      "/sessions - 列出 Codex Desktop 对话",
      "/use <编号|id> - 切换到某个对话",
      "/switch <编号|id> - /use 的别名",
      "/new <消息> - 新建一个 Codex 对话",
      "/current - 显示当前项目和对话",
      "/tail [n] - 显示最近的本地对话消息",
      "/file <路径> - 把项目内文件发到聊天",
      "/approve <编号> - 批准一个 Codex 请求",
      "/deny <编号> - 拒绝一个 Codex 请求",
      "/cancel - 取消当前 Codex 任务",
      "/status - 显示 Comote 状态",
    ].join("\n");
  }

  statusText(identity) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    const activeSession = projectPath ? this.sessions.getActiveSession(projectPath) : null;
    return [
      "Comote 状态",
      `用户：${describeIdentity(identity)}`,
      `项目：${projectPath ?? "无"}`,
      `对话：${activeSession?.title ?? "无"}`,
    ].join("\n");
  }

  projectsText() {
    const projects = this.projects.listProjects();
    if (projects.length === 0) {
      return "还没有发现任何项目。";
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
        return this.pickerFromProjects(desktopProjects, "请选择要操作的 Codex Desktop 项目：");
      }
      const key = this.identityKey(identity);
      this.lastProjectsByIdentity.set(key, []);
      this.pendingByIdentity.delete(key);
      return this.text("没有找到 Codex Desktop 项目。请先在 Codex Desktop 里打开一个项目。");
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
    return this.pickerFromProjects(localProjects, "可用项目：");
  }

  openProject(identity, selector) {
    if (!selector) {
      throw new Error("用法：/open <项目编号或路径>");
    }
    const project = this.projects.resolveProject(selector);
    if (project.status === "excluded") {
      throw new Error(`该路径属于敏感目录，已被排除：${project.path}`);
    }
    this.currentProjectByIdentity.set(this.identityKey(identity), project.path);
    return `已进入 ${project.name}\n${project.path}`;
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
    return `已进入 ${project.name}\n${project.path}`;
  }

  formatProjects(projects) {
    return projects
      .map((project, index) => {
        const id = project.id ?? String(index + 1);
        const activeTag = project.active ? "  ← 当前工作区" : "";
        return [
          `${id}. ${project.name}${activeTag}`,
          `   ${project.path}`,
          `   来源: ${this.projectSourceLabel(project)}`,
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
    const text = [title, this.formatProjects(projects), "回复数字选择项目。"].join("\n\n");
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
      return "当前项目还没有对话。发送 /new <消息> 新建一个。";
    }
    return sessions.map((session, index) => `${index + 1}. ${session.title}\n   ${session.id}`).join("\n\n");
  }

  pickerFromSessions(entries, { preamble = "" } = {}) {
    // entries: [{ label, index }] already including the "0. 新建对话" row.
    const lines = entries.map((entry) => `${entry.index}. ${entry.label}`);
    const text = [preamble, "请选择对话：", lines.join("\n\n")]
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
        { label: "新建对话", index: "0" },
        ...threads.map((thread, index) => ({
          label: this.threadTitle(thread),
          index: String(index + 1),
        })),
      ];
      return this.pickerFromSessions(entries);
    }
    const sessions = this.sessions.listSessions(projectPath);
    const entries = [
      { label: "新建对话", index: "0" },
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
    const role = message.role === "user" ? "你" : "Codex";
    const text = String(message.text ?? "").trim();
    return `**${role}：** ${text}`;
  }

  useSession(identity, selector) {
    const projectPath = this.requireCurrentProject(identity);
    const session = this.sessions.useSession(projectPath, selector);
    return `已切换到对话 ${session.title}\n${session.id}`;
  }

  tailText(identity, countText) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath);
    if (!activeSession) {
      throw new Error("请先用 /use <编号> 选择一个对话，或用 /new <消息> 新建一个。");
    }
    const count = Math.min(Math.max(Number(countText || 5) || 5, 1), 20);
    const messages = activeSession.messages.slice(-count);
    if (messages.length === 0) {
      return "当前对话还没有本地消息记录。";
    }
    return messages.map((message) => `${message.role}: ${message.text}`).join("\n");
  }

  async useSessionAsync(identity, selector) {
    const projectPath = this.requireCurrentProject(identity);
    const key = this.identityKey(identity);
    if (selector === "0") {
      this.pendingByIdentity.set(key, { type: "await_new_session_message", projectPath });
      return "请输入新对话的第一条消息。";
    }
    if (this.codexDesktop?.getStatus?.().state === "connected") {
      const response = await this.codexDesktop.listThreads({ cwd: projectPath });
      const threads = response.data ?? response.threads ?? [];
      const thread = threads[Number(selector) - 1] ?? threads.find((candidate) => candidate.id === selector);
      if (thread) {
        const resumed = await this.resumeDesktopThread(thread.id);
        const activeThread = resumed?.thread ?? thread;
        const title = this.threadTitle(activeThread, thread);
        const threadId = activeThread.id ?? thread.id;
        this.bindThreadForIdentity(identity, threadId, projectPath);
        this.sessions.upsertExternalSession({ projectPath, id: threadId, title });
        this.pendingByIdentity.delete(key);
        const recent = await this.recentDesktopThreadLines(threadId, 3);
        const recentBlock = recent.length > 0
          ? `\n\n最近 ${recent.length} 条：\n${recent.join("\n")}`
          : "\n\n这条对话还没有可读取的历史，发消息即可继续。";
        return `已进入对话：${title}${recentBlock}\n\n现在可以直接发消息。`;
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
    return `已创建对话 ${session.title}\n${session.id}`;
  }

  async newSessionAsync(identity, message) {
    const projectPath = this.requireCurrentProject(identity);
    const key = this.identityKey(identity);
    if (!message) {
      this.pendingByIdentity.set(key, { type: "await_new_session_message", projectPath });
      return "请输入新对话的第一条消息。";
    }
    this.enforceTurnRate(identity);
    if (this.codexDesktop?.getStatus?.().state === "connected") {
      const started = await this.codexDesktop.startThread({ cwd: projectPath });
      const threadId = started.thread.id;
      this.bindThreadForIdentity(identity, threadId, projectPath);
      this.transcript?.record(threadId, "user", message);
      await this.codexDesktop.startTurn({ threadId, text: message, cwd: projectPath });
      this.sessions.upsertExternalSession({
        projectPath,
        id: threadId,
        title: message || threadId,
        messages: message ? [{ role: "user", text: message }] : [],
      });
      this.pendingByIdentity.delete(key);
      return `已新建对话，并发送给 Codex Desktop。\n${threadId}`;
    }
    if (this.codexCli?.runPrompt) {
      const result = await this.codexCli.runPrompt({ cwd: projectPath, text: message });
      this.sessions.upsertExternalSession({
        projectPath,
        id: result.id,
        title: message || result.id,
        messages: message ? [{ role: "user", text: message }] : [],
      });
      this.pendingByIdentity.delete(key);
      return `已启动 Codex CLI 备用会话 ${message || result.id}\n${result.output}`;
    }
    this.pendingByIdentity.delete(key);
    return this.newSession(identity, message);
  }

  async handlePlainText(identity, text) {
    const key = this.identityKey(identity);
    const trimmed = text.trim();
    const pending = this.pendingByIdentity.get(key);

    if (pending?.type === "choose_project") {
      return this.chooseProject(identity, trimmed);
    }
    if (pending?.type === "choose_session") {
      if (!/^\d+$/.test(trimmed)) {
        return this.text("请回复对话编号，或回复 0 新建对话。");
      }
      return this.text(await this.useSessionAsync(identity, trimmed));
    }
    if (pending?.type === "await_new_session_message") {
      if (!trimmed) {
        return this.text("请输入新对话的第一条消息。");
      }
      return this.text(await this.newSessionAsync(identity, trimmed));
    }

    const projectPath = this.currentProjectByIdentity.get(key);
    if (!projectPath) {
      return this.projectsTextAsync(identity);
    }
    if (!this.sessions.getActiveSession(projectPath)) {
      return this.sessionsTextAsync(identity, { choose: true });
    }
    return this.text(await this.sendToActiveSession(identity, text));
  }

  async chooseProject(identity, selector) {
    const key = this.identityKey(identity);
    const opened = this.openProjectFromLastList(identity, selector);
    if (!opened) {
      return this.text([
        "没有找到这个项目编号。",
        "请回复列表里的数字，或发送 /projects 重新查看项目。",
      ].join("\n"));
    }
    const sessionsReply = await this.sessionsTextAsync(identity, { choose: true });
    return { kind: "text", text: `${opened}\n\n${sessionsReply.text}`, picker: sessionsReply.picker };
  }

  async sendToActiveSession(identity, text) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath);
    if (!activeSession) {
      throw new Error("请先用 /use <编号> 选择一个对话，或用 /new <消息> 新建一个。");
    }
    if (this.codexDesktop?.getStatus?.().state !== "connected") {
      throw new Error("Codex Desktop 未连接。");
    }
    this.enforceTurnRate(identity);
    this.bindThreadForIdentity(identity, activeSession.id, projectPath);
    this.transcript?.record(activeSession.id, "user", text);
    try {
      await this.codexDesktop.startTurn({ threadId: activeSession.id, text, cwd: projectPath });
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      await this.resumeDesktopThread(activeSession.id);
      await this.codexDesktop.startTurn({ threadId: activeSession.id, text, cwd: projectPath });
    }
    return `已发送给 Codex Desktop，正在处理…\n${activeSession.id}`;
  }

  async resumeDesktopThread(threadId) {
    if (!this.codexDesktop?.resumeThread) {
      return null;
    }
    return this.codexDesktop.resumeThread({ threadId });
  }

  async resolveApproval(selector, decision) {
    if (!selector) {
      throw new Error(decision === "accept" ? "用法：/approve <编号>" : "用法：/deny <编号>");
    }
    if (!this.codexDesktop?.resolveApproval) {
      throw new Error("Codex Desktop 审批功能当前不可用。");
    }
    await this.codexDesktop.resolveApproval(selector, decision);
    return decision === "accept" ? `已批准 ${selector}` : `已拒绝 ${selector}`;
  }

  async cancelActiveTurn(identity) {
    const projectPath = this.requireCurrentProject(identity);
    const activeSession = this.sessions.getActiveSession(projectPath);
    if (!activeSession) {
      throw new Error("请先用 /use <编号> 选择一个对话，或用 /new <消息> 新建一个。");
    }
    if (!this.codexDesktop?.cancelTurn) {
      throw new Error("Codex Desktop 取消功能当前不可用。");
    }
    await this.codexDesktop.cancelTurn({ threadId: activeSession.id, cwd: projectPath });
    return `已取消当前 Codex 任务\n${activeSession.id}`;
  }

  // Pushes a project-internal file to the user's chat. The path is fenced
  // inside the current project (resolveWithinProject) before any filesystem
  // access; out-of-project or missing paths return a text message and never
  // enqueue. The media reply is delivered by the channel runtime (Tasks 5/6).
  async handleFileCommand(identity, rawPath) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    if (!projectPath) {
      return this.text("还没打开项目，先用 /open <编号或路径> 选一个项目。");
    }
    const arg = (rawPath ?? "").trim();
    if (!arg) {
      return this.text("用法：/file <项目内的相对路径>，例如 /file out/chart.png");
    }
    const safePath = resolveWithinProject(projectPath, arg);
    if (!safePath) {
      return this.text("路径越界或无效，只能取项目目录内的文件。");
    }
    const { existsSync } = await import("node:fs");
    const { basename } = await import("node:path");
    if (!existsSync(safePath)) {
      return this.text(`找不到文件：${arg}`);
    }
    const conversation = this.conversationByIdentity.get(this.identityKey(identity));
    if (!conversation) {
      return this.text("无法定位会话，请重发一条消息后再试。");
    }
    if (conversation.channel !== "feishu") {
      return this.text("/file 目前仅支持飞书渠道。");
    }
    if (!this.outboundQueue) {
      return this.text("当前无法发送文件：出站队列不可用。");
    }
    this.outboundQueue.enqueue({
      channel: conversation.channel,
      conversationId: conversation.conversationId,
      ...(conversation.accountId ? { accountId: conversation.accountId } : {}),
      kind: classifyMedia(safePath),
      path: safePath,
      fileName: basename(safePath),
    });
    return this.text(`正在发送：${basename(safePath)}`);
  }

  requireCurrentProject(identity) {
    const projectPath = this.currentProjectByIdentity.get(this.identityKey(identity));
    if (!projectPath) {
      throw new Error("请先用 /open <项目编号或路径> 选择一个项目。");
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
