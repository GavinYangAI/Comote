import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";

function createAdapter() {
  const sent = [];
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const adapter = new FeishuChannelAdapter({
    commandRouter: new CommandRouter({ authorization, projects, sessions }),
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    sendReply: async (reply) => sent.push(reply),
  });
  projects.replaceProjects([{ name: "comote", path: "/repo", source: "codex-desktop", status: "available" }]);
  return { adapter, authorization, sent };
}

test("normalizes Feishu bot events into Comote messages", () => {
  const { adapter } = createAdapter();

  assert.deepEqual(
    adapter.normalizeInbound({
      event: {
        sender: {
          sender_id: { open_id: "ou_owner" },
          sender_type: "user",
        },
        message: {
          message_id: "msg_1",
          chat_id: "oc_chat",
          chat_type: "p2p",
          content: JSON.stringify({ text: "/status" }),
        },
      },
    }),
    {
      messageId: "msg_1",
      conversationId: "oc_chat",
      conversationType: "direct",
      identity: {
        channel: "feishu",
        stableId: "ou_owner",
        displayName: "ou_owner",
      },
      text: "/status",
      attachments: [],
    },
  );
});

test("authorized Feishu messages route through Comote", async () => {
  const { adapter, authorization, sent } = createAdapter();
  authorization.confirmIdentity({ channel: "feishu", stableId: "ou_owner", displayName: "Alice" });

  const reply = await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "/projects" }),
      },
    },
  });

  assert.equal(reply.kind, "text");
  assert.match(sent[0].text, /1\. comote/);
});

test("feishu adapter renders a picker reply as a button card", async () => {
  const sent = [];
  const adapter = new FeishuChannelAdapter({
    commandRouter: {
      handleMessageAsync: async () => ({
        kind: "text",
        text: "请选择对话：\n\n0. 新建对话",
        picker: {
          pickKind: "session",
          items: [{ label: "新建对话", index: "0" }],
        },
      }),
    },
    sendReply: async (reply) => sent.push(reply),
  });

  await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "/sessions" }),
      },
    },
  });

  assert.equal(sent.length, 1);
  const action = sent[0].card.elements.find((el) => el.tag === "action");
  assert.ok(action, "picker reply produced a button card");
  assert.equal(action.actions[0].value.kind, "pick");
});

test("feishu adapter resolves a missing sender name before detecting the identity", async () => {
  const detected = [];
  const adapter = new FeishuChannelAdapter({
    commandRouter: { handleMessageAsync: async () => ({ kind: "ignored" }) },
    onDetectedIdentity: (identity) => detected.push(identity),
    resolveDisplayName: async (openId) => (openId === "ou_owner" ? "李四" : null),
  });

  await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi" }),
      },
    },
  });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].displayName, "李四");
});

test("feishu adapter keeps an event-provided name without calling the resolver", async () => {
  let resolverCalls = 0;
  const detected = [];
  const adapter = new FeishuChannelAdapter({
    commandRouter: { handleMessageAsync: async () => ({ kind: "ignored" }) },
    onDetectedIdentity: (identity) => detected.push(identity),
    resolveDisplayName: async () => {
      resolverCalls += 1;
      return "不该用到";
    },
  });

  await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_owner" }, name: "王五" },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi" }),
      },
    },
  });

  assert.equal(detected[0].displayName, "王五");
  assert.equal(resolverCalls, 0);
});

test("normalizeInbound extracts image and file attachments", () => {
  const adapter = new FeishuChannelAdapter({ commandRouter: { handleMessageAsync: async () => ({}) } });

  const imageMsg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "u1" }, name: "A" },
      message: {
        message_id: "m1",
        chat_id: "c1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_k" }),
      },
    },
  });
  assert.deepEqual(imageMsg.attachments, [{ type: "image", fileKey: "img_k", fileName: "image.png", messageId: "m1" }]);
  assert.equal(imageMsg.text, "");

  const fileMsg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "u1" }, name: "A" },
      message: {
        message_id: "m2",
        chat_id: "c1",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_k", file_name: "report.pdf" }),
      },
    },
  });
  assert.deepEqual(fileMsg.attachments, [{ type: "file", fileKey: "file_k", fileName: "report.pdf", messageId: "m2" }]);
  assert.equal(fileMsg.text, "");
});
