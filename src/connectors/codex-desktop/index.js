import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, win32 as winPath } from "node:path";

import { JsonRpcClient, StdioTransport } from "./json-rpc.js";

const COMOTE_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8"),
).version;

export class CodexDesktopConnector {
  constructor({
    transport = null,
    transportFactory = null,
    command = null,
    codexStatePath = `${homedir()}/.codex/.codex-global-state.json`,
    firstConnectRetryMs = 30_000,
  } = {}) {
    this.transport = transport;
    this.command = command ?? resolveCodexCommand();
    this.codexStatePath = codexStatePath;
    this.transportFactory =
      transportFactory ?? (() => this.transport ?? new StdioTransport({ command: this.command }));
    this.state = "not_connected";
    this.lastError = null;
    this.pendingApprovals = new Map();
    this.shortCodeToKey = new Map();
    this.approvalCounter = 0;
    // Assigned by the owner (state.js) to receive thread events for the
    // phone return path. Null is fine — events are simply dropped then.
    this.onEvent = null;
    // Reliability: auto-reconnect + heartbeat + latest usage snapshot.
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.maxReconnectAttempts = 8;
    // Fixed interval for the quiet first-connect retry loop (A-5). A first
    // connect that fails usually means codex is not installed/running yet, so
    // exponential backoff is wrong — poll slowly and silently forever instead.
    this.firstConnectRetryMs = firstConnectRetryMs;
    this.lastTokenUsage = null;
    this.lastRateLimits = null;
    // itemId -> file changes, so a file-change approval can show the diff.
    this.fileChangesByItem = new Map();
    // threadId -> Set<absolutePath> of files changed during the active turn.
    // Assumption: one active turn per connection at a time.
    this.changedPathsByThread = new Map();
    this._activeThreadId = null;
    // `${threadId}:${itemId}` -> accumulated agent text for Codex 0.136+
    // delta notifications, which only carry the newest text chunk.
    this.agentMessageTextByItem = new Map();
    this.client = this.createClient();
  }

  createClient() {
    const client = new JsonRpcClient({
      transport: this.transportFactory(),
    });
    client.onServerRequest((request) => this.handleServerRequest(request));
    client.onNotification((notification) => this.handleNotification(notification));
    client.onClose(() => this.handleDisconnect());
    return client;
  }

  // --- Connection resilience -------------------------------------------------

  handleDisconnect() {
    if (this.state === "reconnecting") {
      return;
    }
    this.state = "reconnecting";
    this.stopHeartbeat();
    // The dying child's stderr tail is the only clue to WHY it went away
    // (not logged in, crash, …). Capture it now, before scheduleReconnect
    // replaces the client (and with it the transport holding the tail).
    const stderrTail = this.#stderrSummary();
    if (stderrTail) {
      this.lastError = this.lastError
        ? `${this.lastError}\nstderr: ${stderrTail}`
        : `codex app-server 连接已断开\nstderr: ${stderrTail}`;
    }
    // A disconnect invalidates any in-flight turn: it can no longer reach
    // turn/completed, so its accumulated paths would otherwise bleed into the
    // next turn on the same thread after reconnect. Drop all accumulation —
    // the app-server re-drives state once the connection is re-established.
    this.changedPathsByThread.clear();
    // A mid-stream drop never delivers item/completed, so the per-item delta
    // text would otherwise accumulate forever. Drop it alongside the paths.
    this.agentMessageTextByItem.clear();
    this._activeThreadId = null;
    this.#emit({ type: "connectionLost" });
    this.scheduleReconnect(1);
  }

