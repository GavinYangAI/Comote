// test/dingtalk-runtime-livecard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DingTalkRuntimeService } from "../src/channels/dingtalk/runtime.js";
import { createDingTalkRenderer } from "../src/channels/dingtalk/renderer.js";

function makeRuntime({ templates = { status: "st.schema" } } = {}) {
  const driver = {
    created: [],
    updated: [],
    async createCard(a) { this.created.push(a); return { outTrackId: a.outTrackId }; },
    async updateCard(a) { this.updated.push(a); },
    getStatus: () => ({}),
  };
  const runtime = new DingTalkRuntimeService({
    adapter: { commandRouter: {}, async sendReply() {} },
    outboundQueue: { enqueue() {}, list() { return []; }, markDelivered() {}, markFailed() {} },
    renderer: createDingTalkRenderer({ templates }),
    driver,
    cardUpdateIntervalMs: 0,
  });
  return { runtime, driver };
}

test("buildStatusCard delegates to the renderer (cardParamMap)", () => {
  const { runtime } = makeRuntime();
  const card = runtime.buildStatusCard({ phase: "started", threadId: "t1" });
  assert.equal(typeof card.title, "string");
});

test("openThreadCard creates a card and tracks the thread", async () => {
  const { runtime, driver } = makeRuntime();
  await runtime.openThreadCard({ threadId: "t1", conversationId: "s", card: runtime.buildStatusCard({ phase: "started", threadId: "t1" }) });
  assert.equal(driver.created.length, 1);
  assert.equal(driver.created[0].receiveId, "s");
  assert.equal(runtime.hasThreadCard("t1"), true);
});

test("finishThreadCard updates and drops the session", async () => {
  const { runtime, driver } = makeRuntime();
  await runtime.openThreadCard({ threadId: "t1", conversationId: "s", card: runtime.buildStatusCard({ phase: "started", threadId: "t1" }) });
  await runtime.finishThreadCard("t1", runtime.buildStatusCard({ phase: "completed", text: "done", done: true }));
  assert.equal(driver.updated.length, 1);
  assert.equal(runtime.hasThreadCard("t1"), false);
});

test("openThreadCard without a status template id is a no-op (degrades silently)", async () => {
  const { runtime, driver } = makeRuntime({ templates: {} });
  const opened = await runtime.openThreadCard({ threadId: "t1", conversationId: "s", card: runtime.buildStatusCard({ phase: "started", threadId: "t1" }) });
  assert.equal(opened, false);
  assert.equal(driver.created.length, 0);
  assert.equal(runtime.hasThreadCard("t1"), false);
});
