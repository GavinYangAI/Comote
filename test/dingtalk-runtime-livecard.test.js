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

test("live approval updates and resumes one status card instance", async () => {
  const { runtime, driver } = makeRuntime();
  await runtime.openThreadCard({
    threadId: "t1",
    conversationId: "s",
    card: runtime.buildStatusCard({ phase: "started", threadId: "t1" }),
  });
  await runtime.showThreadApproval({
    threadId: "t1",
    code: "a1",
    approval: { shortCode: "a1", params: { command: "npm test" } },
  });
  assert.equal(driver.created.length, 1, "approval reuses the created status card");
  assert.equal(driver.updated.at(-1).outTrackId, driver.created[0].outTrackId);
  assert.equal(driver.updated.at(-1).cardParamMap.approvalVisible, "true");

  const updateCount = driver.updated.length;
  runtime.updateThreadCard("t1", { title: "working", body: "latest" });
  await runtime.flushThreadCard("t1");
  assert.equal(driver.updated.length, updateCount, "approval remains visible while progress accumulates");

  const updateCard = driver.updateCard.bind(driver);
  let failResume = true;
  driver.updateCard = async (message) => {
    if (failResume) {
      failResume = false;
      throw new Error("temporary update failure");
    }
    return updateCard(message);
  };
  await assert.rejects(
    () => runtime.resolveApprovalMessage({ code: "a1", decision: "accept" }),
    /temporary update failure/,
  );
  assert.equal(runtime.cardSessions.get("t1").paused, true);
  assert.equal(runtime.liveApprovalThreads.has("a1"), true);

  await runtime.resolveApprovalMessage({ code: "a1", decision: "accept" });
  assert.equal(driver.updated.at(-1).cardParamMap.body, "latest");
});

test("failed live approval display restores queued progress", async () => {
  const { runtime, driver } = makeRuntime();
  runtime.cardUpdateIntervalMs = 60_000;
  await runtime.openThreadCard({
    threadId: "t1",
    conversationId: "s",
    card: runtime.buildStatusCard({ phase: "started", threadId: "t1" }),
  });
  const queued = { title: "working", body: "queued" };
  runtime.updateThreadCard("t1", queued);
  driver.updateCard = async () => { throw new Error("approval update failed"); };

  await assert.rejects(
    () => runtime.showThreadApproval({
      threadId: "t1",
      code: "a-fail",
      approval: { shortCode: "a-fail", params: { command: "npm test" } },
    }),
    /approval update failed/,
  );
  const session = runtime.cardSessions.get("t1");
  assert.equal(session.paused, false);
  assert.equal(session.pendingCard, queued);
  assert.equal(session.resumeCard, null);
  assert.equal(runtime.liveApprovalThreads.has("a-fail"), false);
});