  scheduleReconnect(attempt) {
    if (this.reconnectTimer) {
      return;
    }
    if (attempt > this.maxReconnectAttempts) {
      this.state = "not_connected";
      this.#emit({ type: "connectionGaveUp" });
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.client.close().catch(() => {});
        this.client = this.createClient();
        await this.initialize();
        this.#emit({ type: "reconnected" });
      } catch {
        this.scheduleReconnect(attempt + 1);
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // A-5: quiet retry loop for a connector that has NEVER connected. Unlike
  // scheduleReconnect (exponential backoff after a drop, bounded attempts,
  // gives up loudly), this polls at a fixed slow interval forever and stays
  // silent on failure — the common cause is simply that codex is not installed
  // yet. On success it goes through the normal path and emits `reconnected`.
  // Reuses `reconnectTimer` so the two mechanisms can never stack timers.
  scheduleFirstConnectRetry() {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // A manual initialize() (UI retry button) may have connected meanwhile.
      if (this.state === "connected") {
        return;
      }
      try {
        await this.client.close().catch(() => {});
        this.client = this.createClient();
        await this.requestInitialize();
        this.#emit({ type: "reconnected" });
      } catch {
        this.scheduleFirstConnectRetry();
      }
    }, this.firstConnectRetryMs);
    // Never keep the process alive just to poll for codex.
    this.reconnectTimer.unref?.();
  }

