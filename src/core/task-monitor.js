import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const ACTIVE_STATES = new Set(["running", "waiting"]);
const ATTENTION_STATES = new Set(["completed", "failed", "interrupted"]);
const DEFAULT_INDEX_INTERVAL_MS = 5_000;
const DEFAULT_ACTIVE_INTERVAL_MS = 1_000;
const INITIAL_TAIL_BYTES = 512 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_TASKS = 200;
const KEEP_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export class TaskMonitor {
  constructor({
    desktop,
    persisted = {},
    codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
    now = Date.now,
    indexIntervalMs = DEFAULT_INDEX_INTERVAL_MS,
    activeIntervalMs = DEFAULT_ACTIVE_INTERVAL_MS,
    onPersist = null,
    logger = console,
  } = {}) {
    this.desktop = desktop;
    this.codexHome = codexHome;
    this.now = now;
    this.indexIntervalMs = indexIntervalMs;
    this.activeIntervalMs = activeIntervalMs;
    this.onPersist = onPersist;
    this.logger = logger;
    this.tasks = new Map();
    this.fileCursors = new Map();
    this.pendingInputByThread = new Map();
    this.listeners = new Set();
    this.version = 0;
    this.initialized = false;
    this.running = false;
    this.refreshing = false;
    this.indexTimer = null;
    this.activeTimer = null;
    this.lastError = null;
    this.settings = {
      systemNotifications: persisted?.settings?.systemNotifications !== false,
      mobileNotifications: persisted?.settings?.mobileNotifications !== false,
      ownerIdentityKey: persisted?.settings?.ownerIdentityKey ?? null,
    };
    this.records = new Map(
      Object.entries(persisted?.records ?? {}).map(([threadId, record]) => [threadId, { ...record }]),
    );
  }

  setPersistHandler(handler) {
    this.onPersist = handler;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.refresh({ baseline: true });
    this.indexTimer = setInterval(() => this.refresh().catch((error) => this.#recordError(error)), this.indexIntervalMs);
    this.activeTimer = setInterval(() => this.refreshActive().catch((error) => this.#recordError(error)), this.activeIntervalMs);
    this.indexTimer.unref?.();
    this.activeTimer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.indexTimer);
    clearInterval(this.activeTimer);
    this.indexTimer = null;
    this.activeTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(next = {}) {
    if (Object.hasOwn(next, "systemNotifications")) {
      this.settings.systemNotifications = Boolean(next.systemNotifications);
    }
    if (Object.hasOwn(next, "mobileNotifications")) {
      this.settings.mobileNotifications = Boolean(next.mobileNotifications);
    }
    if (Object.hasOwn(next, "ownerIdentityKey")) {
      this.settings.ownerIdentityKey = next.ownerIdentityKey ? String(next.ownerIdentityKey) : null;
    }
    this.#persist();
    this.#emit({ type: "settings", settings: this.getSettings() });
    return this.getSettings();
  }

  snapshot() {
    const tasks = [...this.tasks.values()]
      .filter((task) => this.#shouldExpose(task))
      .map((task) => this.#publicTask(task))
      .sort(compareTasks);
    return {
      version: this.version,
      generatedAt: new Date(this.now()).toISOString(),
      state: this.lastError ? "degraded" : this.desktop?.getStatus?.().state === "connected" ? "ready" : "offline",
      error: this.lastError,
      counts: countTasks(tasks, this.now()),
      tasks,
      settings: this.getSettings(),
    };
  }

  getTask(threadId) {
    const task = this.tasks.get(String(threadId));
    return task ? this.#publicTask(task) : null;
  }

  listProjectTasks(projectPath) {
    return [...this.tasks.values()]
      .filter((task) => task.projectPath === projectPath && this.#shouldExpose(task))
      .map((task) => this.#publicTask(task))
      .sort(compareTasks);
  }

  markSeen(threadId) {
    const task = this.#requireTask(threadId);
    if (task.seenAt) return this.#publicTask(task);
    const record = this.#recordFor(task.id);
    record.seenAt = new Date(this.now()).toISOString();
    task.seenAt = record.seenAt;
    this.#persist();
    this.#changed(task, "seen", false);
    return this.#publicTask(task);
  }

  markHandled(threadId) {
    const task = this.#requireTask(threadId);
    const record = this.#recordFor(task.id);
    const stamp = new Date(this.now()).toISOString();
    record.seenAt ??= stamp;
    record.handledAt = stamp;
    task.seenAt = record.seenAt;
    task.handledAt = stamp;
    task.attention = false;
    this.#persist();
    this.#changed(task, "handled", false);
    return this.#publicTask(task);
  }

  ingestLiveEvent(event) {
    const threadId = event?.threadId;
    if (!threadId) return;
    const task = this.tasks.get(String(threadId)) ?? this.#createTask({ id: String(threadId) });
    const at = new Date(this.now()).toISOString();
    task.source = "live";
    task.updatedAt = at;
    switch (event.type) {
      case "turnStarted":
        task.startedAt = at;
        task.currentContent = null;
        task.lastActivity = { kind: "started", at };
        this.#setState(task, "running", { attention: false });
        break;
      case "approval":
        task.lastActivity = { kind: "approval", at };
        this.#setState(task, "waiting", { attention: true });
        break;
      case "approvalResolved":
        task.lastActivity = { kind: "approvalResolved", at };
        this.#setState(task, "running", { attention: false });
        break;
      case "progress":
      case "milestone":
        task.lastActivity = { kind: event.type, label: event.label ?? null, at };
        if (!ACTIVE_STATES.has(task.state)) this.#setState(task, "running", { attention: false });
        else this.#changed(task, "activity", false);
        break;
      case "agentMessageDelta":
      case "agentMessage": {
        const content = activityPreview(event.text);
        const changed = Boolean(content && content !== task.currentContent);
        if (content) task.currentContent = content;
        task.lastActivity = { kind: event.type, at };
        if (!ACTIVE_STATES.has(task.state)) this.#setState(task, "running", { attention: false });
        else if (changed) this.#changed(task, "activity", false);
        break;
      }
      case "turnCompleted":
        task.completedAt = at;
        task.lastActivity = { kind: "completed", at };
        this.#setState(task, "completed", { attention: true });
        break;
      case "error":
        task.completedAt = at;
        task.lastActivity = { kind: "error", label: event.message ?? null, at };
        this.#setState(task, "failed", { attention: true });
        break;
      default:
        break;
    }
  }

  async refresh({ baseline = false } = {}) {
    if (this.refreshing || !this.desktop || this.desktop.getStatus?.().state !== "connected") return;
    this.refreshing = true;
    const effectiveBaseline = baseline || !this.initialized;
    try {
      const response = await this.desktop.listThreads({ cwd: null, limit: 100 });
      const threads = response?.data ?? response?.threads ?? [];
      for (const thread of threads) {
        const task = this.#upsertThread(thread);
        await this.#scanTask(task, { baseline: effectiveBaseline });
      }
      this.lastError = null;
      this.#prune();
      this.initialized = true;
    } catch (error) {
      this.#recordError(error);
    } finally {
      this.refreshing = false;
    }
  }

  async refreshActive() {
    if (this.refreshing) return;
    const candidates = [...this.tasks.values()].filter(
      (task) => ACTIVE_STATES.has(task.state) || task.state === "unknown",
    );
    for (const task of candidates) {
      await this.#scanTask(task, { baseline: false });
    }
  }

  persistSnapshot() {
    return {
      settings: this.getSettings(),
      records: Object.fromEntries(
        [...this.records.entries()].slice(-MAX_TASKS).map(([threadId, record]) => [threadId, { ...record }]),
      ),
    };
  }

  #upsertThread(thread) {
    const id = String(thread.id);
    const task = this.tasks.get(id) ?? this.#createTask({ id });
    const record = this.#recordFor(id);
    task.title = cleanTitle(thread.name ?? thread.title ?? thread.preview ?? id);
    task.projectPath = thread.cwd ?? thread.workingDirectory ?? thread.projectPath ?? task.projectPath;
    task.projectName = task.projectPath ? basename(task.projectPath) : "Unknown project";
    task.rolloutPath = thread.path ?? thread.rolloutPath ?? task.rolloutPath;
    task.updatedAt = normalizeTimestamp(thread.updatedAt ?? thread.updated_at) ?? task.updatedAt;
    task.createdAt = normalizeTimestamp(thread.createdAt ?? thread.created_at) ?? task.createdAt;
    task.seenAt = record.seenAt ?? null;
    task.handledAt = record.handledAt ?? null;
    return task;
  }

  #createTask({ id }) {
    const record = this.#recordFor(id);
    const task = {
      id,
      title: id,
      projectName: "Unknown project",
      projectPath: null,
      rolloutPath: null,
      state: record.lastState ?? "unknown",
      source: "metadata",
      attention: Boolean(record.attention),
      seenAt: record.seenAt ?? null,
      handledAt: record.handledAt ?? null,
      createdAt: null,
      startedAt: null,
      completedAt: record.completedAt ?? null,
      updatedAt: null,
      currentContent: null,
      lastActivity: null,
    };
    this.tasks.set(id, task);
    return task;
  }

  async #scanTask(task, { baseline }) {
    if (!task.rolloutPath) return;
    const baselineRecord = baseline ? { ...this.#recordFor(task.id) } : null;
    let fileStat;
    try {
      fileStat = await stat(task.rolloutPath);
    } catch (error) {
      if (error.code !== "ENOENT") this.#recordError(error);
      return;
    }
    const cursor = this.fileCursors.get(task.rolloutPath);
    if (cursor && cursor.size === fileStat.size && cursor.mtimeMs === fileStat.mtimeMs) return;
    const start = cursor && fileStat.size >= cursor.offset
      ? cursor.offset
      : Math.max(0, fileStat.size - INITIAL_TAIL_BYTES);
    const { events, offset } = await readJsonLines(task.rolloutPath, start, fileStat.size, start > 0 && !cursor);
    this.fileCursors.set(task.rolloutPath, { offset, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
    for (const entry of events) {
      this.#applySessionEntry(task, entry, { baseline });
    }
    // A long active turn can exceed the initial tail window. If the tail has no
    // lifecycle marker, recover from the beginning once. Keep lifecycle,
    // request-input, and user-visible assistant-message records so a long turn
    // can still expose the same latest preview as the Codex pet.
    if (!cursor && start > 0 && task.state === "unknown") {
      const full = await readJsonLines(task.rolloutPath, 0, fileStat.size, false, isRecoveryEntry);
      for (const entry of full.events) {
        this.#applySessionEntry(task, entry, { baseline });
      }
    }
    if (baselineRecord) {
      this.#reconcileBaselineInteraction(task, baselineRecord);
    }
  }

  #reconcileBaselineInteraction(task, previousRecord) {
    const sameState = previousRecord.lastState === task.state;
    const sameTerminalOccurrence = !ATTENTION_STATES.has(task.state)
      || previousRecord.completedAt === task.completedAt;
    const preserve = sameState && sameTerminalOccurrence;
    const record = this.#recordFor(task.id);
    const before = {
      attention: task.attention,
      seenAt: task.seenAt,
      handledAt: task.handledAt,
    };

    task.attention = preserve ? Boolean(previousRecord.attention) : false;
    task.seenAt = preserve ? previousRecord.seenAt ?? null : null;
    task.handledAt = preserve ? previousRecord.handledAt ?? null : null;
    record.attention = task.attention;
    record.seenAt = task.seenAt;
    record.handledAt = task.handledAt;

    if (
      before.attention !== task.attention
      || before.seenAt !== task.seenAt
      || before.handledAt !== task.handledAt
    ) {
      this.#persist();
      this.#changed(task, "baseline", false);
    }
  }

  #applySessionEntry(task, entry, { baseline }) {
    const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : {};
    const at = entry.timestamp ?? new Date(this.now()).toISOString();
    task.updatedAt = at;
    if (entry.type === "event_msg") {
      if (payload.type === "task_started") {
        task.startedAt = at;
        task.currentContent = null;
        task.lastActivity = { kind: "started", at };
        this.#setState(task, "running", {
          attention: false,
          notify: !baseline,
          preserveInteraction: baseline,
        });
      } else if (payload.type === "task_complete") {
        task.completedAt = at;
        task.lastActivity = { kind: "completed", at };
        this.#setState(task, "completed", {
          attention: !baseline,
          notify: !baseline,
          preserveInteraction: baseline,
        });
      } else if (payload.type === "turn_aborted") {
        task.completedAt = at;
        task.lastActivity = { kind: "interrupted", at };
        this.#setState(task, "interrupted", {
          attention: !baseline,
          notify: !baseline,
          preserveInteraction: baseline,
        });
      } else if (payload.type === "agent_message") {
        const content = activityPreview(payload.message ?? payload.text);
        const changed = Boolean(content && content !== task.currentContent);
        if (content) task.currentContent = content;
        task.lastActivity = { kind: payload.type, at };
        task.updatedAt = at;
        if (changed && !baseline) this.#changed(task, "activity", false);
      } else if (["agent_reasoning", "mcp_tool_call_end", "patch_apply_end", "image_generation_end"].includes(payload.type)) {
        task.lastActivity = { kind: payload.type, at };
        task.updatedAt = at;
      }
      return;
    }
    if (entry.type !== "response_item") return;
    if (payload.type === "message" && payload.role === "assistant") {
      const content = activityPreview(responseMessageText(payload));
      const changed = Boolean(content && content !== task.currentContent);
      if (content) task.currentContent = content;
      task.lastActivity = { kind: "agent_message", at };
      if (changed && !baseline) this.#changed(task, "activity", false);
      return;
    }
    if (payload.type === "function_call" && payload.name === "request_user_input" && payload.call_id) {
      this.pendingInputByThread.set(task.id, payload.call_id);
      task.lastActivity = { kind: "waitingInput", at };
      this.#setState(task, "waiting", {
        attention: !baseline,
        notify: !baseline,
        preserveInteraction: baseline,
      });
      return;
    }
    if (payload.type === "function_call_output" && payload.call_id === this.pendingInputByThread.get(task.id)) {
      this.pendingInputByThread.delete(task.id);
      task.lastActivity = { kind: "inputReceived", at };
      this.#setState(task, "running", {
        attention: false,
        notify: false,
        preserveInteraction: baseline,
      });
    }
  }

  #setState(task, state, { attention = false, notify = true, preserveInteraction = false } = {}) {
    const previous = task.state;
    const previousAttention = task.attention;
    task.state = state;
    if (!preserveInteraction) {
      task.attention = attention && !task.handledAt;
    }
    task.source = task.source === "live" ? "live" : "session-log";
    task.updatedAt ??= new Date(this.now()).toISOString();
    const record = this.#recordFor(task.id);
    record.lastState = state;
    record.attention = task.attention;
    if (task.completedAt) record.completedAt = task.completedAt;
    if (state === "running" && !preserveInteraction) {
      task.handledAt = null;
      task.seenAt = null;
      record.handledAt = null;
      record.seenAt = null;
    }
    if (previous !== state || previousAttention !== task.attention) {
      this.#changed(task, "state", notify && this.initialized, previous);
    }
  }

  #changed(task, reason, notify, previousState = null) {
    this.version += 1;
    this.#emit({
      type: "task",
      reason,
      notify,
      previousState,
      task: this.#publicTask(task),
      version: this.version,
    });
  }

  #emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn?.(`[task-monitor] listener failed: ${error.message}`);
      }
    }
  }

  #publicTask(task) {
    return {
      id: task.id,
      title: task.title,
      project: { name: task.projectName, path: task.projectPath },
      state: task.state,
      source: task.source,
      attention: task.attention,
      seenAt: task.seenAt,
      handledAt: task.handledAt,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      currentContent: task.currentContent,
      lastActivity: task.lastActivity,
      capabilities: {
        open: true,
        send: !ACTIVE_STATES.has(task.state) && Boolean(task.projectPath),
        cancel: task.source === "live" && ACTIVE_STATES.has(task.state),
        approve: task.source === "live" && task.state === "waiting",
        markHandled: task.attention,
      },
    };
  }

  #recordFor(threadId) {
    let record = this.records.get(threadId);
    if (!record) {
      record = {};
      this.records.set(threadId, record);
    }
    return record;
  }

  #requireTask(threadId) {
    const task = this.tasks.get(String(threadId));
    if (!task) {
      const error = new Error(`unknown task: ${threadId}`);
      error.code = "TASK_NOT_FOUND";
      throw error;
    }
    return task;
  }

  #shouldExpose(task) {
    if (ACTIVE_STATES.has(task.state) || task.attention) return true;
    const stamp = Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt ?? "");
    return Number.isFinite(stamp) && this.now() - stamp <= KEEP_RECENT_MS;
  }

  #prune() {
    if (this.tasks.size <= MAX_TASKS) return;
    const keep = [...this.tasks.values()].sort(compareTasks).slice(0, MAX_TASKS);
    const ids = new Set(keep.map((task) => task.id));
    for (const id of this.tasks.keys()) {
      if (!ids.has(id)) this.tasks.delete(id);
    }
  }

  #persist() {
    Promise.resolve(this.onPersist?.()).catch((error) => this.#recordError(error));
  }

  #recordError(error) {
    this.lastError = error?.message ?? String(error);
    this.logger.warn?.(`[task-monitor] ${this.lastError}`);
  }
}

