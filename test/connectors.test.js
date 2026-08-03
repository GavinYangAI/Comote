import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  CodexDesktopConnector,
  extractChangePaths,
  resolveCodexCommand,
} from "../src/connectors/codex-desktop/index.js";
import { CodexCliConnector } from "../src/connectors/codex-cli/index.js";
import { spawnEnvFor, StdioTransport } from "../src/connectors/codex-desktop/json-rpc.js";

class MemoryTransport {
  constructor() {
    this.sent = [];
    this.messageHandler = null;
    this.open = false;
  }

  async connect() {
    this.open = true;
  }

  send(message) {
    const payload = JSON.parse(message);
    this.sent.push(payload);
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  receive(message) {
    this.messageHandler(JSON.stringify(message));
  }

  async close() {
    this.open = false;
  }
}

class FailingTransport {
  async connect() {
    throw new Error("ECONNREFUSED");
  }
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("desktop connector is the primary Codex connector", () => {
  const connector = new CodexDesktopConnector({ command: "codex" });

  assert.deepEqual(connector.getStatus(), {
    name: "Codex Desktop",
    role: "primary",
    state: "not_connected",
    protocol: "app-server",
    endpoint: "codex app-server (stdio)",
    command: "codex",
    lastError: null,
  });
});

test("desktop connector surfaces the failure reason through getStatus", async () => {
  const connector = new CodexDesktopConnector({
    command: "codex",
    transportFactory: () => new FailingTransport(),
  });

  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  const status = connector.getStatus();
  assert.equal(status.state, "not_connected");
  assert.match(status.lastError, /ECONNREFUSED/);
  clearTimeout(connector.reconnectTimer); // don't let the first-connect retry run during the suite
});

test("desktop connector initializes through app-server JSON-RPC", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  const initialized = connector.initialize();
  await flushAsyncWork();

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "comote",
        title: "Comote",
        // Connector reads from package.json; assert against whatever is on disk now.
        version: JSON.parse(readFileSync("package.json", "utf8")).version,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    },
  });

  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      userAgent: "codex-app-server-test",
      codexHome: "/home/test/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });

  assert.equal((await initialized).platformOs, "macos");
  assert.equal(connector.getStatus().state, "connected");
});

test("desktop connector initialize is idempotent once connected", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  const initialized = connector.initialize();
  await flushAsyncWork();
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: { platformOs: "macos" },
  });
  await initialized;
  assert.equal(connector.getStatus().state, "connected");
  const sentCount = transport.sent.length;
  // Re-clicking "retry connect" while already connected must not re-send.
  await connector.initialize();
  assert.equal(transport.sent.length, sentCount, "second initialize() must not re-send");
});

test("desktop connector treats 'Already initialized' as a successful connection", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  const initialized = connector.initialize();
  await flushAsyncWork();
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Already initialized" },
  });
  await initialized;
  assert.equal(connector.getStatus().state, "connected");
});

test("desktop connector surfaces a connection failure and schedules a quiet first-connect retry", async () => {
  const connector = new CodexDesktopConnector({
    transportFactory: () => new FailingTransport(),
  });

  // The failure is surfaced to the caller immediately (no silent swallowing)…
  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.equal(connector.getStatus().state, "not_connected");
  // …while a low-frequency background retry is scheduled so the connector
  // eventually comes up once codex is installed (A-5).
  assert.ok(connector.reconnectTimer, "first-connect retry must be scheduled");
  clearTimeout(connector.reconnectTimer);
});

test("desktop connector lists and starts Codex threads", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const listPromise = connector.listThreads({ cwd: "/repo" });
  await flushAsyncWork();
  assert.equal(transport.sent[0].method, "thread/list");
  assert.deepEqual(transport.sent[0].params, {
    cwd: "/repo",
    archived: false,
    limit: 20,
    useStateDbOnly: false,
  });
  transport.receive({ jsonrpc: "2.0", id: 1, result: { threads: [] } });
  assert.deepEqual(await listPromise, { threads: [] });

  const startPromise = connector.startThread({ cwd: "/repo" });
  await flushAsyncWork();
  assert.equal(transport.sent[1].method, "thread/start");
  assert.deepEqual(transport.sent[1].params, {
    cwd: "/repo",
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 2,
    result: {
      thread: { id: "thread_1" },
      model: "gpt-5.2",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/repo",
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "client",
      sandbox: { mode: "workspace-write" },
      permissionProfile: null,
      activePermissionProfile: null,
      reasoningEffort: null,
    },
  });
  assert.equal((await startPromise).thread.id, "thread_1");
});

test("desktop connector passes a pagination cursor through to thread/list", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  // Cursor shape verified against codex 0.144 app-server: request param is
  // `cursor`, response carries { data, nextCursor, backwardsCursor } with
  // ISO-8601 timestamp cursors.
  const listPromise = connector.listThreads({
    cwd: "/repo",
    limit: 2,
    cursor: "2026-07-13T13:49:16Z",
  });
  await flushAsyncWork();
  assert.equal(transport.sent[0].method, "thread/list");
  assert.deepEqual(transport.sent[0].params, {
    cwd: "/repo",
    archived: false,
    limit: 2,
    useStateDbOnly: false,
    cursor: "2026-07-13T13:49:16Z",
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      data: [{ id: "thread_2" }],
      nextCursor: "2026-07-13T13:12:06Z",
      backwardsCursor: "2026-07-13T06:22:32.803Z",
    },
  });
  // The response (including nextCursor) is forwarded untouched.
  assert.deepEqual(await listPromise, {
    data: [{ id: "thread_2" }],
    nextCursor: "2026-07-13T13:12:06Z",
    backwardsCursor: "2026-07-13T06:22:32.803Z",
  });

  // An empty/null cursor must NOT appear in the RPC params (first page).
  const firstPagePromise = connector.listThreads({ cwd: "/repo", limit: 2, cursor: null });
  await flushAsyncWork();
  assert.deepEqual(transport.sent[1].params, {
    cwd: "/repo",
    archived: false,
    limit: 2,
    useStateDbOnly: false,
  });
  transport.receive({ jsonrpc: "2.0", id: 2, result: { data: [], nextCursor: null, backwardsCursor: null } });
  await firstPagePromise;
});