  // Bounded stderr summary for lastError: getStatus() feeds the UI/doctor, so
  // cap at the last 500 chars rather than the transport's full 4KB tail. The
  // transport is injectable (tests use in-memory ones without stderr), hence
  // the optional-chaining defenses.
  #stderrSummary() {
    const tail = this.client?.transport?.getStderrTail?.();
    if (typeof tail !== "string" || !tail.trim()) {
      return null;
    }
    return tail.trim().slice(-500);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    // A cheap request that also detects a half-open socket the OS never closed.
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected") {
        return;
      }
      this.client
        .request("thread/list", { cwd: null, archived: false, limit: 1, useStateDbOnly: false })
        .catch(() => this.handleDisconnect());
    }, 45_000);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getUsage() {
    return { tokenUsage: this.lastTokenUsage, rateLimits: this.lastRateLimits };
  }

  handleServerRequest(request) {
    const method = request.method ?? "";
    const isApproval =
      method.includes("requestApproval") ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval";
    if (!isApproval) {
      return;
    }
    const key = String(request.id);
    const shortCode = this.pendingApprovals.get(key)?.shortCode ?? `a${++this.approvalCounter}`;
    const itemId = request.params?.itemId ?? null;
    const approval = {
      id: key,
      rpcId: request.id,
      shortCode,
      method,
      params: request.params,
      threadId: request.params?.threadId ?? null,
      changes: itemId ? this.fileChangesByItem.get(itemId) ?? null : null,
    };
    this.pendingApprovals.set(key, approval);
    this.shortCodeToKey.set(shortCode, key);
    this.#emit({ type: "approval", approval });
  }

  // Translates Codex app-server notifications into the small event vocabulary
  // the phone return path understands. Unknown methods are ignored on purpose.
  handleNotification(notification) {
    const method = notification.method;
    const params = notification.params ?? {};
    // Capture file-change details so a later approval prompt can show the diff.
    if (params.item?.type === "fileChange" && params.item.id) {
      this.fileChangesByItem.set(params.item.id, params.item.changes ?? []);
      this.#accumulateChangedPaths(params.threadId, params.item.changes);
    }
    if (method === "item/fileChange/patchUpdated" && params.itemId) {
      this.fileChangesByItem.set(params.itemId, params.changes ?? []);
      this.#accumulateChangedPaths(params.threadId, params.changes);
      // A discrete "file edited" milestone for the IM return path. Label is the
      // first changed file's basename; null-safe degrade to a generic milestone.
      this.#emit({
        type: "milestone",
        kind: "file",
        label: firstChangePathBasename(params.changes),
        detail: fileChangeDetail(params.changes),
        threadId: params.threadId ?? null,
      });
      return;
    }
    if (method === "item/agentMessage/delta" && params.itemId) {
      const key = agentMessageKey(params.threadId, params.itemId);
      const text = `${this.agentMessageTextByItem.get(key) ?? ""}${params.delta ?? ""}`;
      this.agentMessageTextByItem.set(key, text);
      this.#emit({
        type: "agentMessageDelta",
        threadId: params.threadId ?? null,
        itemId: params.itemId ?? null,
        text,
      });
      return;
    }
    if (method === "item/updated" && params.item?.type === "agentMessage") {
      this.#emit({
        type: "agentMessageDelta",
        threadId: params.threadId ?? null,
        itemId: params.item.id ?? null,
        text: params.item.text ?? "",
      });
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      // File edits complete before the agent's final message, so the changed
      // paths accumulated during the turn are already available here. Read but
      // do NOT clear them — turn/completed remains the one that clears.
      const threadId = params.threadId ?? this._activeThreadId ?? null;
      const set = threadId != null ? this.changedPathsByThread.get(threadId) : null;
      // The agent message is final: drop its accumulated delta text so the map
      // does not leak across turns (Codex 0.136+ delta accumulation).
      if (params.item.id) {
        this.agentMessageTextByItem.delete(agentMessageKey(params.threadId, params.item.id));
      }
      this.#emit({
        type: "agentMessage",
        threadId: params.threadId ?? null,
        itemId: params.item.id ?? null,
        text: params.item.text ?? "",
        changedPaths: set ? [...set] : [],
      });
      return;
    }
    if (method === "turn/started") {
      this._activeThreadId = params.threadId ?? null;
      this.#emit({ type: "turnStarted", threadId: params.threadId ?? null });
      return;
    }
    if (method === "turn/completed") {
      const threadId = params.threadId ?? this._activeThreadId ?? null;
      const set = threadId != null ? this.changedPathsByThread.get(threadId) : null;
      const changedPaths = set ? [...set] : [];
      if (threadId != null) {
        this.changedPathsByThread.delete(threadId);
      }
      this._activeThreadId = null;
      this.#emit({ type: "turnCompleted", threadId: params.threadId ?? null, changedPaths });
      return;
    }
    if (method === "item/started") {
      const itemType = params.item?.type;
      if (itemType === "commandExecution" || itemType === "fileChange") {
        this.#emit({ type: "progress", threadId: params.threadId ?? null, itemType });
      }
      // A command starting is a discrete milestone for the IM return path: label
      // is the command's first word (the program), null-safe when absent.
      if (itemType === "commandExecution") {
        this.#emit({
          type: "milestone",
          kind: "command",
          label: commandLabel(params.item?.command),
          detail: commandDetail(params.item),
          threadId: params.threadId ?? null,
        });
      }
      return;
    }
    if (method === "item/completed" && params.item?.type === "commandExecution") {
      // Only surface a milestone when the command FAILED — a non-zero exit is the
      // signal worth interrupting the user for. Successful commands stay silent
      // so the IM return path is not flooded with every shell step.
      const exitCode = params.item.exitCode ?? params.item.exit_code ?? 0;
      if (exitCode !== 0) {
        this.#emit({
          type: "milestone",
          kind: "command",
          label: commandLabel(params.item.command),
          detail: commandDetail(params.item),
          status: "failed",
          threadId: params.threadId ?? null,
        });
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.lastTokenUsage = { threadId: params.threadId ?? null, ...params.tokenUsage };
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.lastRateLimits = params.rateLimits ?? null;
      return;
    }
    if (method === "error") {
      // An `error` notification does not necessarily end the turn — the
      // app-server emits non-fatal errors mid-turn while the turn stays alive.
      // The payload carries no signal distinguishing a turn-ending failure, so
      // clearing accumulation here could drop paths legitimately changed by a
      // turn that is still running. A genuinely turn-ending failure tears the
      // connection down (handled by handleDisconnect) or is followed by
      // turn/completed; both reset accumulation. So we deliberately do not
      // touch changedPathsByThread here.
      const message = normalizeCodexErrorText(params);
      this.#emit({
        type: "error",
        threadId: params.threadId ?? null,
        message: message || "Codex 报告了一个错误",
      });
    }
  }

  // Accumulates absolute paths of files changed during the active turn, keyed
  // by threadId. Only accumulates when a threadId is known.
  #accumulateChangedPaths(threadId, changes) {
    const id = threadId ?? this._activeThreadId ?? null;
    if (id == null) {
      return;
    }
    const paths = extractChangePaths(changes);
    if (paths.length === 0) {
      return;
    }
    let set = this.changedPathsByThread.get(id);
    if (!set) {
      set = new Set();
      this.changedPathsByThread.set(id, set);
    }
    for (const path of paths) {
      set.add(path);
    }
  }

  #emit(event) {
    try {
      this.onEvent?.(event);
    } catch {
      // A listener fault must never break the JSON-RPC read loop.
    }
  }

  getStatus() {
    return {
      name: "Codex Desktop",
      role: "primary",
      state: this.state,
      protocol: "app-server",
      endpoint: "codex app-server (stdio)",
      // Diagnostics: which binary we resolved to and why the last connection
      // attempt failed — so the UI/doctor can show an actionable reason
      // instead of a bare "not connected".
      command: this.command,
      lastError: this.lastError ?? null,
    };
  }

  async initialize() {
    // Connecting = spawning the `codex app-server` child via StdioTransport.
    // Transient drops are handled by the reconnect logic, not retried here.
    // Idempotent: clicking "retry connect" while already connected must not
    // re-send `initialize` — the app-server would reject as "Already initialized".
    if (this.state === "connected") {
      return this.getStatus();
    }
    try {
      return await this.requestInitialize();
    } catch (error) {
      // First-connect failure (as opposed to a mid-session drop, which the
      // exponential-backoff reconnect path owns — state === "reconnecting"
      // there): schedule the quiet fixed-interval retry so the connector comes
      // up on its own once the user installs/starts codex. The error still
      // propagates so a manual retry (UI button) gets an immediate answer.
      if (this.state !== "reconnecting") {
        this.scheduleFirstConnectRetry();
      }
      throw error;
    }
  }

  async requestInitialize() {
    let result;
    try {
      result = await this.client.request("initialize", {
        clientInfo: {
          name: "comote",
          title: "Comote",
          version: COMOTE_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      });
    } catch (error) {
      // The app-server is already initialized — that IS the state we want,
      // so adopt it as a successful connection rather than surface as an error.
      if (/already initialized/i.test(error?.message ?? "")) {
        this.state = "connected";
        this.lastError = null;
        this.startHeartbeat();
        return { alreadyInitialized: true };
      }
      // Append the child's stderr tail (if the transport captured any): when
      // codex spawns but dies immediately (not logged in, crash), the generic
      // "连接已断开" alone says nothing actionable.
      const base = error?.message ?? String(error);
      const stderrTail = this.#stderrSummary();
      this.lastError = stderrTail ? `${base}\nstderr: ${stderrTail}` : base;
      throw error;
    }
    this.state = "connected";
    this.lastError = null;
    this.startHeartbeat();
    return result;
  }

  async listThreads({ cwd = null, limit = 20, cursor = null } = {}) {
    const params = {
      cwd,
      archived: false,
      limit,
      useStateDbOnly: false,
    };
    // Pagination: thread/list returns { data, nextCursor, backwardsCursor };
    // passing the previous response's nextCursor back as `cursor` fetches the
    // next (older) page. Verified against codex 0.144: the cursor is an
    // ISO-8601 timestamp string. Only sent when non-empty so the default
    // first-page request stays byte-identical to the pre-pagination one.
    if (cursor) {
      params.cursor = cursor;
    }
    return this.client.request("thread/list", params);
  }

  async listProjects({ limit = 100 } = {}) {
    // Two sources, merged: Codex Desktop's own workspace list (active
    // workspace first, then project order) AND projects derived from thread
    // history. The workspace list alone hides any project that has
    // conversations but is not (or no longer) a workspace — CLI-only work,
    // removed workspaces. Deduped by path; workspace entries keep their order
    // and win on conflict, thread-derived ones follow sorted by name.
    const workspaceProjects = readCodexWorkspaceProjects(this.codexStatePath);
    let threadProjects;
    try {
      threadProjects = await this.#projectsFromThreadHistory({ limit });
    } catch (error) {
      // thread/list unreachable (not connected, RPC error): degrade to the
      // workspace list rather than failing the whole call. When there is no
      // workspace list either, rethrow so callers keep distinguishing
      // "desktop offline" from "desktop reachable but empty".
      if (workspaceProjects.length > 0) {
        return workspaceProjects;
      }
      throw error;
    }
    if (workspaceProjects.length === 0) {
      return threadProjects;
    }
    const seen = new Set(workspaceProjects.map((project) => project.path));
    const merged = [...workspaceProjects];
    for (const project of threadProjects) {
      if (!seen.has(project.path)) {
        seen.add(project.path);
        merged.push(project);
      }
    }
    return merged;
  }

  // Derives projects from thread history cwds. Source semantics unchanged:
  // thread-derived projects are tagged codex-cli / codex-desktop (or both)
  // per isCliThread. Sorted by name.
  async #projectsFromThreadHistory({ limit }) {
    const response = await this.listThreads({ cwd: null, limit });
    const threads = normalizeThreadList(response);
    const projectsByPath = new Map();
    for (const thread of threads) {
      const cwd = thread.cwd ?? thread.workingDirectory ?? thread.projectPath ?? null;
      if (!cwd) {
        continue;
      }
      const source = isCliThread(thread) ? "codex-cli" : "codex-desktop";
      const existing = projectsByPath.get(cwd);
      if (existing) {
        existing.sources.add(source);
        existing.source = projectSourceValue(existing.sources);
      } else {
        const sources = new Set([source]);
        projectsByPath.set(cwd, {
          name: basename(cwd),
          path: cwd,
          source: projectSourceValue(sources),
          status: "available",
          sources,
        });
      }
    }
    return Array.from(projectsByPath.values(), ({ sources, ...project }) => project).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async startThread({ cwd }) {
    return this.client.request("thread/start", {
      cwd,
      approvalsReviewer: "user",
    });
  }

  async resumeThread({ threadId, cwd = null }) {
    const params = { threadId };
    if (cwd) {
      params.cwd = cwd;
    }
    return this.client.request("thread/resume", params);
  }

  async updateThreadSettings({ threadId, approvalsReviewer }) {
    return this.client.request("thread/settings/update", {
      threadId,
      approvalsReviewer,
    });
  }

  async startTurn({ threadId, text, cwd = null, images = [] }) {
    // The app-server input list accepts a `localImage` item for a local file
    // path; image attachments forwarded from the phone go through here so Codex
    // actually sees the image, not just a path reference in the text.
    const input = [{ type: "text", text, text_elements: [] }];
    for (const path of images) {
      input.push({ type: "localImage", path });
    }
    return this.client.request("turn/start", {
      threadId,
      input,
      cwd,
    });
  }

  // Fetches the latest N user/assistant messages from a thread by walking
  // its turn list and extracting whatever message-like items each turn
  // contains. Defensive against unknown shapes — returns [] if nothing
  // recognizable is found, with `_rawSample` populated so callers can log
  // the actual response shape and we can refine.
  async listRecentMessages({ threadId, limit = 5 }) {
    const turns = await this.listThreadTurns({ threadId });
    const messages = [];
    for (const turn of turns) {
      messages.push(...extractTurnMessages(turn));
    }
    return {
      messages: messages.slice(-limit),
      // The UNTRUNCATED message count: callers (the transcript fallback) use
      // total deltas to detect new messages, so a total capped at the window
      // size would freeze refresh once a thread outgrows the window.
      total: messages.length,
      _rawSample: turns.slice(-1)[0] ?? null,
      _turnCount: turns.length,
    };
  }

  async cancelTurn({ threadId }) {
    const turns = await this.listThreadTurns({ threadId });
    const activeTurn = turns.find((turn) => isActiveTurn(turn));
    if (!activeTurn) {
      throw new Error(`no active turn for thread: ${threadId}`);
    }
    return this.client.request("turn/interrupt", { threadId, turnId: activeTurn.id });
  }

  async listThreadTurns({ threadId }) {
    try {
      const response = await this.client.request("thread/read", { threadId, includeTurns: true });
      return normalizeTurnList(response);
    } catch (error) {
      if (!isMethodMissingError(error)) {
        throw error;
      }
    }
    const response = await this.client.request("thread/turns/list", { threadId });
    return normalizeTurnList(response);
  }

  listPendingApprovals() {
    return Array.from(this.pendingApprovals.values(), (approval) => ({ ...approval }));
  }

  async resolveApproval(idOrShortCode, decision) {
    if (!APPROVAL_DECISIONS.has(decision)) {
      throw new Error(`invalid approval decision: ${decision}`);
    }
    const key = this.shortCodeToKey.get(idOrShortCode) ?? String(idOrShortCode);
    const approval = this.pendingApprovals.get(key);
    if (!approval) {
      throw new Error(`unknown approval: ${idOrShortCode}`);
    }
    const result = approvalResultFor(approval.method, decision);
    await this.client.respond(approval.rpcId ?? approval.id, result);
    this.pendingApprovals.delete(key);
    this.shortCodeToKey.delete(approval.shortCode);
    this.#emit({ type: "approvalResolved", approval, decision });
    return { ok: true };
  }
}

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline"]);

