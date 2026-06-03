import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, win32 as winPath } from "node:path";

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
  } = {}) {
    this.transport = transport;
    this.command = command ?? resolveCodexCommand();
    this.codexStatePath = codexStatePath;
    this.transportFactory =
      transportFactory ?? (() => this.transport ?? new StdioTransport({ command: this.command }));
    this.state = "not_connected";
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
    this.lastTokenUsage = null;
    this.lastRateLimits = null;
    // itemId -> file changes, so a file-change approval can show the diff.
    this.fileChangesByItem = new Map();
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
    }
    if (method === "item/fileChange/patchUpdated" && params.itemId) {
      this.fileChangesByItem.set(params.itemId, params.changes ?? []);
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
      this.#emit({
        type: "agentMessage",
        threadId: params.threadId ?? null,
        itemId: params.item.id ?? null,
        text: params.item.text ?? "",
      });
      return;
    }
    if (method === "turn/started") {
      this.#emit({ type: "turnStarted", threadId: params.threadId ?? null });
      return;
    }
    if (method === "turn/completed") {
      this.#emit({ type: "turnCompleted", threadId: params.threadId ?? null });
      return;
    }
    if (method === "item/started") {
      const itemType = params.item?.type;
      if (itemType === "commandExecution" || itemType === "fileChange") {
        this.#emit({ type: "progress", threadId: params.threadId ?? null, itemType });
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
      this.#emit({
        type: "error",
        threadId: params.threadId ?? null,
        message: params.message ?? params.error ?? "Codex 报告了一个错误",
      });
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
    return this.requestInitialize();
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
        this.startHeartbeat();
        return { alreadyInitialized: true };
      }
      throw error;
    }
    this.state = "connected";
    this.startHeartbeat();
    return result;
  }

  async listThreads({ cwd = null, limit = 20 } = {}) {
    return this.client.request("thread/list", {
      cwd,
      archived: false,
      limit,
      useStateDbOnly: false,
    });
  }

  async listProjects({ limit = 100 } = {}) {
    // Prefer Codex Desktop's own workspace list: the active workspace first,
    // then its project order. Falls back to thread history if unavailable.
    const workspaceProjects = readCodexWorkspaceProjects(this.codexStatePath);
    if (workspaceProjects.length > 0) {
      return workspaceProjects;
    }
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
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
  }

  async resumeThread({ threadId }) {
    return this.client.request("thread/resume", { threadId });
  }

  async startTurn({ threadId, text, cwd = null, images = [] }) {
    // The app-server input list accepts a `localImage` item for a local file
    // path; image attachments from the phone are forwarded this way so Codex
    // actually sees them (not just a path reference).
    const input = [{ type: "text", text, text_elements: [] }];
    for (const path of images) {
      input.push({ type: "localImage", path });
    }
    return this.client.request("turn/start", {
      threadId,
      input,
      cwd,
      approvalsReviewer: "user",
    });
  }

  // Fetches the latest N user/assistant messages from a thread by walking
  // its turn list and extracting whatever message-like items each turn
  // contains. Defensive against unknown shapes — returns [] if nothing
  // recognizable is found, with `_rawSample` populated so callers can log
  // the actual response shape and we can refine.
  async listRecentMessages({ threadId, limit = 5 }) {
    const response = await this.client.request("thread/turns/list", { threadId });
    const turns = normalizeTurnList(response);
    const messages = [];
    for (const turn of turns) {
      messages.push(...extractTurnMessages(turn));
    }
    return {
      messages: messages.slice(-limit),
      _rawSample: turns.slice(-1)[0] ?? null,
      _turnCount: turns.length,
    };
  }

  // Full paginated transcript for one thread, pulled live from Codex Desktop's
  // turn history. Returns the same shape as the local Transcript.listThread so
  // the HTTP route and frontend can treat both sources identically:
  // messages are newest-first, sliced by offset/limit.
  async getThreadTranscript({ threadId, limit = 20, offset = 0 }) {
    const response = await this.client.request("thread/turns/list", { threadId });
    const turns = normalizeTurnList(response);
    const all = [];
    for (const turn of turns) {
      all.push(...extractTurnMessages(turn));
    }
    const newestFirst = all.slice().reverse();
    const page = newestFirst.slice(offset, offset + limit);
    return {
      threadId,
      messages: page,
      total: all.length,
      hasMore: offset + page.length < all.length,
    };
  }

  async cancelTurn({ threadId }) {
    const turns = await this.client.request("thread/turns/list", { threadId });
    const activeTurn = normalizeTurnList(turns).find((turn) => isActiveTurn(turn));
    if (!activeTurn) {
      throw new Error(`no active turn for thread: ${threadId}`);
    }
    return this.client.request("turn/interrupt", { threadId, turnId: activeTurn.id });
  }

  listPendingApprovals() {
    return Array.from(this.pendingApprovals.values(), (approval) => ({ ...approval }));
  }

  async resolveApproval(idOrShortCode, decision) {
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

// Prefers the codex bundled inside Codex.app; falls back to a PATH lookup.
export function resolveCodexCommand({
  platform = process.platform,
  env = process.env,
  pathEnv = process.env.PATH ?? "",
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
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
      .find((candidate) => exists(candidate) && !candidate.toLowerCase().includes("\\microsoft\\windowsapps\\"));
    return pathCodex ?? "codex";
  }
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  return exists(bundled) ? bundled : "codex";
}

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
  const seen = new Set();
  const projects = [];
  const add = (path, isActive) => {
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    projects.push({
      name: basename(path),
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
    add(path, false);
  }
  return projects;
}

function approvalResultFor(method, decision) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: decision === "accept" ? "approved" : "denied" };
  }
  return { decision };
}