test("desktop connector derives projects and marks Desktop or CLI sources", async () => {
  const transport = new MemoryTransport();
  // No global-state file -> falls back to deriving projects from thread history.
  const connector = new CodexDesktopConnector({ transport, codexStatePath: "/nonexistent/codex-state.json" });

  const projectsPromise = connector.listProjects();
  await flushAsyncWork();
  assert.equal(transport.sent[0].method, "thread/list");
  assert.deepEqual(transport.sent[0].params, {
    cwd: null,
    archived: false,
    limit: 100,
    useStateDbOnly: false,
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      threads: [
        { id: "thread_0", cwd: "/repo/cli-only", source: "cli" },
        { id: "thread_1", cwd: "/repo/comote", source: "desktop" },
        { id: "thread_2", cwd: "/repo/agentstaff" },
        { id: "thread_3", cwd: "/repo/comote", threadSource: "cli" },
      ],
    },
  });

  assert.deepEqual(await projectsPromise, [
    { name: "agentstaff", path: "/repo/agentstaff", source: "codex-desktop", status: "available" },
    { name: "cli-only", path: "/repo/cli-only", source: "codex-cli", status: "available" },
    { name: "comote", path: "/repo/comote", source: "codex-desktop+cli", status: "available" },
  ]);
});

test("desktop connector starts turns and records approval requests", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const turnPromise = connector.startTurn({
    threadId: "thread_1",
    text: "fix tests",
    cwd: "/repo",
  });
  await flushAsyncWork();
  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread_1",
      input: [{ type: "text", text: "fix tests", text_elements: [] }],
      cwd: "/repo",
    },
  });

  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "approval_1",
    params: {
      threadId: "thread_1",
      command: "npm test",
      cwd: "/repo",
    },
  });
  transport.receive({ jsonrpc: "2.0", id: 1, result: { turnId: "turn_1" } });

  assert.deepEqual(await turnPromise, { turnId: "turn_1" });
  assert.deepEqual(connector.listPendingApprovals(), [
    {
      id: "approval_1",
      rpcId: "approval_1",
      shortCode: "a1",
      threadId: "thread_1",
      changes: null,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread_1",
        command: "npm test",
        cwd: "/repo",
      },
    },
  ]);
});

test("desktop connector switches the approval reviewer for subsequent turns", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const updatePromise = connector.updateThreadSettings({
    threadId: "thread_1",
    approvalsReviewer: "auto_review",
  });
  await flushAsyncWork();

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/settings/update",
    params: {
      threadId: "thread_1",
      approvalsReviewer: "auto_review",
    },
  });
  transport.receive({ jsonrpc: "2.0", id: 1, result: {} });
  await updatePromise;
});

test("desktop connector lists models and updates model reasoning settings", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const modelsPromise = connector.listModels();
  await flushAsyncWork();
  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "model/list",
    params: {},
  });
  transport.receive({ jsonrpc: "2.0", id: 1, result: { data: [] } });
  assert.deepEqual(await modelsPromise, { data: [] });

  const updatePromise = connector.updateThreadSettings({
    threadId: "thread_1",
    model: "gpt-5.2-codex",
    reasoningEffort: "high",
  });
  await flushAsyncWork();
  assert.deepEqual(transport.sent[1], {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/settings/update",
    params: {
      threadId: "thread_1",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
    },
  });
  transport.receive({ jsonrpc: "2.0", id: 2, result: {} });
  await updatePromise;
});

test("desktop connector forwards images as localImage input items", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  connector.startTurn({
    threadId: "thread_1",
    text: "what is in this picture?",
    cwd: "/repo",
    images: ["/repo/.comote/uploads/a.png"],
  });
  await flushAsyncWork();

  assert.deepEqual(transport.sent[0].params.input, [
    { type: "text", text: "what is in this picture?", text_elements: [] },
    { type: "localImage", path: "/repo/.comote/uploads/a.png" },
  ]);
});

test("cli connector passes images via a comma-separated --image flag", async () => {
  const calls = [];
  const connector = new CodexCliConnector({
    command: "codex",
    execFileAsync: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok", stderr: "" };
    },
  });

  await connector.runPrompt({
    cwd: "/repo",
    text: "describe these",
    images: ["/repo/.comote/uploads/a.png", "/repo/.comote/uploads/b.png"],
  });

  assert.equal(calls[0].file, "codex");
  const imageIdx = calls[0].args.indexOf("--image");
  assert.ok(imageIdx >= 0, "expected --image flag");
  assert.equal(calls[0].args[imageIdx + 1], "/repo/.comote/uploads/a.png,/repo/.comote/uploads/b.png");
});

test("cli connector omits --image when there are no images", async () => {
  const calls = [];
  const connector = new CodexCliConnector({
    command: "codex",
    execFileAsync: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "ok", stderr: "" };
    },
  });

  await connector.runPrompt({ cwd: "/repo", text: "hi" });

  assert.ok(!calls[0].args.includes("--image"));
});

test("cli connector captures the real Codex thread id and final message from JSONL", async () => {
  const calls = [];
  const connector = new CodexCliConnector({
    command: "codex",
    execFileAsync: async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "019abcde-1234" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        ].join("\n"),
        stderr: "",
      };
    },
  });

  const result = await connector.runPrompt({ cwd: "/repo", text: "fix it" });

  assert.equal(result.id, "019abcde-1234");
  assert.equal(result.output, "done");
  assert.ok(calls[0].args.includes("--json"));
});