// Pure helper: normalizes the various file-change shapes the app-server emits
// into a flat list of paths. Arrays of change objects (or strings), or an
// object keyed by path, both supported.
export function extractChangePaths(changes) {
  if (!changes) return [];
  if (Array.isArray(changes)) {
    return changes
      .map((c) => (typeof c === "string" ? c : c?.path ?? c?.absolutePath ?? c?.filePath ?? null))
      .filter(Boolean);
  }
  if (typeof changes === "object") {
    return Object.keys(changes);
  }
  return [];
}

// Pure helper: the program word of a shell command, used as a milestone label.
// Takes the first whitespace-delimited token of the command string. Returns null
// (a generic milestone downstream) when the command is missing or empty.
export function commandLabel(command) {
  if (typeof command !== "string") return null;
  const first = command.trim().split(/\s+/)[0];
  return first || null;
}

// Compact tool parameters for IM cards. Commands are usually short, but a
// generated shell script can be large enough to exceed platform card limits.
export function commandDetail(item = {}) {
  return compactToolDetail({
    ...(item.command != null ? { command: item.command } : {}),
    ...(item.cwd != null ? { cwd: item.cwd } : {}),
  });
}

function fileChangeDetail(changes) {
  const paths = extractChangePaths(changes);
  return paths.length > 0 ? compactToolDetail({ paths }) : null;
}