export async function readJsonLines(filePath, start, end, discardFirstPartial = false, keep = null) {
  const handle = await open(filePath, "r");
  let position = start;
  let carry = "";
  const events = [];
  let firstChunk = true;
  try {
    while (position < end) {
      const length = Math.min(READ_CHUNK_BYTES, end - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      if (firstChunk && discardFirstPartial) {
        const newline = text.indexOf("\n");
        text = newline >= 0 ? text.slice(newline + 1) : "";
      }
      firstChunk = false;
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!keep || keep(entry)) events.push(entry);
        } catch {
          // A concurrent writer may leave a partial/corrupt line. The next valid
          // line still carries authoritative lifecycle state, so skip locally.
        }
      }
    }
    // Parse a final complete JSON value even if the writer omitted the newline.
    if (carry.trim()) {
      try {
        const entry = JSON.parse(carry);
        if (!keep || keep(entry)) events.push(entry);
      } catch {
        // Keep the offset before the partial tail so the next scan retries it.
        position -= Buffer.byteLength(carry, "utf8");
      }
    }
    return { events, offset: position };
  } finally {
    await handle.close();
  }
}

function isRecoveryEntry(entry) {
  const payload = entry?.payload;
  if (entry?.type === "event_msg") {
    return ["task_started", "task_complete", "turn_aborted", "agent_message"].includes(payload?.type);
  }
  return entry?.type === "response_item"
    && ((payload?.type === "message" && payload?.role === "assistant")
      || (payload?.type === "function_call" && payload?.name === "request_user_input")
      || payload?.type === "function_call_output");
}