test("cli connector resumes a selected Codex thread", async () => {
  const calls = [];
  const connector = new CodexCliConnector({
    command: "codex",
    execFileAsync: async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "continued" },
        }),
        stderr: "",
      };
    },
  });

  const result = await connector.runPrompt({
    cwd: "/repo",
    text: "continue",
    resumeId: "019abcde-1234",
  });

  assert.deepEqual(calls[0].args, [
    "exec",
    "--skip-git-repo-check",
    "-C",
    "/repo",
    "resume",
    "--json",
    "019abcde-1234",
    "continue",
  ]);
  assert.equal(result.id, "019abcde-1234");
  assert.equal(result.output, "continued");
});

test("desktop connector emits thread events and routes approvals by short code", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  const events = [];
  connector.onEvent = (event) => events.push(event);
  await connector.client.connect(); // registers the transport message handler

  transport.receive({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: "thread_9" },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_9",
      item: { type: "agentMessage", id: "item_1", text: "done fixing tests" },
    },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "approval_9",
    params: { threadId: "thread_9", command: "rm -rf build", cwd: "/repo" },
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["turnStarted", "agentMessage", "approval"],
  );
  assert.equal(events[1].text, "done fixing tests");
  assert.equal(events[1].threadId, "thread_9");

  // The short code assigned to the approval resolves the same request.
  const shortCode = events[2].approval.shortCode;
  assert.deepEqual(await connector.resolveApproval(shortCode, "accept"), { ok: true });
  assert.deepEqual(connector.listPendingApprovals(), []);
  assert.equal(transport.sent.at(-1).id, "approval_9");
});

test("file-change approvals carry the diff so the phone can show what changes", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();

  // The patch arrives before the approval request, keyed by itemId.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_5",
      changes: [{ path: "src/app.js", kind: { type: "update", move_path: null }, diff: "+a\n+b\n-c" }],
    },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "item/fileChange/requestApproval",
    id: "approval_5",
    params: { threadId: "thread_1", turnId: "turn_1", itemId: "item_5" },
  });

  const [approval] = connector.listPendingApprovals();
  assert.equal(approval.changes.length, 1);
  assert.equal(approval.changes[0].path, "src/app.js");
});

test("desktop connector lists the active workspace first, then project order", async () => {
  const statePath = join(tmpdir(), `comote-codex-state-${process.pid}.json`);
  writeFileSync(
    statePath,
    JSON.stringify({
      "active-workspace-roots": ["/home/test/projects/team-skills"],
      "project-order": ["/home/test/projects/alpha", "/home/test/projects/beta"],
      "electron-saved-workspace-roots": ["/home/test/projects/alpha", "/home/test/projects/worktrees/team-skills"],
      "electron-workspace-root-labels": {
        "/home/test/projects/team-skills": "Team Skills",
        "/home/test/projects/worktrees/team-skills": "Team Skills Worktree",
      },
    }),
  );
  try {
    const transport = new MemoryTransport();
    const connector = new CodexDesktopConnector({ transport, codexStatePath: statePath });
    // listProjects now also consults thread history for the merge (E-3);
    // answer with an empty list so this test stays about workspace ordering.
    const projectsPromise = connector.listProjects();
    await flushAsyncWork();
    transport.receive({ jsonrpc: "2.0", id: 1, result: { threads: [] } });
    const projects = await projectsPromise;
    assert.deepEqual(
      projects.map((p) => [p.name, p.active]),
      [
        ["Team Skills", true],
        ["Team Skills Worktree", false],
        ["alpha", false],
        ["beta", false],
      ],
    );
  } finally {
    rmSync(statePath, { force: true });
  }
});

test("desktop connector resumes existing Codex Desktop threads", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const resumePromise = connector.resumeThread({ threadId: "thread_1" });
  await flushAsyncWork();

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/resume",
    params: { threadId: "thread_1" },
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: { thread: { id: "thread_1", preview: "Existing thread" } },
  });

  assert.deepEqual(await resumePromise, { thread: { id: "thread_1", preview: "Existing thread" } });
});

test("desktop connector reads recent messages with thread/read", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const recentPromise = connector.listRecentMessages({ threadId: "thread_1", limit: 2 });
  await flushAsyncWork();

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/read",
    params: { threadId: "thread_1", includeTurns: true },
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      thread: {
        turns: [
          {
            id: "turn_1",
            items: [
              {
                type: "userMessage",
                id: "item_user",
                content: [{ type: "text", text: "continue from Feishu", text_elements: [] }],
              },
              { type: "agentMessage", id: "item_agent", text: "done" },
            ],
          },
        ],
      },
    },
  });

  assert.deepEqual(await recentPromise, {
    messages: [
      { role: "user", text: "continue from Feishu" },
      { role: "assistant", text: "done" },
    ],
    total: 2,
    _rawSample: {
      id: "turn_1",
      items: [
        {
          type: "userMessage",
          id: "item_user",
          content: [{ type: "text", text: "continue from Feishu", text_elements: [] }],
        },
        { type: "agentMessage", id: "item_agent", text: "done" },
      ],
    },
    _turnCount: 1,
  });
});

test("desktop connector interrupts the active turn when cancelling", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  const cancelPromise = connector.cancelTurn({ threadId: "thread_1" });
  await flushAsyncWork();
  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/read",
    params: { threadId: "thread_1", includeTurns: true },
  });
  transport.receive({
    jsonrpc: "2.0",
    id: 1,
    result: {
      thread: {
        turns: [
          { id: "turn_done", status: "completed" },
          { id: "turn_active", status: "inProgress" },
        ],
      },
    },
  });
  await flushAsyncWork();
  assert.deepEqual(transport.sent[1], {
    jsonrpc: "2.0",
    id: 2,
    method: "turn/interrupt",
    params: { threadId: "thread_1", turnId: "turn_active" },
  });
  transport.receive({ jsonrpc: "2.0", id: 2, result: { ok: true } });

  assert.deepEqual(await cancelPromise, { ok: true });
});

