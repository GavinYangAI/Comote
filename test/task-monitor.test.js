import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskMonitor, readJsonLines } from "../src/core/task-monitor.js";

function event(type, timestamp = "2026-08-06T06:00:00.000Z") {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type } }) + "\n";
}

function responseItem(payload, timestamp) {
  return JSON.stringify({ timestamp, type: "response_item", payload }) + "\n";
}

test("readJsonLines retries a partial final JSON line on the next scan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  try {
    const first = event("task_started") + '{"timestamp":"2026';
    await writeFile(file, first);
    const page1 = await readJsonLines(file, 0, Buffer.byteLength(first));
    assert.equal(page1.events.length, 1);
    assert.ok(page1.offset < Buffer.byteLength(first));

    const rest = '-08-06T06:01:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}\n';
    await appendFile(file, rest);
    const size = Buffer.byteLength(first + rest);
    const page2 = await readJsonLines(file, page1.offset, size);
    assert.equal(page2.events.length, 1);
    assert.equal(page2.events[0].payload.type, "task_complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline history does not become attention, later completion does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  await writeFile(file, event("task_started") + event("task_complete", "2026-08-06T06:01:00.000Z"));
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({
      data: [{
        id: "thread-1",
        name: "Monitor all projects",
        cwd: join(dir, "project"),
        path: file,
        updatedAt: 1_786_000_000,
      }],
    }),
  };
  const monitor = new TaskMonitor({ desktop, indexIntervalMs: 60_000, activeIntervalMs: 60_000 });
  const notifications = [];
  monitor.subscribe((change) => {
    if (change.notify) notifications.push(change);
  });
  try {
    await monitor.start();
    let task = monitor.getTask("thread-1");
    assert.equal(task.state, "completed");
    assert.equal(task.attention, false);
    assert.equal(notifications.length, 0);

    await appendFile(file, event("task_started", "2026-08-06T06:02:00.000Z"));
    await monitor.refresh();
    task = monitor.getTask("thread-1");
    assert.equal(task.state, "running");

    await appendFile(file, event("task_complete", "2026-08-06T06:03:00.000Z"));
    await monitor.refreshActive();
    task = monitor.getTask("thread-1");
    assert.equal(task.state, "completed");
    assert.equal(task.attention, true);
    assert.equal(notifications.at(-1).task.id, "thread-1");

    monitor.markSeen("thread-1");
    assert.equal(monitor.getTask("thread-1").attention, true);
    monitor.markHandled("thread-1");
    assert.equal(monitor.getTask("thread-1").attention, false);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("an unanswered request_user_input is waiting until its output arrives", async () => {
  const monitor = new TaskMonitor({ desktop: null });
  monitor.ingestLiveEvent({ type: "turnStarted", threadId: "thread-live" });
  monitor.ingestLiveEvent({ type: "approval", threadId: "thread-live" });
  assert.equal(monitor.getTask("thread-live").state, "waiting");
  assert.equal(monitor.getTask("thread-live").capabilities.cancel, true);
  monitor.ingestLiveEvent({ type: "approvalResolved", threadId: "thread-live" });
  assert.equal(monitor.getTask("thread-live").state, "running");
});

test("session logs expose waiting, resumed, and interrupted transitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  await writeFile(file, event("task_started"));
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({
      data: [{ id: "thread-lifecycle", cwd: dir, path: file }],
    }),
  };
  const monitor = new TaskMonitor({ desktop });
  const notifications = [];
  monitor.subscribe((change) => {
    if (change.notify) notifications.push(change.task.state);
  });
  try {
    await monitor.start();
    await appendFile(file, responseItem({
      type: "function_call",
      name: "request_user_input",
      call_id: "question-1",
    }, "2026-08-06T06:01:00.000Z"));
    await monitor.refreshActive();
    assert.equal(monitor.getTask("thread-lifecycle").state, "waiting");
    assert.equal(monitor.getTask("thread-lifecycle").attention, true);

    await appendFile(file, responseItem({
      type: "function_call_output",
      call_id: "question-1",
      output: "continue",
    }, "2026-08-06T06:02:00.000Z"));
    await monitor.refreshActive();
    assert.equal(monitor.getTask("thread-lifecycle").state, "running");
    assert.equal(monitor.getTask("thread-lifecycle").attention, false);

    await appendFile(file, event("turn_aborted", "2026-08-06T06:03:00.000Z"));
    await monitor.refreshActive();
    assert.equal(monitor.getTask("thread-lifecycle").state, "interrupted");
    assert.equal(monitor.getTask("thread-lifecycle").attention, true);
    assert.deepEqual(notifications, ["waiting", "interrupted"]);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline recovers an active task whose start event is older than the tail window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "long-rollout.jsonl");
  const filler = JSON.stringify({
    timestamp: "2026-08-06T06:01:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "x".repeat(600 * 1024) },
  }) + "\n";
  await writeFile(file, event("task_started") + filler);
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({ data: [{ id: "long", cwd: dir, path: file }] }),
  };
  const monitor = new TaskMonitor({ desktop });
  try {
    await monitor.start();
    assert.equal(monitor.getTask("long").state, "running");
    assert.equal(monitor.getTask("long").attention, false);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings and attention records survive a snapshot round trip", () => {
  const monitor = new TaskMonitor({ desktop: null });
  monitor.updateSettings({ ownerIdentityKey: "feishu:ou_owner", mobileNotifications: true });
  monitor.ingestLiveEvent({ type: "turnStarted", threadId: "thread-live" });
  monitor.ingestLiveEvent({ type: "turnCompleted", threadId: "thread-live" });
  monitor.markSeen("thread-live");
  const restored = new TaskMonitor({ desktop: null, persisted: monitor.persistSnapshot() });
  assert.equal(restored.getSettings().ownerIdentityKey, "feishu:ou_owner");
  assert.equal(restored.persistSnapshot().records["thread-live"].seenAt != null, true);
});