function cleanTitle(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text || "Untitled task";
}

function activityPreview(value, maxLength = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function responseMessageText(payload) {
  return (payload.content ?? [])
    .map((item) => item?.text ?? item?.output_text ?? "")
    .filter(Boolean)
    .join(" ");
}

function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function compareTasks(left, right) {
  const attention = Number(Boolean(right.attention)) - Number(Boolean(left.attention));
  if (attention) return attention;
  const active = Number(ACTIVE_STATES.has(right.state)) - Number(ACTIVE_STATES.has(left.state));
  if (active) return active;
  return Date.parse(right.updatedAt ?? right.completedAt ?? right.createdAt ?? 0)
    - Date.parse(left.updatedAt ?? left.completedAt ?? left.createdAt ?? 0);
}

function countTasks(tasks, nowMs = Date.now()) {
  return {
    running: tasks.filter((task) => task.state === "running").length,
    waiting: tasks.filter((task) => task.state === "waiting").length,
    attention: tasks.filter((task) => task.attention).length,
    completedToday: tasks.filter((task) => {
      if (!task.completedAt) return false;
      const completed = new Date(task.completedAt);
      const now = new Date(nowMs);
      return completed.getFullYear() === now.getFullYear()
        && completed.getMonth() === now.getMonth()
        && completed.getDate() === now.getDate();
    }).length,
  };
}