test("desktop connector resolves command approval requests", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  connector.client.handleMessage({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "approval_1",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      startedAtMs: 1,
      command: "npm test",
      cwd: "/repo",
    },
  });

  await connector.resolveApproval("approval_1", "accept");

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: "approval_1",
    result: { decision: "accept" },
  });
  assert.deepEqual(connector.listPendingApprovals(), []);
});

test("desktop connector allows an approval for the current Codex session", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  connector.client.handleMessage({
    jsonrpc: "2.0",
    method: "item/fileChange/requestApproval",
    id: "approval_session",
    params: { threadId: "thread_1", turnId: "turn_1", itemId: "item_1" },
  });

  await connector.resolveApproval("approval_session", "acceptForSession");

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: "approval_session",
    result: { decision: "acceptForSession" },
  });
});

test("desktop connector resolves legacy exec approvals", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  connector.client.handleMessage({
    jsonrpc: "2.0",
    method: "execCommandApproval",
    id: "approval_legacy",
    params: { command: "git push" },
  });

  await connector.resolveApproval("approval_legacy", "decline");

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: "approval_legacy",
    result: { decision: "denied" },
  });
});

test("desktop connector maps session approval to the legacy decision", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });

  connector.client.handleMessage({
    jsonrpc: "2.0",
    method: "applyPatchApproval",
    id: "approval_legacy_session",
    params: { path: "src/app.js" },
  });

  await connector.resolveApproval("approval_legacy_session", "acceptForSession");

  assert.deepEqual(transport.sent[0], {
    jsonrpc: "2.0",
    id: "approval_legacy_session",
    result: { decision: "approved_for_session" },
  });
});

test("malformed stdout line is dropped without tearing down the read loop", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();
  const events = [];
  connector.onEvent = (event) => events.push(event);

  // Feed a non-JSON line through the exact path StdioTransport drives:
  // transport.onMessage(handler) wires handler === client.handleMessage, and
  // the stdout 'data' handler calls it with a raw string per newline.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.doesNotThrow(() => transport.messageHandler("not json{"));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);

  // A subsequent VALID message must still be parsed and dispatched — proving
  // the loop survived the malformed line.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/updated",
    params: {
      threadId: "thread_malformed",
      item: { type: "agentMessage", id: "item_ok", text: "still alive" },
    },
  });

  assert.ok(
    events.some((event) => event.type === "agentMessageDelta" && event.text === "still alive"),
    "valid message after a malformed line should still dispatch",
  );
});

test("desktop connector emits agentMessageDelta on item/updated", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();
  const events = [];
  connector.onEvent = (event) => events.push(event);

  transport.receive({
    jsonrpc: "2.0",
    method: "item/updated",
    params: {
      threadId: "thread_7",
      item: { type: "agentMessage", id: "item_9", text: "partial answer" },
    },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "agentMessageDelta",
    threadId: "thread_7",
    itemId: "item_9",
    text: "partial answer",
  });
});

test("extractChangePaths handles array and object change shapes", () => {
  assert.deepEqual(extractChangePaths([{ path: "/p/a.ts" }, { absolutePath: "/p/b.ts" }]), ["/p/a.ts", "/p/b.ts"]);
  assert.deepEqual(extractChangePaths({ "/p/c.ts": { kind: "edit" } }), ["/p/c.ts"]);
  assert.deepEqual(extractChangePaths(null), []);
});

test("turnCompleted carries accumulated changed paths then clears", () => {
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  const events = [];
  connector.onEvent = (e) => events.push(e);

  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({
    method: "item/started",
    params: { threadId: "t1", item: { id: "i1", type: "fileChange", changes: [{ path: "/p/a.ts" }] } },
  });
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });

  const completed = events.find((e) => e.type === "turnCompleted");
  assert.deepEqual(completed.changedPaths, ["/p/a.ts"]);

  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });
  const second = events.filter((e) => e.type === "turnCompleted").at(-1);
  assert.deepEqual(second.changedPaths, []);
});

test("turnCompleted accumulates paths from the patchUpdated branch", () => {
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  const events = [];
  connector.onEvent = (e) => events.push(e);

  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  // Real app-server shape: params.itemId / params.changes / params.threadId.
  connector.handleNotification({
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "t1",
      itemId: "item_5",
      changes: [{ path: "src/app.js", kind: { type: "update", move_path: null }, diff: "+a" }],
    },
  });
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });

  const completed = events.find((e) => e.type === "turnCompleted");
  assert.deepEqual(completed.changedPaths, ["src/app.js"]);
});

test("changedPaths dedupes the union across multiple fileChange notifications in one turn", () => {
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  const events = [];
  connector.onEvent = (e) => events.push(e);

  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({
    method: "item/started",
    params: { threadId: "t1", item: { id: "i1", type: "fileChange", changes: [{ path: "/p/a.ts" }] } },
  });
  // Second notification repeats /p/a.ts and adds /p/b.ts — result must be the deduped union.
  connector.handleNotification({
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "t1",
      itemId: "i2",
      changes: [{ path: "/p/a.ts" }, { path: "/p/b.ts" }],
    },
  });
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });

  const completed = events.find((e) => e.type === "turnCompleted");
  assert.deepEqual(completed.changedPaths, ["/p/a.ts", "/p/b.ts"]);
});