function compactToolDetail(value, max = 300) {
  if (!value || Object.keys(value).length === 0) return null;
  const text = JSON.stringify(value, null, 2);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function normalizeCodexErrorText(value, seen = new WeakSet()) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    const parts = [];
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (message) {
      parts.push(message);
    }
    const cause = normalizeCodexErrorText(value.cause, seen);
    if (cause && !parts.includes(cause)) {
      parts.push(cause);
    }
    return parts.join("\n");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "";
  }
  seen.add(value);
  const parts = [];
  for (const key of ["message", "additionalDetails", "details", "detail", "error", "description", "reason"]) {
    if (!(key in value)) continue;
    const text = normalizeCodexErrorText(value[key], seen);
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json && json !== "{}" ? json : String(value);
  } catch {
    return String(value);
  }
}

// Pure helper: basename of the first changed path in a patch update, used as a
// file-milestone label. Returns null (generic) when no path can be extracted.
export function firstChangePathBasename(changes) {
  const [first] = extractChangePaths(changes);
  return first ? basename(first) : null;
}

// Resolves the codex executable per platform. On macOS, prefer the binary
// bundled inside Codex.app; on Windows, probe the LOCALAPPDATA install layouts
// (including a bounded recursive search) before falling back to PATH — skipping
// the Microsoft Store `WindowsApps` shim, which is an alias stub that breaks the
// stdio app-server. Falls back to bare "codex" so PATH resolution still works.
// Bare "codex" is a last resort: when Comote is launched from Finder/Dock the
// spawn PATH is launchd's minimal set, so version-manager installs (nvm, volta)
// and Homebrew are invisible — hence the absolute-path probing on macOS/Linux.
// All filesystem/environment access is injectable so the resolver is testable.
export function resolveCodexCommand({
  platform = process.platform,
  env = process.env,
  pathEnv = process.env.PATH ?? "",
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  // Explicit user override wins everywhere, even if the file is missing —
  // a wrong override should fail loudly (with the path in the error), not be
  // silently ignored in favor of a different binary.
  const override = env.COMOTE_CODEX_PATH;
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      const candidates = [
        winPath.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
        winPath.join(localAppData, "OpenAI", "Codex", "bin", "win32-x64", "codex.exe"),
        winPath.join(localAppData, "OpenAI", "Codex", "bin", "x64", "codex.exe"),
      ];
      const localCodex = candidates.find((candidate) => exists(candidate));
      if (localCodex) {
        return localCodex;
      }
      const nestedCodex = findNestedCodexExecutable(winPath.join(localAppData, "OpenAI", "Codex", "bin"), {
        exists,
        readdir,
      });
      if (nestedCodex) {
        return nestedCodex;
      }
    }
    const pathCodex = String(pathEnv)
      .split(";")
      .filter(Boolean)
      .map((entry) => winPath.join(entry, "codex.exe"))
      .find(
        (candidate) =>
          exists(candidate) && !candidate.toLowerCase().includes("\\microsoft\\windowsapps\\"),
      );
    return pathCodex ?? "codex";
  }
  const home = env.HOME;
  if (platform === "darwin") {
    // Codex Desktop was renamed to ChatGPT.app; both bundle a native codex
    // binary at a fixed absolute path, which is immune to the minimal PATH a
    // Finder-launched app inherits. Prefer the current app, then the legacy
    // one, then the npm/Homebrew CLI install locations.
    const bundledCandidates = [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ];
    const bundled = bundledCandidates.find((candidate) => exists(candidate));
    if (bundled) {
      return bundled;
    }
    const macCandidates = [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      home ? `${home}/.local/bin/codex` : null,
      home ? `${home}/.volta/bin/codex` : null,
    ].filter(Boolean);
    const macCodex = macCandidates.find((candidate) => exists(candidate));
    return macCodex ?? findNvmCodex({ env, exists, readdir }) ?? "codex";
  }
  // On Linux the binary often lands outside the spawn PATH (e.g. ~/.local/bin
  // from a user install, or /snap/bin from a snap), so probe the common install
  // locations before falling back to bare "codex" for PATH resolution.
  const linuxCandidates = [
    home ? `${home}/.local/bin/codex` : null,
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    "/snap/bin/codex",
    home ? `${home}/.volta/bin/codex` : null,
  ].filter(Boolean);
  const linuxCodex = linuxCandidates.find((candidate) => exists(candidate));
  return linuxCodex ?? findNvmCodex({ env, exists, readdir }) ?? "codex";
}

