// Regression tests for [H1]: Feishu card-action buttons (approve/reject/cancel/
// pushfile) are a side channel around the inbound message path and MUST re-check
// authorization. Before this fix, ANY group member who could see a card could
// click approve and trigger Codex shell execution, or cancel/pushfile on another
// user's thread. These tests assert the runtime now:
//   1. denies card actions from open_ids that are not on the allow-list,
//   2. allows card actions from authorized open_ids,
//   3. binds cancel/pushfile to the thread owner so a *different* authorized
//      group member cannot act on another user's live card,
//   4. fails CLOSED for bare test-double routers with no authorization store
//      (production routers always have one), matching Telegram/DingTalk.

import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";
import { createFeishuRenderer } from "../src/channels/feishu/renderer.js";
import { setLocale } from "../src/core/i18n/index.js";

setLocale("en");

// Builds a runtime backed by a REAL CommandRouter + AuthorizationStore so the
// authorization gate exercises the production code path (not a mock).
function makeAuthRuntime({ codexDesktop = null } = {}) {
  const authorization = new AuthorizationStore();
  authorization.confirmIdentity({ channel: "feishu", stableId: "ou_owner", displayName: "Owner" });

  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const outboundQueue = new OutboundQueue();
  const router = new CommandRouter({
    authorization,
    projects,
    sessions,
    outboundQueue,
    codexDesktop,
  });

  const resolved = [];
  const cancelled = [];
  // Wrap resolveApproval / cancelThread so we can observe side effects without
  // a real Codex Desktop connection.
  router.resolveApproval = async (code, decision) => {
    resolved.push([code, decision]);
    return "ok";
  };
  router.cancelThread = async (threadId) => {
    cancelled.push(threadId);
    return { ok: true };
  };

  const updated = [];
  const runtime = new FeishuRuntimeService({
    renderer: createFeishuRenderer(),
    adapter: { handleInbound: async () => ({ kind: "text" }), commandRouter: router },
    outboundQueue,
    driver: {
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async updateCard(message) {
        updated.push(message);
      },
    },
  });

  return { runtime, router, authorization, resolved, cancelled, updated, outboundQueue };
}

test("[H1] approval from an UNAUTHORIZED open_id is denied (no resolveApproval)", async () => {
  const { runtime, resolved } = makeAuthRuntime();

  const result = await runtime.handleCardAction({
    open_id: "ou_stranger", // not on the allow-list
    open_message_id: "om_x",
    action: { value: { kind: "approval", code: "a1", decision: "accept" } },
  });

  assert.deepEqual(resolved, [], "unauthorized clicker must NOT resolve the approval");
  assert.equal(result.toast.type, "error");
  assert.match(result.toast.content, /Not authorized/);
});

test("[H1] approval with NO open_id is denied (cannot resolve clicker identity)", async () => {
  const { runtime, resolved } = makeAuthRuntime();

  const result = await runtime.handleCardAction({
    open_message_id: "om_x",
    action: { value: { kind: "approval", code: "a1", decision: "accept" } },
  });

  assert.deepEqual(resolved, []);
  assert.equal(result.toast.type, "error");
});

test("[H1] approval from an AUTHORIZED open_id resolves the approval", async () => {
  const { runtime, resolved, updated } = makeAuthRuntime();

  const result = await runtime.handleCardAction({
    open_id: "ou_owner",
    open_message_id: "om_approval",
    action: { value: { kind: "approval", code: "a1", decision: "accept" } },
  });

  assert.deepEqual(resolved, [["a1", "accept"]]);
  assert.equal(updated[0].messageId, "om_approval");
  assert.equal(result.toast.type, "success");
});

test("[H1] cancel from an UNAUTHORIZED open_id is denied (no cancelThread)", async () => {
  const { runtime, cancelled } = makeAuthRuntime();

  const result = await runtime.handleCardAction({
    open_id: "ou_stranger",
    action: { value: { kind: "cancel", threadId: "thread_c" } },
  });

  assert.deepEqual(cancelled, []);
  assert.equal(result.toast.type, "error");
});