test("agentMessage carries the accumulated changed paths without clearing them", () => {
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  const events = [];
  connector.onEvent = (e) => events.push(e);

  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  // A file edit completes DURING the turn, before the agent's final message.
  connector.handleNotification({
    method: "item/started",
    params: { threadId: "t1", item: { id: "i1", type: "fileChange", changes: [{ path: "/p/a.png" }] } },
  });
  // The agent's final message arrives (item/completed agentMessage) before turn/completed.
  connector.handleNotification({
    method: "item/completed",
    params: { threadId: "t1", item: { type: "agentMessage", id: "m1", text: "done" } },
  });

  const agentMessage = events.find((e) => e.type === "agentMessage");
  assert.deepEqual(agentMessage.changedPaths, ["/p/a.png"]);

  // turn/completed still works and still carries + clears the same paths.
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });
  const completed = events.find((e) => e.type === "turnCompleted");
  assert.deepEqual(completed.changedPaths, ["/p/a.png"]);

  // A subsequent turn starts clean — agentMessage did not leave stale state.
  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({
    method: "item/completed",
    params: { threadId: "t1", item: { type: "agentMessage", id: "m2", text: "again" } },
  });
  const secondAgentMessage = events.filter((e) => e.type === "agentMessage").at(-1);
  assert.deepEqual(secondAgentMessage.changedPaths, []);
});

test("handleDisconnect drops mid-turn accumulation so it does not bleed into the next turn", () => {
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  const events = [];
  connector.onEvent = (e) => events.push(e);

  // Turn starts, a file changes, then the connection drops mid-turn (no turn/completed).
  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({
    method: "item/started",
    params: { threadId: "t1", item: { id: "i1", type: "fileChange", changes: [{ path: "/stale/x.ts" }] } },
  });
  connector.handleDisconnect();

  // After reconnect the app-server re-drives state: a fresh turn on the same thread.
  connector.handleNotification({ method: "turn/started", params: { threadId: "t1" } });
  connector.handleNotification({
    method: "item/started",
    params: { threadId: "t1", item: { id: "i2", type: "fileChange", changes: [{ path: "/fresh/y.ts" }] } },
  });
  connector.handleNotification({ method: "turn/completed", params: { threadId: "t1" } });

  const completed = events.filter((e) => e.type === "turnCompleted").at(-1);
  assert.deepEqual(completed.changedPaths, ["/fresh/y.ts"]);
});

test("desktop connector accumulates Codex 0.136 agentMessage deltas", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();
  const events = [];
  connector.onEvent = (event) => events.push(event);

  transport.receive({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId: "thread_7", turnId: "turn_1", itemId: "item_9", delta: "partial " },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId: "thread_7", turnId: "turn_1", itemId: "item_9", delta: "answer" },
  });

  assert.deepEqual(events, [
    {
      type: "agentMessageDelta",
      threadId: "thread_7",
      itemId: "item_9",
      text: "partial ",
    },
    {
      type: "agentMessageDelta",
      threadId: "thread_7",
      itemId: "item_9",
      text: "partial answer",
    },
  ]);
});

test("item/completed clears the accumulated delta text so it does not leak across turns", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();
  const events = [];
  connector.onEvent = (event) => events.push(event);

  // First message streams in via deltas, then completes.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId: "thread_7", itemId: "item_9", delta: "first message" },
  });
  connector.handleNotification({
    method: "item/completed",
    params: { threadId: "thread_7", item: { type: "agentMessage", id: "item_9", text: "first message" } },
  });

  // A later delta reusing the same itemId must NOT include the pre-completed
  // text — completion reset the accumulation.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId: "thread_7", itemId: "item_9", delta: "second" },
  });

  const lastDelta = events.filter((e) => e.type === "agentMessageDelta").at(-1);
  assert.equal(lastDelta.text, "second");
});

