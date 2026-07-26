// test/telegram-runtime.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramRuntimeService } from "../src/channels/telegram/runtime.js";
import { createTelegramRenderer } from "../src/channels/telegram/renderer.js";
import { encodeCallback } from "../src/channels/telegram/cards.js";

function makeRuntime(overrides = {}) {
  const router = { authorization: { isAuthorized: () => true }, resolveApproval: async () => {}, cancelThread: async () => {}, chooseProject: async () => "chosen", useSessionAsync: async () => "used" };
  const calls = { resolve: [], cancel: [], answer: [] };
  router.resolveApproval = async (code, decision, identity) => { calls.resolve.push([code, decision, identity]); };
  router.cancelThread = async (tid) => { calls.cancel.push(tid); };
  const driver = {
    async answerCallbackQuery(a) { calls.answer.push(a); },
    async editMessageText() {},
    async sendMessage() { return { message_id: 1 }; },
  };
  const adapter = { commandRouter: router, sendReply: async () => ({ ok: true }) };
  const rt = new TelegramRuntimeService({
    adapter,
    outboundQueue: { list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver,
    ensurePairingCode: async () => {},
    ...overrides,
  });
  return { rt, calls };
}

test("approve callback resolves the approval + answers the callback query", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({ id: "cq1", data: "ap:A1", message: { chat: { id: 9 }, message_id: 5 }, from: { id: 9 } });
  assert.equal(calls.resolve[0][0], "A1");
  assert.equal(calls.resolve[0][1], "accept");
  // review-2 (B-4): approval callbacks carry no threadId, so the clicker
  // identity must be forwarded for the router's thread-owner check.
  assert.deepEqual(calls.resolve[0][2], { channel: "telegram", stableId: "9" });
  assert.equal(calls.answer[0].callbackQueryId, "cq1");
});

test("session approval callback maps to acceptForSession", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({
    id: "cq-session",
    data: "as:A1",
    message: { chat: { id: 42 }, message_id: 5 },
    from: { id: 42 },
  });
  assert.deepEqual(calls.resolve[0].slice(0, 2), ["A1", "acceptForSession"]);
});

test("review-2 (B-4): a not-owner rejection from the router is swallowed gracefully", async () => {
  const { rt, calls } = makeRuntime();
  calls.resolve.length = 0;
  rt.adapter.commandRouter.resolveApproval = async () => {
    const error = new Error("只有该任务的发起人可以处理这条审批。");
    error.code = "not_owner";
    throw error;
  };
  await rt.handleCallbackQuery({ id: "cq9", data: "ap:A1", message: { chat: { id: 9 }, message_id: 5 }, from: { id: 777 } });
  assert.equal(calls.answer.at(-1).callbackQueryId, "cq9", "callback still answered, no crash");
});

test("reject callback resolves with decline", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({ id: "cq2", data: "rj:A1", message: { chat: { id: 9 }, message_id: 5 }, from: { id: 9 } });
  assert.equal(calls.resolve[0][0], "A1");
  assert.equal(calls.resolve[0][1], "decline");
});

test("cancel callback cancels the thread", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({ id: "cq3", data: "ck:t-7", message: { chat: { id: 9 }, message_id: 5 }, from: { id: 9 } });
  assert.deepEqual(calls.cancel, ["t-7"]);
});

test("unknown callback data is answered but does nothing", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({ id: "cq4", data: "zzz", message: { chat: { id: 9 } }, from: { id: 9 } });
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.answer.length, 1);
});

