import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";

test("feishu runtime verifies URL challenge events", async () => {
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text", text: "unused" }) },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: (payload) => payload.token === "verify_me",
    },
  });

  const result = await runtime.handleInbound({
    type: "url_verification",
    token: "verify_me",
    challenge: "challenge_text",
  });

  assert.deepEqual(result, { kind: "challenge", challenge: "challenge_text" });
});

test("feishu runtime routes inbound events and delivers queued replies", async () => {
  const authorization = new AuthorizationStore();
  authorization.confirmIdentity({ channel: "feishu", stableId: "ou_owner", displayName: "Alice" });
  const projects = new ProjectStore();
  projects.replaceProjects([{ name: "comote", path: "/repo/comote", source: "codex-desktop", status: "available" }]);
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  const outbound = new OutboundQueue();
  const adapter = new FeishuChannelAdapter({
    commandRouter: router,
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    sendReply: async (reply) => outbound.enqueue(reply),
  });
  const delivered = [];
  const runtime = new FeishuRuntimeService({
    adapter,
    outboundQueue: outbound,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async sendText(message) {
        delivered.push(message);
        return { ok: true };
      },
      async sendCard(message) {
        delivered.push(message);
        return { messageId: "om_card" };
      },
    },
  });

  const result = await runtime.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "/projects" }),
      },
    },
  });

  assert.equal(result.kind, "text");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].receiveId, "oc_chat");
  assert.equal(delivered[0].receiveIdType, "chat_id");
  assert.deepEqual(outbound.list({ channel: "feishu" }), []);
});

test("feishu runtime ignores a redelivered duplicate event", async () => {
  let routed = 0;
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => {
        routed += 1;
        return { kind: "text", text: "ok" };
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
    },
  });

  const event = {
    header: { event_id: "evt_1" },
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "做一个ppt" }),
      },
    },
  };

  const first = await runtime.handleInbound(event);
  const second = await runtime.handleInbound(event);

  assert.equal(routed, 1, "a redelivered event must not be routed twice");
  assert.equal(first.kind, "text");
  assert.equal(second.kind, "ignored");
});

test("feishu runtime dedups by message_id when no event header is present", async () => {
  let routed = 0;
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => {
        routed += 1;
        return { kind: "text" };
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
    },
  });

  const event = {
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_42",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: "{}",
      },
    },
  };

  await runtime.handleInbound(event);
  await runtime.handleInbound(event);

  assert.equal(routed, 1, "dedup must fall back to message_id");
});

test("feishu runtime starts and stops a websocket event stream", async () => {
  const calls = [];
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text", text: "ok" }) },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async ({ onEvent }) => {
        calls.push(["startEventStream", typeof onEvent]);
        return { ok: true };
      },
      stopEventStream: () => {
        calls.push(["stopEventStream"]);
      },
    },
  });

  const started = await runtime.start();
  const stopped = runtime.stop();

  assert.equal(started.state, "running");
  assert.equal(stopped.state, "configured");
  assert.deepEqual(calls, [["startEventStream", "function"], ["stopEventStream"]]);
});

test("feishu runtime delivers a queued card via sendCard", async () => {
  const outbound = new OutboundQueue();
  outbound.enqueue({
    channel: "feishu",
    conversationId: "oc_chat",
    card: { config: {}, elements: [] },
    dedupeKey: "card:1",
  });
  const cardCalls = [];
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text" }) },
    outboundQueue: outbound,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async sendText() {
        throw new Error("should not send text when a card is present");
      },
      async sendCard(message) {
        cardCalls.push(message);
        return { messageId: "om_1" };
      },
    },
  });

  const result = await runtime.deliverQueued();
  assert.equal(result.outbound, 1);
  assert.equal(cardCalls.length, 1);
  assert.equal(cardCalls[0].receiveId, "oc_chat");
  assert.deepEqual(outbound.list({ channel: "feishu" }), []);
});

function cardDriver() {
  const calls = { sent: [], updated: [] };
  return {
    calls,
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: "om_live_1" };
    },
    async updateCard(message) {
      calls.updated.push(message);
      return { code: 0 };
    },
  };
}