// Probes nvm-managed node installs for a global `codex`, newest node first.
// nvm's bin dirs are per-version and never on a GUI-launched app's PATH, so an
// npm-installed Codex CLI is otherwise unreachable from the desktop app.
function findNvmCodex({ env, exists, readdir }) {
  const root = env.NVM_DIR ?? (env.HOME ? `${env.HOME}/.nvm` : null);
  if (!root) {
    return null;
  }
  const versionsDir = `${root}/versions/node`;
  let entries;
  try {
    entries = readdir(versionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry?.isDirectory?.())
    .map((entry) => entry.name)
    .sort(compareNodeVersionsDesc);
  for (const name of versions) {
    const candidate = `${versionsDir}/${name}/bin/codex`;
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function compareNodeVersionsDesc(left, right) {
  const parse = (name) => name.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

// Bounded depth-first search for codex.exe under a directory, used on Windows
// where the install nests the binary inside a version-stamped subfolder. Bounded
// at maxDepth 4 so a pathological tree can never spin the search forever, and
// tolerant of unreadable directories (returns null rather than throwing).
function findNestedCodexExecutable(dir, { exists, readdir, depth = 0, maxDepth = 4 }) {
  const candidate = winPath.join(dir, "codex.exe");
  if (exists(candidate)) {
    return candidate;
  }
  if (depth >= maxDepth) {
    return null;
  }
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry?.isDirectory?.()) {
      continue;
    }
    const found = findNestedCodexExecutable(winPath.join(dir, entry.name), {
      exists,
      readdir,
      depth: depth + 1,
      maxDepth,
    });
    if (found) {
      return found;
    }
  }
  return null;
}

// Reads Codex Desktop's persisted workspace list: the active workspace, then
// the user's project order, then any other saved workspaces. Deduplicated.
function readCodexWorkspaceProjects(statePath) {
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [];
  }
  const active = state["active-workspace-roots"] ?? [];
  const order = state["project-order"] ?? [];
  const saved = state["electron-saved-workspace-roots"] ?? [];
  const labels = state["electron-workspace-root-labels"] ?? {};
  const seen = new Set();
  const projects = [];
  const hasLabel = (path) => typeof labels[path] === "string" && labels[path].trim();
  const add = (path, isActive) => {
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    projects.push({
      name: hasLabel(path) ? labels[path].trim() : basename(path),
      path,
      source: "codex-desktop",
      status: "available",
      active: isActive,
    });
  };
  for (const path of active) {
    add(path, true);
  }
  for (const path of [...order, ...saved]) {
    if (hasLabel(path)) {
      add(path, false);
    }
  }
  for (const path of [...order, ...saved]) {
    add(path, false);
  }
  return projects;
}

function approvalResultFor(method, decision) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const legacyDecision = decision === "accept"
      ? "approved"
      : decision === "acceptForSession"
        ? "approved_for_session"
        : "denied";
    return { decision: legacyDecision };
  }
  return { decision };
}