function normalizeThreadList(response) {
  return response.data ?? response.threads ?? [];
}

function normalizeTurnList(response) {
  return response.data ?? response.turns ?? [];
}

// Walks a turn and pulls out user / assistant messages. The user prompt
// lives on the turn itself (set when turn/start was called); the agent's
// replies live in nested items. We collect both so the phone user gets
// genuine back-and-forth context, not just the agent half.
function extractTurnMessages(turn) {
  const out = [];
  const seen = new Set();
  const push = (role, value) => {
    const text = textFromMessageValue(value);
    if (!text) return;
    const key = `${role}\0${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ role, text });
  };

  // 1) User input on the turn.
  const inputCandidates = [
    turn?.input,
    turn?.userInput,
    turn?.inputText,
    turn?.prompt,
    turn?.userPrompt,
    turn?.userMessage,
    turn?.request?.input,
    turn?.params?.input,
    turn?.payload?.input,
  ];
  for (const candidate of inputCandidates) {
    for (const text of textPartsFromValue(candidate)) {
      push("user", text);
    }
  }

  // 2) Nested items (agent messages and potentially explicit user_message
  //    items in some shapes).
  const itemLists = [
    turn?.items,
    turn?.events,
    turn?.eventMsgs,
    turn?.messages,
    turn?.output,
    turn?.agentOutput,
    turn?.payload?.items,
    turn?.payload?.messages,
  ];
  for (const list of itemLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const type = item?.type ?? item?.payload?.type ?? null;
      const text = textFromMessageValue(
        item?.text ??
          item?.payload?.text ??
          item?.content ??
          item?.payload?.content ??
          item?.message ??
          item?.payload?.message,
      );
      if (!text) continue;
      if (type === "user_message" || type === "userMessage") {
        push("user", text);
      } else if (type === "agent_message" || type === "agentMessage") {
        push("assistant", text);
      } else if (type === "message") {
        const role = item.role ?? item.payload?.role ?? "assistant";
        push(role === "user" ? "user" : "assistant", text);
      }
    }
  }
  return out;
}

function textPartsFromValue(value) {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((part) => textPartsFromValue(part));
  if (typeof value === "object") {
    const text = textFromMessageValue(value);
    return text ? [text] : [];
  }
  return [];
}

function textFromMessageValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(textFromMessageValue).filter(Boolean).join("\n").trim();
  }
  if (typeof value === "object") {
    return textFromMessageValue(
      value.text ??
        value.input_text ??
        value.output_text ??
        value.message ??
        value.content ??
        value.value,
    );
  }
  return "";
}

function basename(path) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
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
