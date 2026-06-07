import test from "node:test";
import assert from "node:assert/strict";

import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";

// Minimal in-memory transport mirroring the one in connectors.test.js: records
// outbound frames and lets a test feed inbound notifications synchronously.
class MemoryTransport {
  constructor() {
    this.sent = [];
    this.messageHandler = null;
  }
  async connect() {}
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  receive(message) {
    this.messageHandler(JSON.stringify(message));
  }
  async close() {}
}

async function connect() {
  const transport = new MemoryTransport();
  const connector = new CodexDesktopConnector({ transport });
  const events = [];
  connector.onEvent = (event) => events.push(event);
  await connector.client.connect();
  return { transport, connector, events };
}

function milestones(events) {
  return events.filter((e) => e.type === "milestone");
}

test("item/started commandExecution emits a command milestone with the command's first word", async () => {
  const { transport, events } = await connect();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/started",
    params: { threadId: "t1", item: { type: "commandExecution", command: "npm run test -- --watch" } },
  });
  const [ms] = milestones(events);
  assert.ok(ms, "a milestone was emitted");
  assert.equal(ms.kind, "command");
  assert.equal(ms.label, "npm");
  assert.equal(ms.threadId, "t1");
});

test("item/completed commandExecution with a non-zero exitCode emits a failed command milestone", async () => {
  const { transport, events } = await connect();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: "t1", item: { type: "commandExecution", command: "pytest tests/", exitCode: 1 } },
  });
  const ms = milestones(events).find((m) => m.kind === "command");
  assert.ok(ms, "a command milestone was emitted");
  assert.equal(ms.label, "pytest");
  assert.equal(ms.status, "failed");
});

test("item/completed commandExecution with exitCode 0 emits NO milestone (success is silent)", async () => {
  const { transport, events } = await connect();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: "t1", item: { type: "commandExecution", command: "ls", exitCode: 0 } },
  });
  assert.equal(milestones(events).length, 0);
});

test("item/fileChange/patchUpdated emits a file milestone labeled with the changed file's basename", async () => {
  const { transport, events } = await connect();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/fileChange/patchUpdated",
    params: { threadId: "t1", itemId: "i9", changes: [{ path: "src/server/state.js" }] },
  });
  const ms = milestones(events).find((m) => m.kind === "file");
  assert.ok(ms, "a file milestone was emitted");
  assert.equal(ms.label, "state.js");
  assert.equal(ms.threadId, "t1");
});

test("a milestone with no usable label degrades to a null label (generic), never throws", async () => {
  const { transport, events } = await connect();
  // commandExecution with no command field at all.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/started",
    params: { threadId: "t1", item: { type: "commandExecution" } },
  });
  const ms = milestones(events).find((m) => m.kind === "command");
  assert.ok(ms, "a milestone was emitted even without a command string");
  assert.equal(ms.label, null);
});

test("unknown notification methods are still ignored (no milestone, no throw)", async () => {
  const { transport, events } = await connect();
  transport.receive({ jsonrpc: "2.0", method: "thread/somethingNew", params: { threadId: "t1" } });
  assert.equal(events.length, 0);
});
