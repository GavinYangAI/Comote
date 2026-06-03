import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { WeChatChannelAdapter } from "../src/channels/wechat/adapter.js";
import { WeChatRuntimeService } from "../src/channels/wechat/runtime.js";

test("wechat runtime polls updates, routes commands, and delivers queued replies", async () => {
  const authorization = new AuthorizationStore();
  authorization.confirmIdentity({
    channel: "wechat",
    stableId: "wx_account_1:wxid_owner",
    displayName: "Alice",
  });
  const projects = new ProjectStore();
  projects.replaceProjects([{ name: "comote", path: "/repo/comote", source: "codex-desktop", status: "available" }]);
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  const outbound = new OutboundQueue();
  const adapter = new WeChatChannelAdapter({
    commandRouter: router,
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    sendReply: async (reply) => outbound.enqueue(reply),
  });
  const delivered = [];
  const driver = {
    getStatus: () => ({ state: "configured" }),
    async getUpdates() {
      return {
        nextCursor: "cursor_2",
        updates: [
          {
            account_id: "wx_account_1",
            from_user_id: "wxid_owner",
            sender_name: "Alice",
            conversation_id: "dm_wxid_owner",
            message_id: "msg_1",
            text: "/projects",
          },
        ],
      };
    },
    normalizeUpdate(update) {
      return {
        accountId: update.account_id,
        peer: { id: update.from_user_id, name: update.sender_name },
        conversation: { id: update.conversation_id, type: "direct" },
        message: { id: update.message_id, text: update.text },
      };
    },
    async sendText(reply) {
      delivered.push(reply);
      return { ok: true };
    },
  };

  const runtime = new WeChatRuntimeService({ adapter, outboundQueue: outbound, driver });
  const result = await runtime.pollOnce();

  assert.equal(result.inbound, 1);
  assert.equal(result.outbound, 1);
  assert.equal(runtime.getStatus().cursor, "cursor_2");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /comote/);
  assert.equal(delivered[0].clientId, deliveryId(delivered[0].dedupeKey));
  assert.deepEqual(outbound.list(), []);
});

test("wechat runtime dedup ignores a redelivered duplicate message", async () => {
  let routed = 0;
  const runtime = new WeChatRuntimeService({
    adapter: {
      handleInbound: async () => {
        routed += 1;
        return { kind: "text", text: "ok" };
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: {
      getStatus: () => ({ state: "configured" }),
      async getUpdates() {
        return { updates: [] };
      },
      normalizeUpdate(update) {
        return update;
      },
    },
  });

  const update1 = {
    accountId: "wx_account_1",
    peer: { id: "wxid_user", name: "User" },
    conversation: { id: "dm_wxid_user", type: "direct" },
    message: { id: "msg_1", text: "hello" },
  };
  const update2 = { ...update1 };

  // First poll of the message should route it
  const result1 = await runtime.pollOnce();
  // Manually add message to simulate redelivery
  runtime.adapter.handleInbound(update1);
  routed = 0;

  // Simulate a redelivery of the same message
  runtime.adapter.handleInbound(update2);

  // Both calls to #alreadyHandled should detect the duplicate on the second call
  // We test this via the pollOnce flow which calls #alreadyHandled
  const deliveredDuplicates = [];
  const driver2 = {
    getStatus: () => ({ state: "configured" }),
    async getUpdates() {
      return {
        nextCursor: "cursor_2",
        updates: [update1, update1], // Same message delivered twice
      };
    },
    normalizeUpdate(update) {
      return update;
    },
    async sendText(reply) {
      deliveredDuplicates.push(reply);
      return { ok: true };
    },
  };

  let handledCount = 0;
  const runtime2 = new WeChatRuntimeService({
    adapter: {
      handleInbound: async () => {
        handledCount += 1;
        return { kind: "text", text: "ok" };
      },
    },
    outboundQueue: new OutboundQueue(),
    driver: driver2,
  });

  const pollResult = await runtime2.pollOnce();
  assert.equal(handledCount, 1, "redelivered message must be routed only once");
  assert.equal(pollResult.inbound, 1);
});

test("wechat runtime tracks bounded set of seen message ids without rebuilding", async () => {
  // Helper to create a driver that returns distinct messages
  const createDriver = (messageIds) => {
    let callCount = 0;
    return {
      getStatus: () => ({ state: "configured" }),
      async getUpdates() {
        // Return a batch of messages on each call, cycling through to deliver all
        if (callCount === 0) {
          callCount++;
          const batch = messageIds.slice(0, 500).map((msgId) => ({
            account_id: "wx_account_1",
            from_user_id: "wxid_user",
            sender_name: "User",
            conversation_id: "dm_wxid_user",
            message_id: msgId,
            text: `message ${msgId}`,
          }));
          return { nextCursor: "cursor_2", updates: batch };
        } else if (callCount === 1) {
          callCount++;
          const batch = messageIds.slice(500).map((msgId) => ({
            account_id: "wx_account_1",
            from_user_id: "wxid_user",
            sender_name: "User",
            conversation_id: "dm_wxid_user",
            message_id: msgId,
            text: `message ${msgId}`,
          }));
          return { nextCursor: "cursor_3", updates: batch };
        }
        return { nextCursor: "cursor_3", updates: [] };
      },
      normalizeUpdate(update) {
        return {
          accountId: update.account_id,
          peer: { id: update.from_user_id, name: update.sender_name },
          conversation: { id: update.conversation_id, type: "direct" },
          message: { id: update.message_id, text: update.text },
        };
      },
      async sendText(reply) {
        return { ok: true };
      },
    };
  };

  // Create an array of 1100 distinct message IDs
  const cap = 1000;
  const messageIds = Array.from({ length: cap + 100 }, (_, i) => `msg_${i + 1}`);

  const runtime = new WeChatRuntimeService({
    adapter: {
      handleInbound: async () => ({ kind: "text", text: "ok" }),
    },
    outboundQueue: new OutboundQueue(),
    driver: createDriver(messageIds),
  });

  // Poll twice to process all 1100 messages through the dedup logic
  await runtime.pollOnce();
  await runtime.pollOnce();

  // Verify the tracking set stays bounded and does not exceed cap
  assert.ok(
    runtime.seenMessageIds.size <= cap,
    `set size (${runtime.seenMessageIds.size}) must not exceed cap (${cap})`
  );

  // Verify that after processing 1100 messages, the oldest 100 are evicted
  // and new messages are retained for dedup
  for (let i = 1; i <= 100; i++) {
    const msgId = `msg_${i}`;
    assert.equal(
      runtime.seenMessageIds.has(msgId),
      false,
      `old message ${msgId} should have been evicted after cap exceeded`
    );
  }

  // Verify that at least the newer 900 messages are in the set
  // (exact count depends on the incremental eviction strategy)
  let recentCount = 0;
  for (let i = 101; i <= cap + 100; i++) {
    const msgId = `msg_${i}`;
    if (runtime.seenMessageIds.has(msgId)) {
      recentCount += 1;
    }
  }
  assert.ok(
    recentCount >= 900,
    `at least 900 recent messages should be tracked, got ${recentCount}`
  );
});

function deliveryId(source) {
  return `comote-${createHash("sha256").update(String(source)).digest("hex").slice(0, 32)}`;
}
