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
import { createFeishuRenderer } from "../src/channels/feishu/renderer.js";
import { setLocale } from "../src/core/i18n/index.js";

// Build a FeishuRuntimeService with a renderer wired by default (A8: the
// runtime now extends BaseChannelRuntime and renders via the feishu renderer).
// Tests pass their own adapter/driver/etc. via overrides; renderer can still be
// overridden when a test wants a custom one.
function makeRuntime(overrides = {}) {
  return new FeishuRuntimeService({
    renderer: createFeishuRenderer(),
    ...overrides,
  });
}

test("feishu runtime verifies URL challenge events", async () => {
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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

test("feishu runtime wires a callable onAction into the driver event stream", async () => {
  let captured = null;
  const runtime = makeRuntime({
    adapter: { handleInbound: async () => ({ kind: "text", text: "ok" }) },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async (opts) => {
        captured = opts;
        return { ok: true };
      },
      stopEventStream: () => {},
    },
  });

  await runtime.start();

  // The driver hook was renamed onCardAction -> onAction (A6); the runtime must
  // now pass a callable onAction so card-button callbacks reach handleCardAction.
  assert.equal(typeof captured.onAction, "function");
});

test("feishu runtime delivers a queued text reply as a card via sendCard", async () => {
  const outbound = new OutboundQueue();
  // A semantic text reply: feishu always renders text as a textCard -> sendCard.
  outbound.enqueue({
    channel: "feishu",
    conversationId: "oc_chat",
    kind: "text",
    text: "hello-card",
    dedupeKey: "t:card1",
  });
  const cardCalls = [];
  const runtime = makeRuntime({
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
  assert.equal(cardCalls.length, 1); // text rendered as a textCard -> sendCard
  assert.equal(cardCalls[0].receiveId, "oc_chat");
  assert.deepEqual(outbound.list({ channel: "feishu" }), []);
});

test("deliverQueued does not double-send a queued reply under concurrent re-entry", async () => {
  const outbound = new OutboundQueue();
  outbound.enqueue({ channel: "feishu", conversationId: "c1", kind: "text", text: "hello", dedupeKey: "t:1" });

  const sent = [];
  let reentered = false;
  let runtime;
  const driver = {
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendText() {
      throw new Error("unexpected text send");
    },
    // feishu renders text as a card, so the drained reply lands on sendCard.
    async sendCard(message) {
      sent.push(message.card);
      if (!reentered) {
        reentered = true;
        // Mid-flight, trigger a concurrent drain (as pushfile's fire-and-forget
        // does). Awaiting it makes the race deterministic with no timing window:
        // with the re-entry guard it returns immediately (coalesced, no send);
        // without the guard it would list() the same not-yet-delivered entry and
        // resend it before this first send is marked delivered.
        await runtime.deliverQueued().catch(() => {});
      }
      return { messageId: "om_1" };
    },
  };
  runtime = makeRuntime({
    adapter: { handleInbound: async () => ({ kind: "text" }) },
    outboundQueue: outbound,
    driver,
  });

  await runtime.deliverQueued();

  assert.equal(sent.length, 1);
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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

  const runtime = makeRuntime({
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

test("handleCardAction pick branch toasts immediately and logs the async error when delivery throws", async () => {
  const errorCalls = [];
  const outbound = new OutboundQueue();
  // Real adapter (no sendReplyCard): the pick reply is enqueued via sendReply,
  // then delivered by the renderer. A failure in delivery (driver.sendCard
  // throws) must be logged and must not crash the runtime; the synchronous
  // "处理中…" toast was already returned.
  const adapter = new FeishuChannelAdapter({
    commandRouter: {
      conversationByIdentity: new Map([["feishu:ou_user", { conversationId: "oc_chat" }]]),
      chooseProject: async () => ({ kind: "text", text: "ok" }),
      useSessionAsync: async () => "ok",
    },
    sendReply: async (reply) => outbound.enqueue(reply),
  });
  const runtime = makeRuntime({
    adapter,
    outboundQueue: outbound,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      sendCard: async () => {
        throw new Error("card send failed");
      },
    },
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

  // Let the background dispatch run; delivery throws and must be logged.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    errorCalls.some((call) => call.context?.error === "card send failed"),
    "the async dispatch failure must be recorded via eventLog.error",
  );
});

test("handleCardAction dispatches a pick directly by pickKind", async () => {
  const chosen = [];
  const delivered = [];
  const outbound = new OutboundQueue();
  // Real adapter: dispatchPickAsync enqueues a semantic reply via sendReply and
  // the renderer turns it into a card delivered through driver.sendCard.
  const adapter = new FeishuChannelAdapter({
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
    sendReply: async (reply) => outbound.enqueue(reply),
  });
  const runtime = makeRuntime({
    adapter,
    outboundQueue: outbound,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      sendCard: async (message) => {
        delivered.push(message);
        return { messageId: "om_card" };
      },
    },
  });

  await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "pick", pickKind: "project", index: "2" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.deliverQueued();
  assert.deepEqual(chosen[0], ["project", "ou_owner", "2"]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].receiveId, "oc_chat");
  assert.match(JSON.stringify(delivered[0].card), /已进入项目/);

  await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "pick", pickKind: "session", index: "1" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.deliverQueued();
  assert.deepEqual(chosen[1], ["session", "ou_owner", "1"]);
  // a string reply from useSessionAsync is normalized into a reply object
  assert.match(JSON.stringify(delivered[1].card), /已进入对话/);
});

// Regression (channel-abstraction Part A): the old FeishuChannelAdapter had a
// sendReplyCard method that dispatchPickAsync called; it was REMOVED when the
// adapter migrated to BaseChannelAdapter. The other pick tests above use STUB
// adapters that re-add a fake sendReplyCard, so they miss the breakage. This
// test wires a REAL FeishuChannelAdapter (no sendReplyCard) + real renderer +
// real OutboundQueue and drives the pick path end-to-end: the reply must land
// as a card carrying the reply text, with no TypeError thrown.
test("handleCardAction pick delivers a card via the REAL adapter (no sendReplyCard)", async () => {
  const outbound = new OutboundQueue();
  const adapter = new FeishuChannelAdapter({
    commandRouter: {
      conversationByIdentity: new Map([["feishu:ou_owner", { conversationId: "oc_chat" }]]),
      chooseProject: async () => ({ kind: "text", text: "已切换到项目 X" }),
      useSessionAsync: async () => ({ kind: "text", text: "已切换到对话 Y" }),
    },
    sendReply: async (reply) => outbound.enqueue(reply),
  });
  const delivered = [];
  const runtime = makeRuntime({
    adapter,
    outboundQueue: outbound,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async sendCard(message) {
        delivered.push(message);
        return { messageId: "om_card" };
      },
      async sendText(message) {
        delivered.push(message);
        return { ok: true };
      },
    },
  });

  // Exercise the real callback path (handleCardAction → dispatchPickAsync).
  const result = await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "pick", pickKind: "project", index: "1" } },
  });
  assert.equal(result.toast.type, "info");

  // Let the fire-and-forget background dispatch run, then flush the queue.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.deliverQueued();

  const card = delivered.find((m) => m.receiveId === "oc_chat" && m.card);
  assert.ok(card, "the pick reply must be delivered as a card");
  assert.match(JSON.stringify(card.card), /已切换到项目 X/);
});

