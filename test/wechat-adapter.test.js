import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { WeChatChannelAdapter } from "../src/channels/wechat/adapter.js";

function createAdapter() {
  const sent = [];
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  const adapter = new WeChatChannelAdapter({
    commandRouter: router,
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    sendReply: async (reply) => {
      sent.push(reply);
      return { ok: true };
    },
  });

  projects.replaceProjects([{
    name: "comote",
    path: "/home/test/projects/comote",
    source: "codex-desktop",
    status: "available",
  }]);

  return { adapter, authorization, sent };
}

test("normalizes WeChat direct messages into Comote channel messages", () => {
  const { adapter } = createAdapter();

  assert.deepEqual(
    adapter.normalizeInbound({
      channel: "comote-wechat",
      accountId: "wx_account_1",
      peer: {
        id: "wxid_owner",
        name: "Alice",
      },
      conversation: {
        id: "dm_wxid_owner",
        type: "direct",
      },
      message: {
        id: "msg_1",
        text: "/status",
      },
    }),
    {
      messageId: "msg_1",
      conversationId: "dm_wxid_owner",
      conversationType: "direct",
      accountId: "wx_account_1",
      identity: {
        channel: "wechat",
        stableId: "wx_account_1:wxid_owner",
        displayName: "Alice",
      },
      text: "/status",
      attachments: [],
    },
  );
});

test("sends a one-time guidance notice to unconfirmed WeChat identities", async () => {
  const { adapter, authorization, sent } = createAdapter();

  // First message: should receive a guidance notice
  const firstResult = await adapter.handleInbound({
    accountId: "wx_account_1",
    peer: { id: "wxid_unknown", name: "Unknown" },
    conversation: { id: "dm_wxid_unknown", type: "direct" },
    message: { id: "msg_1", text: "/status" },
  });

  assert.equal(firstResult.kind, "notice");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("确认"), `expected guidance text to mention 确认, got: ${sent[0].text}`);

  // Second message: silently denied, no additional reply sent
  const secondResult = await adapter.handleInbound({
    accountId: "wx_account_1",
    peer: { id: "wxid_unknown", name: "Unknown" },
    conversation: { id: "dm_wxid_unknown", type: "direct" },
    message: { id: "msg_2", text: "/status" },
  });

  assert.equal(secondResult.kind, "denied");
  assert.equal(sent.length, 1, "no additional message should be sent after the first notice");
  assert.deepEqual(authorization.listDetectedIdentities(), [
    {
      channel: "wechat",
      stableId: "wx_account_1:wxid_unknown",
      displayName: "Unknown",
      role: "operator",
    },
  ]);
});

test("routes authorized WeChat direct messages and sends text replies", async () => {
  const { adapter, authorization, sent } = createAdapter();
  authorization.confirmIdentity({
    channel: "wechat",
    stableId: "wx_account_1:wxid_owner",
    displayName: "Alice",
  });

  const openResult = await adapter.handleInbound({
    accountId: "wx_account_1",
    peer: { id: "wxid_owner", name: "Alice" },
    conversation: { id: "dm_wxid_owner", type: "direct" },
    message: { id: "msg_1", text: "/open 1" },
  });
  const statusResult = await adapter.handleInbound({
    accountId: "wx_account_1",
    peer: { id: "wxid_owner", name: "Alice" },
    conversation: { id: "dm_wxid_owner", type: "direct" },
    message: { id: "msg_2", text: "/status" },
  });

  assert.equal(openResult.kind, "text");
  assert.equal(statusResult.kind, "text");
  // The first reply is the /open result with the onboarding card prepended.
  const firstSent = sent[0];
  assert.equal(firstSent.conversationId, "dm_wxid_owner");
  assert.ok(firstSent.text.includes("你已连接到 Comote"), `expected onboarding card in first reply`);
  assert.ok(firstSent.text.includes("已进入 comote"), `expected /open output in first reply`);
  // The second reply is the /status result without the card.
  const secondSent = sent[1];
  assert.equal(secondSent.conversationId, "dm_wxid_owner");
  assert.ok(!secondSent.text.includes("你已连接到 Comote"), `expected no card in second reply`);
  assert.ok(
    secondSent.text.includes("Comote 状态"),
    `expected status text in second reply, got: ${secondSent.text}`,
  );
});

test("ignores group messages until group workflow is explicitly enabled", async () => {
  const { adapter, authorization, sent } = createAdapter();
  authorization.confirmIdentity({
    channel: "wechat",
    stableId: "wx_account_1:wxid_owner",
    displayName: "Alice",
  });

  const result = await adapter.handleInbound({
    accountId: "wx_account_1",
    peer: { id: "wxid_owner", name: "Alice" },
    conversation: { id: "room_1", type: "group" },
    message: { id: "msg_1", text: "/status" },
  });

  assert.equal(result.kind, "ignored");
  assert.deepEqual(sent, []);
});
