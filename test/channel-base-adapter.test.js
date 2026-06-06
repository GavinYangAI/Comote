import test from "node:test";
import assert from "node:assert/strict";
import { BaseChannelAdapter } from "../src/channels/base/adapter.js";

class StubAdapter extends BaseChannelAdapter {
  normalizeInbound(payload) {
    return {
      messageId: payload.id,
      conversationId: payload.chat,
      conversationType: payload.group ? "group" : "direct",
      identity: { channel: "test", stableId: payload.user, displayName: payload.user },
      text: payload.text ?? "",
      attachments: payload.attachments ?? [],
    };
  }
}

function make(overrides = {}) {
  const enqueued = [];
  const detected = [];
  const adapter = new StubAdapter({
    channelId: "test",
    commandRouter: { handleMessageAsync: async (m) => ({ kind: "text", text: `echo:${m.text}` }) },
    sendReply: async (r) => { enqueued.push(r); return { ok: true }; },
    onDetectedIdentity: (i) => detected.push(i),
    allowGroups: false,
    ...overrides,
  });
  return { adapter, enqueued, detected };
}

test("routes a direct message and enqueues a semantic text reply", async () => {
  const { adapter, enqueued, detected } = make();
  await adapter.handleInbound({ id: "m1", chat: "c1", user: "u1", text: "hi" });
  assert.equal(detected.length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, "text");
  assert.equal(enqueued[0].text, "echo:hi");
  assert.equal(enqueued[0].conversationId, "c1");
});

test("ignores group messages when allowGroups is false", async () => {
  const { adapter, enqueued } = make();
  const out = await adapter.handleInbound({ id: "m2", chat: "g1", user: "u1", text: "hi", group: true });
  assert.equal(out.kind, "ignored");
  assert.equal(enqueued.length, 0);
});

test("prefixes downloaded attachment paths into the prompt", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m3", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "a.png" }] });
  assert.match(calls[0], /\[attachment: \.comote\/uploads\/a\.png\]/);
  assert.match(calls[0], /see/);
});

test("noProjectMessage override is used for the attachment NO_PROJECT reply", async () => {
  const sent = [];
  class A extends BaseChannelAdapter {
    normalizeInbound() {
      return { messageId: "m", conversationId: "c", conversationType: "direct",
        identity: { channel: "x", stableId: "s" }, text: "", attachments: [{ id: 1 }] };
    }
  }
  const adapter = new A({
    channelId: "x",
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "" }) },
    sendReply: async (r) => sent.push(r),
    downloadAttachment: async () => { throw new Error("NO_PROJECT"); },
    noProjectMessage: () => "CUSTOM_NO_PROJECT",
  });
  await adapter.handleInbound({});
  assert.equal(sent[0].text, "CUSTOM_NO_PROJECT");
});

test("non-image attachment becomes a read instruction in the prompt", async () => {
  const calls = [];
  const { adapter } = make({
    commandRouter: { handleMessageAsync: async (m) => { calls.push(m.text); return { kind: "text", text: "ok" }; } },
    downloadAttachment: async ({ attachment }) => ({ relativePath: `.comote/uploads/${attachment.fileName}` }),
  });
  await adapter.handleInbound({ id: "m4", chat: "c1", user: "u1", text: "see", attachments: [{ fileName: "report.pdf" }] });
  // A non-image file is no longer a bare `[attachment: …]` reference…
  assert.doesNotMatch(calls[0], /\[attachment: \.comote\/uploads\/report\.pdf\]/);
  // …it names the in-project path inside a read instruction, and keeps the user's text.
  assert.match(calls[0], /\.comote\/uploads\/report\.pdf/);
  assert.match(calls[0], /see/);
});
