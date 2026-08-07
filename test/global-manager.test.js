import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { GlobalManager } from "../src/core/global-manager.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";
import { createFeishuRenderer } from "../src/channels/feishu/renderer.js";

function fixture({ persisted = {}, runtimeState = "running" } = {}) {
  const sent = [];
  const updated = [];
  const desktopCalls = [];
  const tasks = [
    {
      id: "thread-123456",
      title: "Fix tests",
      project: { name: "Comote", path: "D:\\work\\Comote" },
      state: "completed",
      attention: true,
      capabilities: { cancel: false, send: true },
    },
    {
      id: "thread-running",
      title: "Build app",
      project: { name: "App", path: "D:\\work\\App" },
      state: "running",
      attention: false,
      capabilities: { cancel: true, send: false },
    },
  ];
  const listeners = new Set();
  const taskMonitor = {
    snapshot: () => ({
      version: 7,
      state: "ready",
      counts: { running: 1, waiting: 0, attention: 1, completedToday: 1 },
      tasks: tasks.map((task) => ({ ...task })),
    }),
    getTask: (id) => tasks.find((task) => task.id === id) ?? null,
    markSeen: (id) => ({ id }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const config = {
    enabled: true,
    appId: "cli_app",
    appSecret: "secret",
    linkedUserId: "ou_manager",
    linkedUserName: "Manager",
  };
  const runtime = {
    running: runtimeState === "running",
    getStatus: () => ({ state: runtimeState }),
    start: async () => ({ state: "running" }),
    driver: {
      async sendCard(args) {
        sent.push(args);
        return { messageId: `om_${sent.length}` };
      },
      async updateCard(args) {
        updated.push(args);
        return { ok: true };
      },
    },
  };
  const desktop = {
    resumeThread: async (args) => desktopCalls.push(["resume", args]),
    startTurn: async (args) => desktopCalls.push(["start", args]),
    cancelTurn: async (args) => desktopCalls.push(["cancel", args]),
    listPendingApprovals: () => [{ id: "approval-1", shortCode: "a1", threadId: "thread-running" }],
    resolveApproval: async (code, decision) => desktopCalls.push(["approval", code, decision]),
  };
  const authorization = new AuthorizationStore();
  const manager = new GlobalManager({
    taskMonitor,
    desktop,
    authorization,
    getFeishuConfig: () => config,
    getFeishuRuntime: () => runtime,
    persisted,
    dashboardIntervalMs: 1,
    taskIntervalMs: 1,
  });
  manager.setPersistHandler(async () => {});
  return { manager, taskMonitor, tasks, listeners, config, runtime, desktopCalls, authorization, sent, updated };
}

test("binding reuses the current Feishu app, verifies delivery, and persists no secret", async () => {
  const f = fixture();
  const result = await f.manager.bindCurrentFeishu();

  assert.equal(result.status, "ready");
  assert.equal(result.manager.stableId, "ou_manager");
  assert.equal(f.sent[0].receiveIdType, "open_id");
  assert.equal(f.sent[0].receiveId, "ou_manager");
  assert.equal(f.authorization.isAuthorized({ channel: "feishu", stableId: "ou_manager" }), true);
  const persisted = f.manager.persistSnapshot();
  assert.equal(persisted.appId, "cli_app");
  assert.equal(persisted.managerOpenId, "ou_manager");
  assert.equal(Object.hasOwn(persisted, "appSecret"), false);
});

test("a failed verification card does not save or authorize the manager binding", async () => {
  const f = fixture();
  f.runtime.driver.sendCard = async () => { throw new Error("delivery failed"); };
  await assert.rejects(() => f.manager.bindCurrentFeishu(), /delivery failed/);
  assert.equal(f.manager.publicSnapshot().status, "unbound");
  assert.equal(f.authorization.isAuthorized({ channel: "feishu", stableId: "ou_manager" }), false);
});

test("a changed app or linked user makes a persisted binding stale", () => {
  const f = fixture({ persisted: { enabled: true, appId: "old_app", managerOpenId: "ou_manager" } });
  assert.equal(f.manager.publicSnapshot().status, "stale");
  assert.equal(f.manager.isManagerIdentity({ channel: "feishu", stableId: "ou_manager" }), false);
});

test("global commands use explicit threadId and cwd without a current-project pointer", async () => {
  const f = fixture();
  await f.manager.bindCurrentFeishu();
  const identity = { channel: "feishu", stableId: "ou_manager" };

  const detail = await f.manager.handleMessage({ identity, text: "/task 1" });
  assert.match(detail.text, /thread-123456/);
  const sent = await f.manager.handleMessage({ identity, text: "/send 1 rerun tests" });
  assert.match(sent.text, /thread-123456/);
  assert.deepEqual(f.desktopCalls.slice(0, 2), [
    ["resume", { threadId: "thread-123456", cwd: "D:\\work\\Comote" }],
    ["start", { threadId: "thread-123456", cwd: "D:\\work\\Comote", text: "rerun tests" }],
  ]);
  const noTarget = await f.manager.handleMessage({ identity, text: "please continue" });
  assert.match(noTarget.text, /Fix tests/);
  assert.equal(f.desktopCalls.length, 2);
});

test("only the linked manager can cancel or approve from a global card", async () => {
  const f = fixture();
  await f.manager.bindCurrentFeishu();

  const denied = await f.manager.handleCardAction({
    openId: "ou_other",
    value: { kind: "global_manager_cancel", threadId: "thread-running" },
  });
  assert.equal(denied.toast.type, "error");
  assert.equal(f.desktopCalls.length, 0);

  const approved = await f.manager.handleCardAction({
    openId: "ou_manager",
    messageId: "om_approval",
    value: { kind: "global_manager_approval", code: "a1", threadId: "thread-running", decision: "accept" },
  });
  assert.equal(approved.toast.type, "success");
  assert.deepEqual(f.desktopCalls, [["approval", "approval-1", "accept"]]);
  assert.equal(f.updated.at(-1).messageId, "om_approval");

  const forged = await f.manager.handleCardAction({
    openId: "ou_manager",
    value: { kind: "global_manager_approval", code: "a1", threadId: "thread-123456", decision: "accept" },
  });
  assert.equal(forged.toast.type, "error");
  assert.equal(f.desktopCalls.length, 1);
});

test("task cards are updated in place and recreated when their message is missing", async () => {
  const f = fixture();
  await f.manager.bindCurrentFeishu();
  await f.manager.flushTask("thread-running");
  assert.equal(f.sent.at(-1).receiveId, "ou_manager");
  const firstTaskMessage = f.manager.persistSnapshot().taskCards["thread-running"].messageId;

  await f.manager.flushTask("thread-running");
  assert.equal(f.updated.at(-1).messageId, firstTaskMessage);
});

test("a terminal task transition sends a new manager notification instead of only updating its card", async () => {
  const f = fixture();
  await f.manager.bindCurrentFeishu();
  await f.manager.flushTask("thread-running");
  const taskCardMessageId = f.manager.persistSnapshot().taskCards["thread-running"].messageId;
  f.manager.start();

  f.tasks[1].state = "completed";
  f.tasks[1].attention = true;
  f.tasks[1].updatedAt = "2026-08-07T12:00:00.000Z";
  f.tasks[1].completedAt = "2026-08-07T12:00:00.000Z";
  for (const listener of f.listeners) {
    listener({ type: "task", reason: "state", notify: true, task: { ...f.tasks[1] }, version: 8 });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(f.sent.length, 3, "binding, initial task card, and a fresh terminal notification are sent");
  assert.equal(f.sent.at(-1).receiveId, "ou_manager");
  assert.equal(f.sent.at(-1).receiveIdType, "open_id");
  assert.match(JSON.stringify(f.sent.at(-1).card), /completed/);
  assert.equal(
    f.manager.persistSnapshot().taskCards["thread-running"].messageId,
    taskCardMessageId,
    "the notification must not replace the task card used for in-place updates",
  );
  f.manager.stop();
});

test("queued terminal notifications are deduplicated by task occurrence and never update an old message", async () => {
  const f = fixture();
  const queue = new OutboundQueue();
  f.manager.outboundQueue = queue;
  f.manager.deliverFeishuQueue = () => {};
  await f.manager.bindCurrentFeishu();
  const task = {
    ...f.tasks[0],
    completedAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
  };

  await f.manager.sendTaskNotification(task);
  await f.manager.sendTaskNotification(task);

  const notifications = queue.list({ channel: "feishu" }).filter(
    (entry) => entry.globalManagerCardType === "notification",
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].messageId, null);
  assert.equal(notifications[0].receiveId, undefined);
  assert.equal(notifications[0].conversationId, "ou_manager");
  assert.equal(notifications[0].receiveIdType, "open_id");
});

test("global cards use the persisted outbound queue and replace a missing update target", async () => {
  const f = fixture();
  const queue = new OutboundQueue();
  let drains = 0;
  f.manager.outboundQueue = queue;
  f.manager.deliverFeishuQueue = () => { drains += 1; };
  await f.manager.bindCurrentFeishu();

  await f.manager.flushTask("thread-running");
  const first = queue.list({ channel: "feishu" })[0];
  assert.equal(first.kind, "globalManagerCard");
  assert.equal(first.receiveIdType, "open_id");
  assert.equal(drains, 1);

  const renderer = createFeishuRenderer();
  await renderer.render(first, { driver: f.runtime.driver, runtime: { globalManager: f.manager } });
  queue.markDelivered(first.id);
  const firstMessageId = f.manager.persistSnapshot().taskCards["thread-running"].messageId;
  assert.ok(firstMessageId);

  f.tasks[1].updatedAt = "2026-08-07T12:00:00.000Z";
  f.runtime.driver.updateCard = async () => { throw new Error("message missing"); };
  await f.manager.flushTask("thread-running");
  const replacement = queue.list({ channel: "feishu" })[0];
  await renderer.render(replacement, { driver: f.runtime.driver, runtime: { globalManager: f.manager } });
  assert.notEqual(f.manager.persistSnapshot().taskCards["thread-running"].messageId, firstMessageId);

  await f.manager.unbind();
  assert.equal(queue.snapshot().some((entry) => entry.kind === "globalManagerCard"), false);
});

test("approval events create actionable cards for tasks without chat bindings", async () => {
  const f = fixture();
  await f.manager.bindCurrentFeishu();
  f.manager.handleDesktopEvent({
    type: "approval",
    approval: { id: "approval-1", shortCode: "a1", threadId: "thread-running", method: "exec", params: { command: "npm test" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].card.elements.at(-1).actions[0].value.kind, "global_manager_approval");
  assert.equal(f.sent[1].card.elements.at(-1).actions[0].value.threadId, "thread-running");

  f.manager.handleDesktopEvent({
    type: "approval",
    approval: { id: "approval-1", shortCode: "a1", threadId: "thread-running", method: "exec", params: { command: "npm test" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, 2, "a duplicate approval updates the existing card instead of sending another");
});
