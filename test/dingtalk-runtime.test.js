// test/dingtalk-runtime.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DingTalkRuntimeService } from "../src/channels/dingtalk/runtime.js";
import { createDingTalkRenderer } from "../src/channels/dingtalk/renderer.js";

// The card-action handler now authorizes the real operator (their staffId) via
// the router's authorization store before running any side effect. These tests
// exercise the happy path, so seed a store that authorizes the clicking operator
// (OPERATOR_STAFF_ID, carried on the payload's top-level userId).
const OPERATOR_STAFF_ID = "staff-op";

function makeRuntime(routerOverrides = {}) {
  const resolved = [];
  const router = {
    authorization: {
      isAuthorized(identity) {
        return identity?.channel === "dingtalk" && identity?.stableId === OPERATOR_STAFF_ID;
      },
    },
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

function cardPayload({ params, userId = OPERATOR_STAFF_ID, outTrackId = "ot-1" }) {
  return {
    outTrackId,
    ...(userId !== undefined ? { userId } : {}),
    content: JSON.stringify({ cardPrivateData: { params } }),
  };
}

// Polls until a condition holds. The pick dispatch is fire-and-forget, so a
// fixed timeout races on slow/CI machines. Waiting on the actual post-condition
// makes the test deterministic.
async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test("approval callback resolves the approval and returns a card update", async () => {
  const { runtime, resolved } = makeRuntime();
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" } }));
  assert.deepEqual(resolved[0], { code: "a1", decision: "accept" });
  assert.ok(res.cardData?.cardParamMap, "returns an in-frame card update");
  assert.equal(res.cardData.cardParamMap.done, "true");
  assert.equal(res.cardData.cardParamMap.statusType, "primary");
  assert.equal(res.cardData.cardParamMap.approveParams, "");
  assert.equal(res.cardData.cardParamMap.sessionParams, "");
  assert.equal(res.cardData.cardParamMap.rejectParams, "");
});

test("review-2 (B-4): approval callback forwards the clicker identity to the router", async () => {
  const captured = [];
  const { runtime } = makeRuntime({
    resolveApproval: async (code, decision, identity) => captured.push([code, decision, identity]),
  });
  await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" } }));
  assert.equal(captured.length, 1);
  assert.equal(captured[0][2]?.channel, "dingtalk");
  assert.equal(captured[0][2]?.stableId, OPERATOR_STAFF_ID);
});

test("reject maps to decline", async () => {
  const { runtime, resolved } = makeRuntime();
  await runtime.handleCardAction(cardPayload({ params: { action: "reject", code: "a2" } }));
  assert.deepEqual(resolved[0], { code: "a2", decision: "decline" });
});

test("session approval maps to acceptForSession", async () => {
  const { runtime, resolved } = makeRuntime();
  await runtime.handleCardAction(cardPayload({ params: { action: "approve_session", code: "a3" } }));
  assert.deepEqual(resolved[0], { code: "a3", decision: "acceptForSession" });
});

test("pick callback dispatches async and returns immediately", async () => {
  const { runtime, enqueued } = makeRuntime();
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "pick", pickKind: "project", index: "1", conv: "staff-9" } }));
  assert.deepEqual(res, {});
  // wait for the fire-and-forget dispatch to enqueue the reply
  await waitFor(() => enqueued.some((r) => r.conversationId === "staff-9"));
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