test("listThreadTurns falls back to thread/turns/list when thread/read is missing", async () => {
  const turns = [{ id: "turn_1", status: "completed" }];
  let firstCall = true;
  const fakeClient = {
    request(method) {
      if (method === "thread/read") {
        assert.ok(firstCall, "thread/read is attempted first");
        firstCall = false;
        const error = new Error("method not found: thread/read");
        error.code = -32601;
        return Promise.reject(error);
      }
      if (method === "thread/turns/list") {
        return Promise.resolve({ turns });
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  connector.client = fakeClient;

  const result = await connector.listThreadTurns({ threadId: "thread_1" });
  assert.deepEqual(result, turns);
});

test("listThreadTurns rethrows a non-method-missing thread/read error (no fallback)", async () => {
  let turnsListCalled = false;
  const fakeClient = {
    request(method) {
      if (method === "thread/read") {
        return Promise.reject(new Error("thread not found"));
      }
      if (method === "thread/turns/list") {
        turnsListCalled = true;
        return Promise.resolve({ turns: [] });
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  connector.client = fakeClient;

  await assert.rejects(
    () => connector.listThreadTurns({ threadId: "thread_1" }),
    /thread not found/,
  );
  assert.equal(turnsListCalled, false, "must not fall back on a non-method-missing error");
});

test("listThreadTurns falls back on a message-only method-missing error (code dropped)", async () => {
  const turns = [{ id: "turn_1", status: "inProgress" }];
  const fakeClient = {
    request(method) {
      if (method === "thread/read") {
        // No .code preserved — only the message signals the missing method.
        return Promise.reject(new Error("Method not found"));
      }
      if (method === "thread/turns/list") {
        return Promise.resolve({ data: turns });
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const connector = new CodexDesktopConnector({ transport: new MemoryTransport() });
  connector.client = fakeClient;

  const result = await connector.listThreadTurns({ threadId: "thread_1" });
  assert.deepEqual(result, turns);
});

test("handleDisconnect clears the agentMessage delta map", async () => {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();

  transport.receive({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId: "thread_7", itemId: "item_9", delta: "leaked" },
  });
  assert.ok(connector.agentMessageTextByItem.size > 0, "delta accumulated before disconnect");

  connector.handleDisconnect();
  assert.equal(connector.agentMessageTextByItem.size, 0, "delta map cleared on disconnect");
});

test("cli connector is explicitly fallback", () => {
  const connector = new CodexCliConnector({ command: "codex" });

  assert.deepEqual(connector.getStatus(), {
    name: "Codex CLI",
    role: "fallback",
    state: "available",
    command: "codex",
  });
});

test("cli connector reports not_found when the resolved binary is missing", () => {
  const missing = new CodexCliConnector({
    command: "/resolved/but/gone/codex",
    exists: () => false,
  });
  assert.equal(missing.getStatus().state, "not_found");

  const present = new CodexCliConnector({
    command: "/resolved/and/present/codex",
    exists: (c) => c === "/resolved/and/present/codex",
  });
  assert.equal(present.getStatus().state, "available");
});

test("resolveCodexCommand finds codex.exe in LOCALAPPDATA on Windows", () => {
  const localAppData = "C:\\Users\\you\\AppData\\Local";
  const expected = "C:\\Users\\you\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  const command = resolveCodexCommand({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    pathEnv: "",
    exists: (candidate) => candidate === expected,
    readdir: () => [],
  });
  assert.equal(command, expected);
});

test("resolveCodexCommand recurses into nested LOCALAPPDATA layouts on Windows", () => {
  const localAppData = "C:\\Users\\you\\AppData\\Local";
  const binRoot = "C:\\Users\\you\\AppData\\Local\\OpenAI\\Codex\\bin";
  const nested = "C:\\Users\\you\\AppData\\Local\\OpenAI\\Codex\\bin\\1.2.3\\codex.exe";
  const dirEntry = (name) => ({ name, isDirectory: () => true });
  const command = resolveCodexCommand({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    pathEnv: "",
    exists: (candidate) => candidate === nested,
    readdir: (dir) => (dir === binRoot ? [dirEntry("1.2.3")] : []),
  });
  assert.equal(command, nested);
});

test("resolveCodexCommand uses PATH on Windows but skips the WindowsApps shim", () => {
  const shim = "C:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe";
  const real = "C:\\Tools\\codex\\codex.exe";
  const command = resolveCodexCommand({
    platform: "win32",
    env: {},
    pathEnv: "C:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools\\codex",
    exists: (candidate) => candidate === shim || candidate === real,
    readdir: () => [],
  });
  assert.equal(command, real);
});

test("resolveCodexCommand falls back to bare 'codex' when only the WindowsApps shim is on PATH", () => {
  const shim = "C:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe";
  const command = resolveCodexCommand({
    platform: "win32",
    env: {},
    pathEnv: "C:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps",
    exists: (candidate) => candidate === shim,
    readdir: () => [],
  });
  assert.equal(command, "codex");
});

test("resolveCodexCommand prefers the ChatGPT.app bundled binary on macOS", () => {
  // Codex Desktop was renamed to ChatGPT.app; its bundled codex is a native
  // binary at a fixed absolute path — the most robust choice for a GUI app.
  const chatgpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const legacy = "/Applications/Codex.app/Contents/Resources/codex";
  assert.equal(
    resolveCodexCommand({
      platform: "darwin",
      env: {},
      exists: (c) => c === chatgpt || c === legacy,
      readdir: () => [],
    }),
    chatgpt,
  );
});

test("resolveCodexCommand still honors the legacy Codex.app binary on macOS", () => {
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  assert.equal(
    resolveCodexCommand({ platform: "darwin", exists: (c) => c === bundled }),
    bundled,
  );
  assert.equal(
    resolveCodexCommand({ platform: "darwin", env: {}, exists: () => false, readdir: () => [] }),
    "codex",
  );
});

test("resolveCodexCommand honors the COMOTE_CODEX_PATH override on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(
      resolveCodexCommand({
        platform,
        env: { COMOTE_CODEX_PATH: "/custom/bin/codex" },
        exists: () => false,
        readdir: () => [],
      }),
      "/custom/bin/codex",
    );
  }
});

test("resolveCodexCommand probes Homebrew and user bins on macOS when Codex.app is gone", () => {
  const brew = "/opt/homebrew/bin/codex";
  assert.equal(
    resolveCodexCommand({
      platform: "darwin",
      env: { HOME: "/Users/you" },
      exists: (c) => c === brew,
      readdir: () => [],
    }),
    brew,
  );
  const local = "/Users/you/.local/bin/codex";
  assert.equal(
    resolveCodexCommand({
      platform: "darwin",
      env: { HOME: "/Users/you" },
      exists: (c) => c === local,
      readdir: () => [],
    }),
    local,
  );
});

test("resolveCodexCommand finds an nvm-installed codex on macOS, newest node first", () => {
  const dirEntry = (name) => ({ name, isDirectory: () => true });
  const versionsDir = "/Users/you/.nvm/versions/node";
  const newest = `${versionsDir}/v22.22.2/bin/codex`;
  const older = `${versionsDir}/v18.20.0/bin/codex`;
  assert.equal(
    resolveCodexCommand({
      platform: "darwin",
      env: { HOME: "/Users/you" },
      exists: (c) => c === newest || c === older,
      readdir: (dir) =>
        dir === versionsDir ? [dirEntry("v18.20.0"), dirEntry("v22.22.2")] : [],
    }),
    newest,
  );
});

test("spawnEnvFor prepends an absolute command's directory to PATH", () => {
  // An npm-installed codex is a `#!/usr/bin/env node` script; `node` sits in
  // the same bin dir, which a GUI-launched app's minimal PATH does not include.
  const env = spawnEnvFor("/Users/you/.nvm/versions/node/v22.22.2/bin/codex", {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/you",
  });
  // spawnEnvFor joins with the host platform's PATH delimiter (":" on POSIX,
  // ";" on Windows) — build the expectation the same way so this test passes
  // on the Windows release CI too.
  assert.equal(
    env.PATH,
    `/Users/you/.nvm/versions/node/v22.22.2/bin${delimiter}/usr/bin:/bin`,
  );
  assert.equal(env.HOME, "/Users/you");
});

test("StdioTransport turns spawn ENOENT into an actionable codex-not-found error", async () => {
  const missing =
    process.platform === "win32"
      ? "C:\\nonexistent\\comote-test\\codex.exe"
      : "/nonexistent/comote-test/codex";
  const transport = new StdioTransport({ command: missing });
  await assert.rejects(transport.connect(), (error) => {
    assert.match(error.message, /找不到 codex 可执行文件/);
    assert.ok(error.message.includes(missing), "error must name the resolved command path");
    assert.match(error.message, /COMOTE_CODEX_PATH/);
    return true;
  });
});

test("spawnEnvFor inherits the environment untouched for bare commands", () => {
  assert.equal(spawnEnvFor("codex", { PATH: "/usr/bin" }), undefined);
});

test("resolveCodexCommand respects NVM_DIR and falls back to older nvm nodes", () => {
  const dirEntry = (name) => ({ name, isDirectory: () => true });
  const versionsDir = "/opt/nvm/versions/node";
  const older = `${versionsDir}/v18.20.0/bin/codex`;
  assert.equal(
    resolveCodexCommand({
      platform: "linux",
      env: { HOME: "/home/you", NVM_DIR: "/opt/nvm" },
      exists: (c) => c === older,
      readdir: (dir) =>
        dir === versionsDir ? [dirEntry("v18.20.0"), dirEntry("v22.22.2")] : [],
    }),
    older,
  );
});

test("resolveCodexCommand finds ~/.local/bin/codex on Linux", () => {
  const local = "/home/gavin/.local/bin/codex";
  assert.equal(
    resolveCodexCommand({
      platform: "linux",
      env: { HOME: "/home/gavin" },
      exists: (c) => c === local,
    }),
    local,
  );
});

test("resolveCodexCommand probes system Linux install locations", () => {
  assert.equal(
    resolveCodexCommand({
      platform: "linux",
      env: { HOME: "/home/gavin" },
      exists: (c) => c === "/snap/bin/codex",
    }),
    "/snap/bin/codex",
  );
});

test("resolveCodexCommand falls back to bare 'codex' on Linux when none exist", () => {
  assert.equal(
    resolveCodexCommand({
      platform: "linux",
      env: { HOME: "/home/gavin" },
      exists: () => false,
    }),
    "codex",
  );
});

// ---------------------------------------------------------------------------
// E-3: listProjects merges the workspace list with thread-history projects.
// ---------------------------------------------------------------------------

test("listProjects merges workspace projects with thread-history projects", async () => {
  const statePath = join(tmpdir(), `comote-codex-merge-${process.pid}.json`);
  writeFileSync(
    statePath,
    JSON.stringify({
      "active-workspace-roots": ["/repo/active"],
      "project-order": ["/repo/comote"],
      "electron-workspace-root-labels": { "/repo/comote": "Comote" },
    }),
  );
  try {
    const transport = new MemoryTransport();
    const connector = new CodexDesktopConnector({ transport, codexStatePath: statePath });
    const projectsPromise = connector.listProjects();
    await flushAsyncWork();
    assert.equal(transport.sent[0].method, "thread/list");
    transport.receive({
      jsonrpc: "2.0",
      id: 1,
      result: {
        threads: [
          // Already a workspace project — must be deduped, workspace entry wins.
          { id: "t1", cwd: "/repo/comote", source: "cli" },
          // Thread-only projects — appended after the workspace list, by name.
          { id: "t2", cwd: "/repo/zeta", source: "cli" },
          { id: "t3", cwd: "/repo/alpha" },
        ],
      },
    });
    const projects = await projectsPromise;
    assert.deepEqual(
      projects.map((p) => [p.name, p.path, p.source]),
      [
        ["active", "/repo/active", "codex-desktop"],
        ["Comote", "/repo/comote", "codex-desktop"],
        ["alpha", "/repo/alpha", "codex-desktop"],
        ["zeta", "/repo/zeta", "codex-cli"],
      ],
    );
    // Workspace ordering (active first) is preserved by the merge.
    assert.equal(projects[0].active, true);
  } finally {
    rmSync(statePath, { force: true });
  }
});

test("listProjects degrades to the workspace list when thread/list fails", async () => {
  const statePath = join(tmpdir(), `comote-codex-degrade-${process.pid}.json`);
  writeFileSync(statePath, JSON.stringify({ "active-workspace-roots": ["/repo/only"] }));
  try {
    const connector = new CodexDesktopConnector({
      transport: new FailingTransport(),
      codexStatePath: statePath,
    });
    const projects = await connector.listProjects();
    assert.deepEqual(projects.map((p) => p.path), ["/repo/only"]);
  } finally {
    rmSync(statePath, { force: true });
  }
});

test("listProjects still rejects when both sources are unavailable", async () => {
  // Preserves discoverProjects' ability to tell "desktop offline" (keep the
  // last known project list) apart from "reachable but empty" (clear it).
  const connector = new CodexDesktopConnector({
    transport: new FailingTransport(),
    codexStatePath: "/nonexistent/codex-state.json",
  });
  await assert.rejects(connector.listProjects(), /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// C-4: the codex app-server child's stderr is captured (bounded) and surfaced
// through lastError on initialize failure and disconnect.
// ---------------------------------------------------------------------------

async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test("StdioTransport keeps a bounded tail of the child's stderr", async () => {
  // A child that writes >4KB to stderr and exits: the tail must retain the
  // newest bytes and never exceed the 4KB cap.
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stderr.write('x'.repeat(5000) + 'TAIL-END'); process.exit(1)"],
  });
  await transport.connect();
  await waitFor(() => transport.getStderrTail().endsWith("TAIL-END"));
  assert.ok(transport.getStderrTail().length <= 4096, "stderr tail must stay bounded");
  await transport.close();
});

test("initialize failure surfaces the stderr tail through lastError, capped at 500 chars", async () => {
  const transport = {
    async connect() {
      throw new Error("Codex app-server 连接已断开");
    },
    // Longer than the 500-char lastError cap on purpose.
    getStderrTail: () => `${"y".repeat(600)} codex: 请先运行 codex login\n`,
  };
  const connector = new CodexDesktopConnector({ transport, command: "codex" });
  await assert.rejects(connector.initialize(), /连接已断开/);
  assert.match(connector.lastError, /连接已断开/);
  assert.match(connector.lastError, /stderr: /);
  assert.ok(connector.lastError.includes("codex: 请先运行 codex login"));
  const stderrPart = connector.lastError.split("stderr: ")[1];
  assert.ok(stderrPart.length <= 500, "lastError must not carry the full 4KB tail");
  clearTimeout(connector.reconnectTimer);
});

test("initialize failure without a stderr-capable transport keeps the plain error", async () => {
  // Injected transports (tests, future alternates) may not implement
  // getStderrTail — the connector must defend with optional chaining.
  const connector = new CodexDesktopConnector({ transportFactory: () => new FailingTransport() });
  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.equal(connector.lastError, "ECONNREFUSED");
  clearTimeout(connector.reconnectTimer);
});

test("a disconnect captures the stderr tail into lastError", async () => {
  const transport = new MemoryTransport();
  let transportCloseHandler = null;
  transport.onClose = (handler) => {
    transportCloseHandler = handler;
  };
  transport.getStderrTail = () => "thread 'main' panicked at 'not logged in'";
  const connector = new CodexDesktopConnector({ transport });
  await connector.client.connect();

  transportCloseHandler?.();

  assert.equal(connector.state, "reconnecting");
  assert.match(connector.lastError, /stderr: thread 'main' panicked at 'not logged in'/);
  clearTimeout(connector.reconnectTimer);
});

// ---------------------------------------------------------------------------
// A-5: a FIRST connect failure schedules a quiet fixed-interval retry (the
// exponential-backoff reconnect only ever ran after a successful connection).
// ---------------------------------------------------------------------------

// Transport that connects and answers `initialize` on its own, so retry loops
// can complete without the test hand-feeding responses.
class AutoInitTransport {
  constructor() {
    this.messageHandler = null;
  }

  async connect() {}

  send(message) {
    const payload = JSON.parse(message);
    if (payload.method === "initialize") {
      queueMicrotask(() =>
        this.messageHandler?.(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { platformOs: "macos" } }),
        ),
      );
    }
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  async close() {}
}

test("first-connect failure schedules a quiet retry that connects once codex appears", async () => {
  let attempts = 0;
  const connector = new CodexDesktopConnector({
    firstConnectRetryMs: 5,
    transportFactory: () => {
      attempts += 1;
      // codex "missing" on the first attempt, "installed" afterwards.
      return attempts === 1 ? new FailingTransport() : new AutoInitTransport();
    },
  });
  const events = [];
  connector.onEvent = (event) => events.push(event.type);

  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.ok(connector.reconnectTimer, "first-connect retry must be scheduled");
  assert.equal(connector.state, "not_connected");

  await waitFor(() => connector.state === "connected");
  assert.ok(events.includes("reconnected"), "success goes through the normal reconnected event");
  assert.ok(!events.includes("connectionLost"), "first-connect retries must stay silent");
  assert.ok(!events.includes("connectionGaveUp"));
});

test("first-connect retry keeps polling silently while codex stays missing", async () => {
  let attempts = 0;
  const connector = new CodexDesktopConnector({
    firstConnectRetryMs: 5,
    transportFactory: () => {
      attempts += 1;
      return new FailingTransport();
    },
  });
  const events = [];
  connector.onEvent = (event) => events.push(event.type);

  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  // At least two background retries beyond the initial attempt.
  await waitFor(() => attempts >= 3);
  assert.equal(connector.state, "not_connected");
  assert.deepEqual(events, [], "no events while retrying — unlimited but silent");
  await waitFor(() => connector.reconnectTimer != null);
  // Cleanup: an in-flight retry callback could reschedule after clearTimeout;
  // marking the connector connected makes any straggler a no-op at next fire.
  connector.state = "connected";
  clearTimeout(connector.reconnectTimer);
});

test("manual initialize during a pending first-connect retry does not stack timers", async () => {
  const connector = new CodexDesktopConnector({
    firstConnectRetryMs: 60_000,
    transportFactory: () => new FailingTransport(),
  });
  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  const timer = connector.reconnectTimer;
  assert.ok(timer);

  // The UI retry button while the timer is pending: fails again immediately
  // but must reuse the already-scheduled timer instead of adding another.
  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.equal(connector.reconnectTimer, timer);
  clearTimeout(connector.reconnectTimer);
});

test("a pending first-connect retry is a no-op after a manual initialize succeeded", async () => {
  // A transport that fails until "codex gets installed", then self-answers.
  const transport = new AutoInitTransport();
  transport.fail = true;
  const originalConnect = transport.connect.bind(transport);
  transport.connect = async () => {
    if (transport.fail) {
      throw new Error("ECONNREFUSED");
    }
    return originalConnect();
  };
  const connector = new CodexDesktopConnector({ transport, firstConnectRetryMs: 5 });

  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.ok(connector.reconnectTimer, "retry pending");

  transport.fail = false;
  await connector.initialize(); // manual retry (UI button) wins the race
  assert.equal(connector.state, "connected");

  const events = [];
  connector.onEvent = (event) => events.push(event.type);
  // Let the pending auto-retry fire: it must observe "connected" and do nothing.
  await waitFor(() => connector.reconnectTimer == null);
  assert.equal(connector.state, "connected");
  assert.deepEqual(events, [], "no duplicate initialize/reconnected from the stale timer");
});