test("runtime opens, updates, and finishes a thread card", async () => {
  const driver = cardDriver();
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text" }) },
    outboundQueue: new OutboundQueue(),
    driver,
    cardUpdateIntervalMs: 0,
  });

  await runtime.openThreadCard({
    threadId: "t1",
    conversationId: "oc_chat",
    card: { elements: [] },
  });
  assert.equal(driver.calls.sent.length, 1);
  assert.equal(runtime.hasThreadCard("t1"), true);

  runtime.updateThreadCard("t1", { elements: ["progress"] });
  await runtime.flushThreadCard("t1");
  assert.equal(driver.calls.updated.length, 1);
  assert.deepEqual(driver.calls.updated[0].card, { elements: ["progress"] });

  const finished = await runtime.finishThreadCard("t1", { elements: ["done"] });
  assert.equal(finished, true);
  assert.equal(driver.calls.updated.length, 2);
  assert.equal(runtime.hasThreadCard("t1"), false);
});

test("updateThreadCard and finishThreadCard no-op when no card session exists", async () => {
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text" }) },
    outboundQueue: new OutboundQueue(),
    driver: cardDriver(),
  });
  assert.equal(runtime.updateThreadCard("missing", { elements: [] }), false);
  assert.equal(await runtime.finishThreadCard("missing", { elements: [] }), false);
});

test("handleCardAction resolves an approval and refreshes the card", async () => {
  const resolved = [];
  const updated = [];
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => ({ kind: "text" }),
      commandRouter: {
        resolveApproval: async (code, decision) => resolved.push([code, decision]),
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async updateCard(message) {
        updated.push(message);
      },
    },
  });

  const result = await runtime.handleCardAction({
    open_id: "ou_owner",
    open_message_id: "om_approval",
    action: { value: { kind: "approval", code: "a1", decision: "accept" } },
  });

  assert.deepEqual(resolved, [["a1", "accept"]]);
  assert.equal(updated[0].messageId, "om_approval");
  assert.match(result.toast.content, /已批准/);
});

test("handleCardAction cancels a thread", async () => {
  const cancelled = [];
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => ({ kind: "text" }),
      commandRouter: { cancelThread: async (threadId) => cancelled.push(threadId) },
    },
    outboundQueue: new OutboundQueue(),
    driver: { getStatus: () => ({ state: "configured" }), verifyEvent: () => true },
  });

  await runtime.handleCardAction({
    action: { value: { kind: "cancel", threadId: "thread_c" } },
  });
  assert.deepEqual(cancelled, ["thread_c"]);
});

// ── Issue 1: configureDriver while running ──────────────────────────────────

test("configureDriver while running stops the old driver and starts the new one", async () => {
  const oldCalls = [];
  const newCalls = [];

  const oldDriver = {
    getStatus: () => ({ state: "configured" }),
    startEventStream: async ({ onError }) => {
      oldCalls.push("startEventStream");
      return { ok: true };
    },
    stopEventStream: () => {
      oldCalls.push("stopEventStream");
    },
  };

  const newDriver = {
    getStatus: () => ({ state: "configured" }),
    startEventStream: async ({ onError }) => {
      newCalls.push("startEventStream");
      return { ok: true };
    },
    stopEventStream: () => {
      newCalls.push("stopEventStream");
    },
  };

  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text" }) },
    outboundQueue: new OutboundQueue(),
    driver: oldDriver,
  });

  // Start with the old driver
  await runtime.start();
  assert.equal(runtime.running, true);
  assert.deepEqual(oldCalls, ["startEventStream"]);

  // Reconfigure with a new driver while running
  runtime.configureDriver(newDriver);

  // Give the async restart a chance to complete
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(oldCalls.includes("stopEventStream"), "old driver's stopEventStream must be called");
  assert.ok(newCalls.includes("startEventStream"), "new driver's startEventStream must be called");
});

// ── handleCardAction pick branch: async dispatch error handling ─────────────
//
// Feishu's card-action callback has a tight ~3s timeout, so handleCardAction
// returns a "处理中…" info toast immediately and dispatches the slow work
// in the background. A failure inside the background dispatch must therefore:
//   - not crash the runtime,
//   - be logged via eventLog so the user can inspect it,
//   - leave the synchronous toast intact (it was already returned).

test("handleCardAction pick branch toasts immediately and logs the async error when sendReplyCard throws", async () => {
  const errorCalls = [];
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => ({ kind: "text" }),
      sendReplyCard: async () => {
        throw new Error("card send failed");
      },
      commandRouter: {
        conversationByIdentity: new Map([["feishu:ou_user", { conversationId: "oc_chat" }]]),
        chooseProject: async () => ({ kind: "text", text: "ok" }),
        useSessionAsync: async () => "ok",
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: { getStatus: () => ({ state: "configured" }), verifyEvent: () => true },
    eventLog: {
      info: () => {},
      warn: () => {},
      error: (message, context) => errorCalls.push({ message, context }),
    },
  });

  const result = await runtime.handleCardAction({
    open_id: "ou_user",
    action: { value: { kind: "pick", pickKind: "project", index: "1" } },
  });

  assert.equal(result.toast.type, "info");
  assert.match(result.toast.content, /处理中/);

  // Let the background dispatch run; sendReplyCard should throw and be logged.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    errorCalls.some((call) => call.context?.error === "card send failed"),
    "the async dispatch failure must be recorded via eventLog.error",
  );
});

