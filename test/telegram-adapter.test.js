// test/telegram-adapter.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramChannelAdapter } from "../src/channels/telegram/adapter.js";

function makeAdapter(overrides = {}) {
  const sent = [];
  const routed = [];
  const adapter = new TelegramChannelAdapter({
    commandRouter: { handleMessageAsync: async (m) => { routed.push(m); return { kind: "text", text: "ok" }; } },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    onDetectedIdentity: () => {},
    isAuthorized: () => false,
    getPairingState: () => ({ pairingCode: "AB23CD", linkedChatId: null }),
    onPaired: async () => {},
    ...overrides,
  });
  return { adapter, sent, routed };
}

function msg({ chatId = 9, fromId = 9, text = "hi", type = "private" } = {}) {
  return { message: { message_id: 1, chat: { id: chatId, type }, from: { id: fromId, first_name: "Ann", username: "ann" }, text } };
}

test("normalizeInbound maps chat/from/text", () => {
  const { adapter } = makeAdapter();
  const m = adapter.normalizeInbound(msg({ text: "hello" }));
  assert.equal(m.conversationId, "9");
  assert.equal(m.conversationType, "direct");
  assert.equal(m.identity.channel, "telegram");
  assert.equal(m.identity.stableId, "9");
  assert.equal(m.identity.displayName, "ann");
  assert.equal(m.text, "hello");
});

test("normalizeInbound reads photo (largest size) + document into attachments", () => {
  const { adapter } = makeAdapter();
  const photo = { message: { message_id: 2, chat: { id: 9, type: "private" }, from: { id: 9 },
    photo: [{ file_id: "s", width: 90 }, { file_id: "L", width: 1280 }], caption: "look" } };
  const m = adapter.normalizeInbound(photo);
  assert.equal(m.text, "look");
  assert.equal(m.attachments[0].type, "image");
  assert.equal(m.attachments[0].downloadCode, "L"); // largest
  const doc = { message: { message_id: 3, chat: { id: 9, type: "private" }, from: { id: 9 },
    document: { file_id: "D", file_name: "a.pdf" } } };
  const dm = adapter.normalizeInbound(doc);
  assert.equal(dm.attachments[0].type, "file");
  assert.equal(dm.attachments[0].downloadCode, "D");
  assert.equal(dm.attachments[0].fileName, "a.pdf");
});

test("unauthorized sender sending the pairing code → onPaired + success reply, NOT routed", async () => {
  const paired = [];
  const { adapter, sent, routed } = makeAdapter({
    onPaired: async (p) => { paired.push(p); },
    getPairingState: () => ({ pairingCode: "AB23CD", linkedChatId: null }),
  });
  await adapter.handleInbound(msg({ text: "AB23CD" }));
  assert.equal(paired.length, 1);
  assert.equal(paired[0].chatId, "9");
  assert.equal(routed.length, 0);
  assert.equal(sent.length, 1);
});

test("unauthorized sender NOT sending the code → prompt reply, NOT routed", async () => {
  const { adapter, sent, routed } = makeAdapter();
  await adapter.handleInbound(msg({ text: "random" }));
  assert.equal(routed.length, 0);
  assert.equal(sent.length, 1);
});

test("authorized sender is routed to the command router", async () => {
  const { adapter, routed } = makeAdapter({ isAuthorized: () => true });
  await adapter.handleInbound(msg({ text: "do thing" }));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].text, "do thing");
});

test("group message is ignored (allowGroups false)", async () => {
  const { adapter, routed, sent } = makeAdapter({ isAuthorized: () => true });
  const res = await adapter.handleInbound(msg({ type: "supergroup" }));
  assert.equal(res.kind, "ignored");
  assert.equal(routed.length, 0);
  assert.equal(sent.length, 0);
});

test("displayName falls back to the id when no username and no names", () => {
  const { adapter } = makeAdapter();
  const m = adapter.normalizeInbound({ message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: "x" } });
  assert.equal(m.identity.displayName, "7");
});