test("dispatchPickAsync routes project→chooseProject and session→useSessionAsync, with a unique dedupeKey", async () => {
  const sent = [];
  const router = {
    resolveApproval: async () => {}, cancelThread: async () => {},
    chooseProject: async () => "picked project", useSessionAsync: async () => "picked session",
  };
  const rt = new TelegramRuntimeService({
    adapter: { commandRouter: router, sendReply: async (r) => { sent.push(r); return { ok: true }; } },
    outboundQueue: { list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver: { async answerCallbackQuery() {}, async editMessageText() {}, async sendMessage() { return { message_id: 1 }; } },
    ensurePairingCode: async () => {},
  });
  await rt.dispatchPickAsync({ identity: { channel: "telegram", stableId: "9" }, selector: "2", pickKind: "project", conversationId: "9" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "picked project");
  assert.match(sent[0].dedupeKey, /^telegram:pick:9:project:2:/);
  await rt.dispatchPickAsync({ identity: { channel: "telegram", stableId: "9" }, selector: "1", pickKind: "session", conversationId: "9" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, "picked session");
  assert.match(sent[1].dedupeKey, /^telegram:pick:9:session:1:/);
});

test("buildStatusCard remembers files (bounded) and pushfile click enqueues the resolved media", async () => {
  const root = await mkdtemp(join(tmpdir(), "comote-tg-pf-"));
  const pngPath = join(root, "shot.png");
  await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const enqueued = [];
  const router = {
    authorization: { isAuthorized: () => true },
    resolveApproval: async () => {}, cancelThread: async () => {},
    getThreadBinding: (tid) => (tid === "t-9" ? { conversationId: "9", projectPath: root } : null),
  };
  const rt = new TelegramRuntimeService({
    adapter: { commandRouter: router, sendReply: async () => ({ ok: true }) },
    outboundQueue: { enqueue: (m) => enqueued.push(m), list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver: { async answerCallbackQuery() {}, async editMessageText() {}, async sendMessage() { return { message_id: 1 }; } },
    ensurePairingCode: async () => {},
  });

  // Remember the turn's files via buildStatusCard (mirrors the completion path).
  const card = rt.buildStatusCard({ done: true, threadId: "t-9", phase: "completed", files: [{ path: pngPath, name: "shot.png" }] });
  assert.ok(card.replyMarkup?.inline_keyboard?.length === 1, "the card carries one file button");

  // threadFiles is bounded.
  assert.equal(rt._maxThreadFiles, 200);

  const data = encodeCallback({ action: "pushfile", threadId: "t-9", fileIndex: 0 });
  await rt.handleCallbackQuery({ id: "cqpf", data, message: { chat: { id: 9 } }, from: { id: 9 } });
  assert.equal(enqueued.length, 1, "the click enqueued one media item");
  assert.equal(enqueued[0].kind, "media");
  assert.equal(enqueued[0].path, pngPath);
  assert.equal(enqueued[0].conversationId, "9");
});

test("pushfile click outside the project fence is rejected (no enqueue)", async () => {
  const root = await mkdtemp(join(tmpdir(), "comote-tg-fence-"));
  const outside = join(tmpdir(), "comote-tg-outside-secret.txt");
  await writeFile(outside, "secret");

  const enqueued = [];
  const warns = [];
  const router = {
    authorization: { isAuthorized: () => true },
    resolveApproval: async () => {}, cancelThread: async () => {},
    getThreadBinding: () => ({ conversationId: "9", projectPath: root }),
  };
  const rt = new TelegramRuntimeService({
    adapter: { commandRouter: router, sendReply: async () => ({ ok: true }) },
    outboundQueue: { enqueue: (m) => enqueued.push(m), list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver: { async answerCallbackQuery() {}, async editMessageText() {}, async sendMessage() { return { message_id: 1 }; } },
    eventLog: { warn: (...a) => warns.push(a), error() {} },
    ensurePairingCode: async () => {},
  });
  rt.threadFiles.set("t-9", [{ path: outside, name: "secret.txt" }]);

  const data = encodeCallback({ action: "pushfile", threadId: "t-9", fileIndex: 0 });
  await rt.handleCallbackQuery({ id: "cqfence", data, message: { chat: { id: 9 } }, from: { id: 9 } });
  assert.equal(enqueued.length, 0, "out-of-fence path is not enqueued");
  assert.equal(warns.length, 1, "the fence violation is logged");
});

test("start() registers the bot command menu via setMyCommands (B-8)", async () => {
  const { rt } = makeRuntime();
  const registered = [];
  rt.driver.startEventStream = async () => ({ ok: true });
  rt.driver.stopEventStream = () => {};
  rt.driver.setMyCommands = async (commands) => { registered.push(commands); };
  await rt.start();
  assert.equal(registered.length, 1, "command menu registered once on start");
  const names = registered[0].map((c) => c.command);
  for (const want of ["status", "projects", "sessions", "use", "new", "tail", "approve", "deny", "automode", "cancel", "file", "help"]) {
    assert.ok(names.includes(want), `menu includes /${want}`);
  }
  for (const c of registered[0]) {
    assert.match(c.command, /^[a-z0-9_]+$/, "telegram command names are lowercase, no slash");
    assert.ok(c.description.length > 0);
  }
  rt.stop();
});

test("start() succeeds even when the driver lacks setMyCommands or it fails (B-8)", async () => {
  const { rt } = makeRuntime();
  rt.driver.startEventStream = async () => ({ ok: true });
  rt.driver.stopEventStream = () => {};
  rt.driver.setMyCommands = async () => { throw new Error("network down"); };
  const status = await rt.start();
  assert.equal(status.state, "running", "menu failure never blocks the channel");
  rt.stop();
});

test("sendTyping fires the driver's sendChatAction and never throws (B-8)", async () => {
  const { rt } = makeRuntime();
  const actions = [];
  rt.driver.sendChatAction = async (a) => { actions.push(a); };
  await rt.sendTyping({ conversationId: "55" });
  assert.deepEqual(actions[0], { chatId: "55", action: "typing" });
  // A failing chat action is swallowed.
  rt.driver.sendChatAction = async () => { throw new Error("boom"); };
  await rt.sendTyping({ conversationId: "55" });
  // No driver support / no conversation → silent no-op.
  delete rt.driver.sendChatAction;
  await rt.sendTyping({ conversationId: "55" });
  await rt.sendTyping({ conversationId: null });
});

test("start() calls ensurePairingCode before starting", async () => {
  const order = [];
  const { rt } = makeRuntime({ ensurePairingCode: async () => { order.push("pair"); } });
  rt.driver.startEventStream = async () => { order.push("start"); return { ok: true }; };
  await rt.start();
  assert.deepEqual(order, ["pair", "start"]);
});