test("concurrent start() calls only invoke startEventStream once", async () => {
  let startCount = 0;
  const runtime = makeRuntime({
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
  const runtime = makeRuntime({
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
  outboundQueue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "image", path: small });
  outboundQueue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "file", path: big, fileName: "big.bin" });

  const runtime = makeRuntime({ adapter: stubAdapter(), outboundQueue, driver });
  await runtime.deliverQueued();

  assert.deepEqual(calls[0], ["uploadImage", small]);
  assert.deepEqual(calls[1], ["sendImage", "img_1"]);
  assert.ok(!calls.some(([m]) => m === "uploadFile"));
  assert.ok(calls.some(([m, t]) => m === "sendText" && /big\.bin/.test(t)));
});

test("handleCardAction pushfile enqueues media within project, rejects escape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comote-pf-"));
  writeFileSync(join(dir, "a.png"), "img");

  const outboundQueue = new OutboundQueue();
  const router = {
    getThreadBinding: (tid) =>
      tid === "t1" ? { channel: "feishu", conversationId: "c1", projectPath: dir } : null,
  };
  const adapter = { handleInbound: async () => ({}), commandRouter: router };
  const driver = {
    getStatus: () => ({}),
    uploadImage: async () => "img_1",
    sendImage: async () => {},
    sendText: async () => {},
    sendCard: async () => {},
  };
  const runtime = makeRuntime({ adapter, outboundQueue, driver });

  const ok = await runtime.handleCardAction({
    event: { action: { value: { kind: "pushfile", threadId: "t1", path: join(dir, "a.png") } }, open_id: "u1" },
  });
  assert.equal(ok.toast.type, "info");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outboundQueue.snapshot().some((e) => e.kind === "media"), true);

  const bad = await runtime.handleCardAction({
    event: { action: { value: { kind: "pushfile", threadId: "t1", path: "/etc/passwd" } }, open_id: "u1" },
  });
  assert.equal(bad.toast.type, "error");
  // The fence must block the ENQUEUE, not merely surface a toast.
  assert.equal(
    outboundQueue.snapshot().some((e) => e.path === "/etc/passwd"),
    false,
  );
});

test("oversize media falls back to a localized (en) text", async () => {
  setLocale("en");
  try {
    const dir = mkdtempSync(join(tmpdir(), "comote-rt-i18n-"));
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(21 * 1024 * 1024));

    const sentTexts = [];
    const driver = {
      getStatus: () => ({}),
      uploadImage: async () => "img_1",
      uploadFile: async () => "file_1",
      sendImage: async () => {},
      sendFile: async () => {},
      sendText: async (a) => { sentTexts.push(a.text); },
      sendCard: async () => {},
    };
    const outboundQueue = new OutboundQueue();
    outboundQueue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "file", path: big, fileName: "big.bin" });

    const runtime = makeRuntime({ adapter: stubAdapter(), outboundQueue, driver });
    await runtime.deliverQueued();

    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0], /exceeds 20MB/);
  } finally {
    setLocale("zh");
  }
});

test("handleCardAction pushfile with no binding returns error and enqueues nothing", async () => {
  const outboundQueue = new OutboundQueue();
  const router = { getThreadBinding: () => null };
  const adapter = { handleInbound: async () => ({}), commandRouter: router };
  const driver = {
    getStatus: () => ({}),
    uploadImage: async () => "img_1",
    sendImage: async () => {},
    sendText: async () => {},
    sendCard: async () => {},
  };
  const runtime = makeRuntime({ adapter, outboundQueue, driver });

  const res = await runtime.handleCardAction({
    event: { action: { value: { kind: "pushfile", threadId: "nope", path: "/etc/passwd" } }, open_id: "u1" },
  });
  assert.equal(res.toast.type, "error");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(outboundQueue.snapshot().length, 0);
});
