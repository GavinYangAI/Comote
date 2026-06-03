import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexDesktopConnector,
  extractChangePaths,
  resolveCodexCommand,
} from "../src/connectors/codex-desktop/index.js";
import { CodexCliConnector } from "../src/connectors/codex-cli/index.js";

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
  const connector = new CodexDesktopConnector();

  assert.deepEqual(connector.getStatus(), {
    name: "Codex Desktop",
    role: "primary",
    state: "not_connected",
    protocol: "app-server",
    endpoint: "codex app-server (stdio)",
  });
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

test("desktop connector surfaces a connection failure instead of silently retrying", async () => {
  const connector = new CodexDesktopConnector({
    transportFactory: () => new FailingTransport(),
  });

  await assert.rejects(connector.initialize(), /ECONNREFUSED/);
  assert.equal(connector.getStatus().state, "not_connected");
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
    approvalsReviewer: "user",
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
      approvalsReviewer: "user",
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
      "electron-saved-workspace-roots": ["/home/test/projects/alpha"],
    }),
  );
  try {
    const connector = new CodexDesktopConnector({ transport: new MemoryTransport(), codexStatePath: statePath });
    const projects = await connector.listProjects();
    assert.deepEqual(
      projects.map((p) => [p.name, p.active]),
      [
        ["team-skills", true],
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
  const connector = new CodexCliConnector();

  assert.deepEqual(connector.getStatus(), {
    name: "Codex CLI",
    role: "fallback",
    state: "available",
  });
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

test("resolveCodexCommand prefers the bundled Codex.app binary on macOS", () => {
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  assert.equal(
    resolveCodexCommand({ platform: "darwin", exists: (c) => c === bundled }),
    bundled,
  );
  assert.equal(
    resolveCodexCommand({ platform: "darwin", exists: () => false }),
    "codex",
  );
});
