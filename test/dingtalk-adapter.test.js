// test/dingtalk-adapter.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk/adapter.js";

function makeAdapter(overrides = {}) {
  return new DingTalkChannelAdapter({
    commandRouter: { async handleMessageAsync() { return null; }, identityKey: (i) => `dingtalk:${i.stableId}` },
    sendReply: async () => ({ ok: true }),
    ...overrides,
  });
}

test("normalizeInbound maps a 1:1 text message", () => {
  const a = makeAdapter();
  const msg = a.normalizeInbound({
    conversationId: "cid-1",
    conversationType: "1",
    senderStaffId: "staff-9",
    senderNick: "Ada",
    msgId: "m-1",
    msgtype: "text",
    text: { content: "hello" },
  });
  assert.equal(msg.conversationType, "direct");
  assert.equal(msg.conversationId, "staff-9"); // 1:1 addresses by staffId (oToMessages userIds)
  assert.equal(msg.messageId, "m-1");
  assert.equal(msg.text, "hello");
  assert.deepEqual(msg.identity, { channel: "dingtalk", stableId: "staff-9", displayName: "Ada" });
  assert.deepEqual(msg.attachments, []);
});

test("normalizeInbound flags a group message as non-direct", () => {
  const a = makeAdapter();
  const msg = a.normalizeInbound({
    conversationId: "g-1",
    conversationType: "2",
    senderStaffId: "staff-9",
    msgtype: "text",
    text: { content: "hi" },
  });
  assert.equal(msg.conversationType, "group");
});

test("normalizeInbound extracts a file attachment downloadCode", () => {
  const a = makeAdapter();
  const msg = a.normalizeInbound({
    conversationId: "cid",
    conversationType: "1",
    senderStaffId: "staff-9",
    msgId: "m-2",
    msgtype: "file",
    content: { downloadCode: "dc-1", fileName: "report.pdf" },
  });
  assert.equal(msg.text, "");
  assert.deepEqual(msg.attachments, [{ type: "file", downloadCode: "dc-1", fileName: "report.pdf", messageId: "m-2" }]);
});

test("normalizeInbound extracts a picture attachment", () => {
  const a = makeAdapter();
  const msg = a.normalizeInbound({
    conversationType: "1",
    senderStaffId: "s",
    msgId: "m-3",
    msgtype: "picture",
    content: { downloadCode: "pic-1" },
  });
  assert.equal(msg.attachments[0].type, "image");
  assert.equal(msg.attachments[0].downloadCode, "pic-1");
});

test("normalizeInbound throws without a sender staff id", () => {
  const a = makeAdapter();
  assert.throws(() => a.normalizeInbound({ conversationType: "1", msgtype: "text", text: { content: "x" } }), /staff/i);
});