test("[H1] pushfile from an UNAUTHORIZED open_id is denied (nothing enqueued)", async () => {
  const { runtime, outboundQueue } = makeAuthRuntime();

  const result = await runtime.handleCardAction({
    open_id: "ou_stranger",
    open_chat_id: "oc_chat",
    action: { value: { kind: "pushfile", threadId: "thread_c", path: "out.txt" } },
  });

  assert.equal(result.toast.type, "error");
  assert.equal(outboundQueue.list({ pendingOnly: false }).length, 0, "nothing should be enqueued");
});

test("[H1] a DIFFERENT authorized member cannot cancel another user's thread", async () => {
  const { runtime, router, authorization, cancelled } = makeAuthRuntime();
  // Add a second authorized member who does NOT own the thread.
  authorization.confirmIdentity({ channel: "feishu", stableId: "ou_other", displayName: "Other" });
  // Owner starts a thread: record the conversation, then bind the thread to it.
  const ownerIdentity = { channel: "feishu", stableId: "ou_owner" };
  router.conversationByIdentity.set("feishu:ou_owner", { channel: "feishu", conversationId: "oc_chat" });
  router.bindThreadForIdentity(ownerIdentity, "thread_owned", "/proj");

  // Sanity: the binding recorded the owner.
  assert.equal(router.getThreadBinding("thread_owned").ownerStableId, "ou_owner");

  const result = await runtime.handleCardAction({
    open_id: "ou_other", // authorized, but not the thread owner
    action: { value: { kind: "cancel", threadId: "thread_owned" } },
  });

  assert.deepEqual(cancelled, [], "a non-owner must not cancel another user's thread");
  assert.equal(result.toast.type, "error");
});

test("[H1] the thread OWNER can cancel their own thread", async () => {
  const { runtime, router, cancelled } = makeAuthRuntime();
  const ownerIdentity = { channel: "feishu", stableId: "ou_owner" };
  router.conversationByIdentity.set("feishu:ou_owner", { channel: "feishu", conversationId: "oc_chat" });
  router.bindThreadForIdentity(ownerIdentity, "thread_owned", "/proj");

  const result = await runtime.handleCardAction({
    open_id: "ou_owner",
    action: { value: { kind: "cancel", threadId: "thread_owned" } },
  });

  assert.deepEqual(cancelled, ["thread_owned"]);
  assert.equal(result.toast.type, "info");
});

test("[H1] bindThreadForIdentity records ownerStableId for ownership checks", () => {
  const authorization = new AuthorizationStore();
  const router = new CommandRouter({
    authorization,
    projects: new ProjectStore(),
    sessions: new SessionStore(),
  });
  router.conversationByIdentity.set("feishu:ou_owner", { channel: "feishu", conversationId: "oc_chat" });
  router.bindThreadForIdentity({ channel: "feishu", stableId: "ou_owner" }, "t1", "/p");
  const binding = router.getThreadBinding("t1");
  assert.equal(binding.ownerStableId, "ou_owner");
  assert.equal(binding.conversationId, "oc_chat");
});

test("[H1] bare test-double router (no authorization store) fails CLOSED, not open", async () => {
  // An auth gate with no authorization store wired in must DENY, not allow —
  // matching the Telegram/DingTalk callback gates. Production CommandRouter
  // always provides an authorization store, so this branch is only reachable
  // from a misconfigured/bare mock router; denying there is the safe default.
  const cancelled = [];
  const runtime = new FeishuRuntimeService({
    renderer: createFeishuRenderer(),
    adapter: {
      handleInbound: async () => ({ kind: "text" }),
      commandRouter: { cancelThread: async (threadId) => cancelled.push(threadId) },
    },
    outboundQueue: new OutboundQueue(),
    driver: { getStatus: () => ({ state: "configured" }), verifyEvent: () => true },
  });

  const result = await runtime.handleCardAction({
    action: { value: { kind: "cancel", threadId: "thread_c" } },
  });
  assert.deepEqual(cancelled, [], "a router with no authorization store must not act");
  assert.equal(result.toast.type, "error");
});