function normalizeThreadList(response) {
  return response.data ?? response.threads ?? [];
}

function normalizeTurnList(response) {
  return response.data ?? response.turns ?? response.thread?.turns ?? [];
}

// Walks a turn and pulls out user / assistant messages. The user prompt
// lives on the turn itself (set when turn/start was called); the agent's
// replies live in nested items. We collect both so the phone user gets
// genuine back-and-forth context, not just the agent half.
function extractTurnMessages(turn) {
  const out = [];
  // 1) User input on the turn.
  const inputs = turn?.input ?? turn?.userInput ?? [];
  for (const part of Array.isArray(inputs) ? inputs : []) {
    const text = typeof part === "string" ? part : part?.text;
    if (text) out.push({ role: "user", text });
  }
  // 2) Nested items (agent messages and potentially explicit user_message
  //    items in some shapes).
  const itemLists = [
    turn?.items,
    turn?.events,
    turn?.eventMsgs,
    turn?.output,
    turn?.agentOutput,
    turn?.payload?.items,
  ];
  for (const list of itemLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const type = item?.type ?? item?.payload?.type ?? null;
      const text = textFromThreadItem(item);
      if (!text) continue;
      if (type === "user_message" || type === "userMessage") {
        out.push({ role: "user", text });
      } else if (type === "agent_message" || type === "agentMessage") {
        out.push({ role: "assistant", text });
      } else if (type === "message") {
        const role = item.role ?? item.payload?.role ?? "assistant";
        out.push({ role: role === "user" ? "user" : "assistant", text });
      }
    }
  }
  return out;
}

function textFromThreadItem(item) {
  return item?.text ?? item?.payload?.text ?? textFromContent(item?.content) ?? null;
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = [];
  for (const part of content) {
    const text = typeof part === "string" ? part : part?.text;
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function agentMessageKey(threadId, itemId) {
  return `${threadId ?? ""}:${itemId ?? ""}`;
}

function isMethodMissingError(error) {
  // The JSON-RPC standard "Method not found" code is the reliable signal; the
  // message regex is the fallback for servers that drop it. Kept narrow so a
  // "thread not found", timeout, or auth error still rethrows.
  if (error?.code === -32601) {
    return true;
  }
  return /method not found|unknown method|no such method|unsupported method|not found.*method/i.test(
    error?.message ?? String(error),
  );
}

function isCliThread(thread) {
  return thread.source === "cli" || thread.threadSource === "cli";
}

function projectSourceValue(sources) {
  const hasDesktop = sources.has("codex-desktop");
  const hasCli = sources.has("codex-cli");
  if (hasDesktop && hasCli) {
    return "codex-desktop+cli";
  }
  return hasCli ? "codex-cli" : "codex-desktop";
}

function isActiveTurn(turn) {
  return ["inProgress", "running", "active"].includes(turn.status);
}