test("baseline replay preserves persisted seen and handled metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  await writeFile(file, event("task_started") + event("task_complete", "2026-08-06T06:01:00.000Z"));
  const persisted = {
    records: {
      "thread-restart": {
        lastState: "completed",
        attention: false,
        seenAt: "2026-08-06T06:02:00.000Z",
        handledAt: "2026-08-06T06:02:00.000Z",
        completedAt: "2026-08-06T06:01:00.000Z",
      },
    },
  };
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({
      data: [{ id: "thread-restart", cwd: dir, path: file }],
    }),
  };
  const monitor = new TaskMonitor({ desktop, persisted });
  try {
    await monitor.start();
    const task = monitor.getTask("thread-restart");
    assert.equal(task.state, "completed");
    assert.equal(task.attention, false);
    assert.equal(task.seenAt, "2026-08-06T06:02:00.000Z");
    assert.equal(task.handledAt, "2026-08-06T06:02:00.000Z");
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline replay clears stale interaction metadata when a newer turn is running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  await writeFile(
    file,
    event("task_started")
      + event("task_complete", "2026-08-06T06:01:00.000Z")
      + event("task_started", "2026-08-06T06:03:00.000Z"),
  );
  const persisted = {
    records: {
      "thread-new-turn": {
        lastState: "completed",
        attention: true,
        seenAt: "2026-08-06T06:02:00.000Z",
        handledAt: null,
        completedAt: "2026-08-06T06:01:00.000Z",
      },
    },
  };
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({
      data: [{ id: "thread-new-turn", cwd: dir, path: file }],
    }),
  };
  const monitor = new TaskMonitor({ desktop, persisted });
  try {
    await monitor.start();
    const task = monitor.getTask("thread-new-turn");
    assert.equal(task.state, "running");
    assert.equal(task.attention, false);
    assert.equal(task.seenAt, null);
    assert.equal(task.handledAt, null);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline replay does not carry handled state into a newer completed turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-monitor-"));
  const file = join(dir, "rollout.jsonl");
  await writeFile(
    file,
    event("task_started")
      + event("task_complete", "2026-08-06T06:01:00.000Z")
      + event("task_started", "2026-08-06T06:03:00.000Z")
      + event("task_complete", "2026-08-06T06:04:00.000Z"),
  );
  const persisted = {
    records: {
      "thread-new-completion": {
        lastState: "completed",
        attention: false,
        seenAt: "2026-08-06T06:02:00.000Z",
        handledAt: "2026-08-06T06:02:00.000Z",
        completedAt: "2026-08-06T06:01:00.000Z",
      },
    },
  };
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({
      data: [{ id: "thread-new-completion", cwd: dir, path: file }],
    }),
  };
  const monitor = new TaskMonitor({ desktop, persisted });
  try {
    await monitor.start();
    const task = monitor.getTask("thread-new-completion");
    assert.equal(task.state, "completed");
    assert.equal(task.completedAt, "2026-08-06T06:04:00.000Z");
    assert.equal(task.attention, false);
    assert.equal(task.seenAt, null);
    assert.equal(task.handledAt, null);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
