// test/telegram-runtime-livecard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramRuntimeService } from "../src/channels/telegram/runtime.js";
import { createTelegramRenderer } from "../src/channels/telegram/renderer.js";

function makeRuntime() {
  const calls = { send: [], edit: [] };
  const driver = {
    async sendMessage(a) { calls.send.push(a); return { message_id: 42 }; },
    async editMessageText(a) { calls.edit.push(a); },
  };
  const rt = new TelegramRuntimeService({
    adapter: { commandRouter: {}, sendReply: async () => {} },
    outboundQueue: { list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver,
    cardUpdateIntervalMs: 0, // flush immediately in tests
  });
  return { rt, calls };
}

test("openThreadCard sends a message and tracks the message id", async () => {
  const { rt, calls } = makeRuntime();
  const opened = await rt.openThreadCard({ threadId: "t1", conversationId: "9", card: rt.buildStatusCard({ phase: "started", threadId: "t1" }) });
  assert.equal(opened, true);
  assert.equal(calls.send[0].chatId, "9");
  assert.equal(rt.hasThreadCard("t1"), true);
});

test("openThreadCard with no conversationId degrades to false", async () => {
  const { rt } = makeRuntime();
  assert.equal(await rt.openThreadCard({ threadId: "t1", conversationId: null, card: { text: "x" } }), false);
});

test("update then finish edits the tracked message", async () => {
  const { rt, calls } = makeRuntime();
  await rt.openThreadCard({ threadId: "t1", conversationId: "9", card: rt.buildStatusCard({ phase: "started", threadId: "t1" }) });
  rt.updateThreadCard("t1", rt.buildStatusCard({ phase: "progress", threadId: "t1", steps: 1, text: "working" }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].messageId, 42);
  await rt.finishThreadCard("t1", rt.buildStatusCard({ phase: "completed", threadId: "t1", text: "done", done: true }));
  assert.equal(rt.hasThreadCard("t1"), false);
  assert.match(calls.edit.at(-1).text, /done/);
});

test("a 'message is not modified' edit error is swallowed", async () => {
  const { rt } = makeRuntime();
  rt.driver.editMessageText = async () => { throw new Error("Bad Request: message is not modified"); };
  await rt.openThreadCard({ threadId: "t1", conversationId: "9", card: { text: "a" } });
  const ok = await rt._edit(rt.cardSessions.get("t1"), { text: "a" });
  assert.equal(ok, true);
  assert.equal(rt.lastError, null);
});
