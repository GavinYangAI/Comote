import test from "node:test";
import assert from "node:assert/strict";
import { REPLY_KINDS, isReplyKind, routerReplyToSemantic } from "../src/channels/base/messages.js";

test("REPLY_KINDS lists the semantic kinds; isReplyKind validates", () => {
  for (const k of ["text", "status", "approval", "approvalResolved", "picker", "media"]) {
    assert.ok(REPLY_KINDS.includes(k));
  }
  assert.equal(isReplyKind("text"), true);
  assert.equal(isReplyKind("nope"), false);
});

test("routerReplyToSemantic maps a picker result to a picker reply", () => {
  const out = routerReplyToSemantic(
    { kind: "text", text: "pick one", picker: { pickKind: "project", items: [{ label: "p", index: 1 }] } },
    { channel: "feishu", conversationId: "c1" },
  );
  assert.equal(out.kind, "picker");
  assert.equal(out.pickKind, "project");
  assert.deepEqual(out.items, [{ label: "p", index: 1 }]);
  assert.equal(out.text, "pick one");
  assert.equal(out.conversationId, "c1");
  assert.equal(out.channel, "feishu");
});

test("routerReplyToSemantic maps a plain text result to a text reply", () => {
  const out = routerReplyToSemantic({ kind: "text", text: "hi" }, { channel: "wechat", conversationId: "c1", accountId: "a1" });
  assert.equal(out.kind, "text");
  assert.equal(out.text, "hi");
  assert.equal(out.accountId, "a1");
});

test("routerReplyToSemantic returns null when there is nothing to send", () => {
  assert.equal(routerReplyToSemantic({ kind: "ignored" }, { channel: "feishu", conversationId: "c1" }), null);
  assert.equal(routerReplyToSemantic(null, { channel: "feishu", conversationId: "c1" }), null);
});

test("routerReplyToSemantic keeps denied silent even when it carries text", () => {
  const target = { channel: "feishu", conversationId: "c1" };
  assert.equal(routerReplyToSemantic({ kind: "denied", text: "not authorized" }, target), null);
});

test("routerReplyToSemantic keeps ignored silent even when it carries text", () => {
  const target = { channel: "wechat", conversationId: "c1" };
  assert.equal(routerReplyToSemantic({ kind: "ignored", text: "ignored" }, target), null);
});

test("routerReplyToSemantic still sends first-contact notice text", () => {
  const target = { channel: "feishu", conversationId: "c1" };
  const out = routerReplyToSemantic({ kind: "notice", text: "welcome" }, target);
  assert.equal(out.kind, "text");
  assert.equal(out.text, "welcome");
});
