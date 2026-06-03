// test/telegram-runtime.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramRuntimeService } from "../src/channels/telegram/runtime.js";
import { createTelegramRenderer } from "../src/channels/telegram/renderer.js";

function makeRuntime(overrides = {}) {
  const router = { resolveApproval: async () => {}, cancelThread: async () => {}, chooseProject: async () => "chosen", useSessionAsync: async () => "used" };
  const calls = { resolve: [], cancel: [], answer: [] };
  router.resolveApproval = async (code, decision) => { calls.resolve.push([code, decision]); };
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
  assert.deepEqual(calls.resolve[0], ["A1", "accept"]);
  assert.equal(calls.answer[0].callbackQueryId, "cq1");
});

test("reject callback resolves with decline", async () => {
  const { rt, calls } = makeRuntime();
  await rt.handleCallbackQuery({ id: "cq2", data: "rj:A1", message: { chat: { id: 9 }, message_id: 5 }, from: { id: 9 } });
  assert.deepEqual(calls.resolve[0], ["A1", "decline"]);
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

test("start() calls ensurePairingCode before starting", async () => {
  const order = [];
  const { rt } = makeRuntime({ ensurePairingCode: async () => { order.push("pair"); } });
  rt.driver.startEventStream = async () => { order.push("start"); return { ok: true }; };
  await rt.start();
  assert.deepEqual(order, ["pair", "start"]);
});
