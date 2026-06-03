// test/dingtalk-runtime.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DingTalkRuntimeService } from "../src/channels/dingtalk/runtime.js";
import { createDingTalkRenderer } from "../src/channels/dingtalk/renderer.js";

function makeRuntime(routerOverrides = {}) {
  const resolved = [];
  const router = {
    async resolveApproval(code, decision) { resolved.push({ code, decision }); },
    async chooseProject() { return { kind: "text", text: "chosen" }; },
    async useSessionAsync() { return { kind: "text", text: "session" }; },
    conversationByIdentity: new Map(),
    ...routerOverrides,
  };
  const enqueued = [];
  const adapter = {
    commandRouter: router,
    async sendReply(r) { enqueued.push(r); return { ok: true }; },
  };
  const outboundQueue = { enqueue() {}, list() { return []; }, markDelivered() {}, markFailed() {} };
  const runtime = new DingTalkRuntimeService({
    adapter,
    outboundQueue,
    renderer: createDingTalkRenderer({ templates: { approval: "a.schema" } }),
    driver: { async updateCard() {}, getStatus: () => ({}) },
  });
  return { runtime, resolved, enqueued, router };
}

function cardPayload({ params, outTrackId = "ot-1" }) {
  return { outTrackId, content: JSON.stringify({ cardPrivateData: { params } }) };
}

test("approval callback resolves the approval and returns a card update", async () => {
  const { runtime, resolved } = makeRuntime();
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" } }));
  assert.deepEqual(resolved[0], { code: "a1", decision: "accept" });
  assert.ok(res.cardData?.cardParamMap, "returns an in-frame card update");
});

test("reject maps to decline", async () => {
  const { runtime, resolved } = makeRuntime();
  await runtime.handleCardAction(cardPayload({ params: { action: "reject", code: "a2" } }));
  assert.deepEqual(resolved[0], { code: "a2", decision: "decline" });
});

test("pick callback dispatches async and returns immediately", async () => {
  const { runtime, enqueued } = makeRuntime();
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "pick", pickKind: "project", index: "1", conv: "staff-9" } }));
  assert.deepEqual(res, {});
  // allow the fire-and-forget dispatch to settle
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(enqueued.some((r) => r.conversationId === "staff-9"), "a reply was enqueued for the conversation");
});

test("cancel callback requests thread cancellation", async () => {
  const cancelled = [];
  const { runtime } = makeRuntime({ async cancelThread(threadId) { cancelled.push(threadId); } });
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "cancel", threadId: "thread-7" } }));
  assert.deepEqual(res, {});
  assert.deepEqual(cancelled, ["thread-7"]);
});

test("unknown action returns empty object", async () => {
  const { runtime } = makeRuntime();
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "nope" } }));
  assert.deepEqual(res, {});
});

test("onAction is wired to handleCardAction", () => {
  const { runtime } = makeRuntime();
  assert.equal(typeof runtime.onAction, "function");
});