test("handleCardAction dispatches a pick directly by pickKind", async () => {
  const chosen = [];
  const sent = [];
  const runtime = new FeishuRuntimeService({
    adapter: {
      handleInbound: async () => ({ kind: "text" }),
      sendReplyCard: async ({ conversationId, reply }) => sent.push({ conversationId, reply }),
      commandRouter: {
        conversationByIdentity: new Map([["feishu:ou_owner", { conversationId: "oc_chat" }]]),
        chooseProject: async (identity, selector) => {
          chosen.push(["project", identity.stableId, selector]);
          return { kind: "text", text: "已进入项目" };
        },
        useSessionAsync: async (identity, selector) => {
          chosen.push(["session", identity.stableId, selector]);
          return "已进入对话";
        },
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: { getStatus: () => ({ state: "configured" }), verifyEvent: () => true },
  });

  await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "pick", pickKind: "project", index: "2" } },
  });
  assert.deepEqual(chosen[0], ["project", "ou_owner", "2"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, "oc_chat");
  assert.equal(sent[0].reply.text, "已进入项目");

  await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "pick", pickKind: "session", index: "1" } },
  });
  assert.deepEqual(chosen[1], ["session", "ou_owner", "1"]);
  // a string reply from useSessionAsync is normalized into a reply object
  assert.equal(sent[1].reply.text, "已进入对话");
});

test("concurrent start() calls only invoke startEventStream once", async () => {
  let startCount = 0;
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text", text: "ok" }) },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async () => {
        startCount += 1;
        return { ok: true };
      },
      stopEventStream: () => {},
    },
  });

  const [a, b] = await Promise.all([runtime.start(), runtime.start()]);

  assert.equal(startCount, 1, "startEventStream must be called exactly once");
  assert.equal(a.state, "running");
  assert.equal(b.state, "running");
});

test("start() must not leave running true if the WebSocket setup throws", async () => {
  const runtime = new FeishuRuntimeService({
    adapter: { handleInbound: async () => ({ kind: "text", text: "unused" }) },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async () => {
        throw new Error("ws failed");
      },
    },
  });

  await assert.rejects(
    () => runtime.start(),
    (err) => {
      assert.match(err.message, /ws failed/);
      return true;
    },
  );

  assert.equal(runtime.getStatus().state, "configured", "state must not be running");
  assert.equal(runtime.running, false, "running flag must remain false");
});

function stubAdapter() {
  return { handleInbound: async () => ({}), commandRouter: {} };
}

test("deliverQueued uploads then sends media; oversize falls back to text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-rt-"));
  const small = join(dir, "a.png");
  const big = join(dir, "big.bin");
  writeFileSync(small, Buffer.from("img"));
  writeFileSync(big, Buffer.alloc(21 * 1024 * 1024));

  const calls = [];
  const driver = {
    getStatus: () => ({}),
    uploadImage: async (p) => { calls.push(["uploadImage", p]); return "img_1"; },
    uploadFile: async (p) => { calls.push(["uploadFile", p]); return "file_1"; },
    sendImage: async (a) => { calls.push(["sendImage", a.imageKey]); },
    sendFile: async (a) => { calls.push(["sendFile", a.fileKey]); },
    sendText: async (a) => { calls.push(["sendText", a.text]); },
    sendCard: async () => {},
  };
  const outboundQueue = new OutboundQueue();
  outboundQueue.enqueue({ channel: "feishu", conversationId: "c1", kind: "image", path: small });
  outboundQueue.enqueue({ channel: "feishu", conversationId: "c1", kind: "file", path: big, fileName: "big.bin" });

  const runtime = new FeishuRuntimeService({ adapter: stubAdapter(), outboundQueue, driver });
  await runtime.deliverQueued();

  assert.deepEqual(calls[0], ["uploadImage", small]);
  assert.deepEqual(calls[1], ["sendImage", "img_1"]);
  assert.ok(!calls.some(([m]) => m === "uploadFile"));
  assert.ok(calls.some(([m, t]) => m === "sendText" && /big\.bin/.test(t)));
});
