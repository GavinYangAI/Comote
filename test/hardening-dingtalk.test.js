// test/hardening-dingtalk.test.js
// Regression tests for the DingTalk channel hardening:
//   H1 — card actions authorize the real operator (staffId), deny otherwise
//   M1 — 'pick' runs under the operator staffId identity, not the conversationId
//   M5 — images use a separate ~1MB ceiling (files keep 10MB)
//   M6 — long markdown replies are chunked before sendMarkdown
//   LOW-dt-pick — dispatchPickAsync tail never throws an unhandled rejection
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { DingTalkRuntimeService } from "../src/channels/dingtalk/runtime.js";
import { createDingTalkRenderer, MAX_IMAGE_BYTES, MAX_FILE_BYTES } from "../src/channels/dingtalk/renderer.js";

// Minimal authorization store: authorizes exactly the staffIds it is seeded with.
function makeAuth(authorizedStaffIds = []) {
  const set = new Set(authorizedStaffIds);
  return {
    isAuthorized(identity) {
      return Boolean(identity?.channel === "dingtalk" && identity?.stableId && set.has(identity.stableId));
    },
  };
}

function makeRuntime({ authorizedStaffIds = [], routerOverrides = {} } = {}) {
  const resolved = [];
  const cancelled = [];
  const picks = [];
  const router = {
    authorization: makeAuth(authorizedStaffIds),
    async resolveApproval(code, decision) { resolved.push({ code, decision }); },
    async cancelThread(threadId) { cancelled.push(threadId); },
    async chooseProject(identity, selector) { picks.push({ identity, selector, kind: "project" }); return { kind: "text", text: "chosen" }; },
    async useSessionAsync(identity, selector) { picks.push({ identity, selector, kind: "session" }); return { kind: "text", text: "session" }; },
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
  return { runtime, resolved, cancelled, picks, enqueued, router };
}

// TOPIC_CARD callback: params are JSON-nested; the clicking operator's staffId is
// at the top level under `userId`.
function cardPayload({ params, userId, outTrackId = "ot-1" }) {
  return {
    outTrackId,
    ...(userId !== undefined ? { userId } : {}),
    content: JSON.stringify({ cardPrivateData: { params } }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// H1: authorization gating
// ---------------------------------------------------------------------------

test("H1: approve from an authorized operator resolves the approval", async () => {
  const { runtime, resolved } = makeRuntime({ authorizedStaffIds: ["boss"] });
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" }, userId: "boss" }));
  assert.deepEqual(resolved[0], { code: "a1", decision: "accept" });
  assert.ok(res.cardData?.cardParamMap, "returns an in-frame card update");
});

test("H1: approve from an UNauthorized operator is denied — no side effect", async () => {
  const { runtime, resolved } = makeRuntime({ authorizedStaffIds: ["boss"] });
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" }, userId: "stranger" }));
  assert.deepEqual(resolved, [], "approval was NOT resolved for an unauthorized clicker");
  assert.deepEqual(res, {}, "no card update leaks to an unauthorized clicker");
});

test("H1: reject from an unauthorized operator is denied", async () => {
  const { runtime, resolved } = makeRuntime({ authorizedStaffIds: ["boss"] });
  await runtime.handleCardAction(cardPayload({ params: { action: "reject", code: "a2" }, userId: "stranger" }));
  assert.deepEqual(resolved, []);
});

test("H1: cancel from an unauthorized operator does not cancel the thread", async () => {
  const { runtime, cancelled } = makeRuntime({ authorizedStaffIds: ["boss"] });
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "cancel", threadId: "t-7" }, userId: "stranger" }));
  assert.deepEqual(cancelled, []);
  assert.deepEqual(res, {});
});

test("H1: cancel from an authorized operator requests cancellation", async () => {
  const { runtime, cancelled } = makeRuntime({ authorizedStaffIds: ["boss"] });
  await runtime.handleCardAction(cardPayload({ params: { action: "cancel", threadId: "t-7" }, userId: "boss" }));
  assert.deepEqual(cancelled, ["t-7"]);
});

test("H1: a missing operator id is denied (cannot authorize anonymous clicks)", async () => {
  const { runtime, resolved } = makeRuntime({ authorizedStaffIds: ["boss"] });
  // No userId on the payload at all.
  const res = await runtime.handleCardAction(cardPayload({ params: { action: "approve", code: "a1" } }));
  assert.deepEqual(resolved, []);
  assert.deepEqual(res, {});
});

// ---------------------------------------------------------------------------
// M1: 'pick' authorizes + identifies by the operator staffId, not conv
// ---------------------------------------------------------------------------

test("M1: pick from an unauthorized operator does not dispatch", async () => {
  const { runtime, picks, enqueued } = makeRuntime({ authorizedStaffIds: ["boss"] });
  const res = await runtime.handleCardAction(
    cardPayload({ params: { action: "pick", pickKind: "project", index: "1", conv: "group-convo" }, userId: "stranger" }),
  );
  assert.deepEqual(res, {});
  await settle();
  assert.deepEqual(picks, [], "router was never asked to choose for an unauthorized clicker");
  assert.deepEqual(enqueued, []);
});

test("M1: pick uses the operator staffId as identity (not the conversationId)", async () => {
  const { runtime, picks, enqueued } = makeRuntime({ authorizedStaffIds: ["boss"] });
  const res = await runtime.handleCardAction(
    cardPayload({ params: { action: "pick", pickKind: "project", index: "2", conv: "group-convo" }, userId: "boss" }),
  );
  assert.deepEqual(res, {}, "acks immediately");
  await settle();
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0].identity, { channel: "dingtalk", stableId: "boss" }, "identity is the operator staffId, not the conv");
  assert.equal(picks[0].selector, "2");
  // Reply still goes back to the conversation the card lives in.
  assert.ok(enqueued.some((r) => r.conversationId === "group-convo"), "reply enqueued to the card's conversation");
});

// ---------------------------------------------------------------------------
// LOW-dt-pick: the fire-and-forget pick tail never throws an unhandled rejection
// ---------------------------------------------------------------------------

test("LOW-dt-pick: a throwing send in the success tail is caught, not unhandled", async () => {
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const errors = [];
    const { runtime } = makeRuntime({ authorizedStaffIds: ["boss"] });
    runtime.eventLog = { error: (msg, ctx) => errors.push({ msg, ctx }), warn() {}, info() {} };
    // sendReply throws synchronously in the success tail.
    runtime.adapter.sendReply = () => { throw new Error("boom"); };
    await runtime.handleCardAction(
      cardPayload({ params: { action: "pick", pickKind: "project", index: "1", conv: "c" }, userId: "boss" }),
    );
    await settle();
    assert.equal(unhandled, null, "no unhandled rejection escaped the fire-and-forget pick");
    assert.ok(errors.some((e) => /派发失败/.test(e.msg)), "the failure was logged");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// M5: per-kind media ceilings (image ~1MB, file 10MB)
// ---------------------------------------------------------------------------

test("M5: image and file ceilings differ (image 1MB < file 10MB)", () => {
  assert.equal(MAX_IMAGE_BYTES, 1 * 1024 * 1024);
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.ok(MAX_IMAGE_BYTES < MAX_FILE_BYTES);
});

test("M5: a 2MB image degrades to the tooLarge notice (over image ceiling, under file ceiling)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dt-img-"));
  const path = join(dir, "big.png");
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024)); // 2MB: > 1MB image, < 10MB file
  const sent = { text: [], image: 0, uploads: 0 };
  const driver = {
    async sendText(p) { sent.text.push(p.text); },
    async uploadMedia() { sent.uploads += 1; return "media-1"; },
    async sendImage() { sent.image += 1; },
    async sendFile() {},
  };
  const renderer = createDingTalkRenderer();
  await renderer.render({ kind: "media", mediaKind: "image", path, conversationId: "c" }, { driver });
  assert.equal(sent.image, 0, "image was NOT sent (would fail at the API)");
  assert.equal(sent.uploads, 0, "no upload attempted past the ceiling");
  assert.equal(sent.text.length, 1, "a tooLarge notice was sent instead");
});

test("M5: a 2MB FILE still sends (under the 10MB file ceiling)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dt-file-"));
  const path = join(dir, "data.bin");
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024));
  const sent = { files: 0, text: 0 };
  const driver = {
    async sendText() { sent.text += 1; },
    async uploadMedia() { return "media-1"; },
    async sendImage() {},
    async sendFile() { sent.files += 1; },
  };
  const renderer = createDingTalkRenderer();
  await renderer.render({ kind: "media", mediaKind: "file", path, conversationId: "c" }, { driver });
  assert.equal(sent.files, 1, "2MB file under the 10MB ceiling is delivered");
  assert.equal(sent.text, 0, "no tooLarge notice for an in-range file");
});

// ---------------------------------------------------------------------------
// M6: long markdown is chunked before sendMarkdown
// ---------------------------------------------------------------------------

test("M6: a short reply is sent as a single markdown message", async () => {
  const calls = [];
  const driver = { async sendMarkdown(p) { calls.push(p.text); } };
  const renderer = createDingTalkRenderer();
  await renderer.render({ kind: "text", text: "hello", conversationId: "c" }, { driver });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "hello");
});

test("M6: a very long reply is split into multiple markdown messages", async () => {
  const calls = [];
  const driver = { async sendMarkdown(p) { calls.push(p.text); } };
  const renderer = createDingTalkRenderer();
  const long = "x".repeat(1500 * 3 + 50); // > 3 chunks at 1500 each
  await renderer.render({ kind: "text", text: long, conversationId: "c" }, { driver });
  assert.ok(calls.length >= 4, `expected multiple chunks, got ${calls.length}`);
  assert.ok(calls[0].startsWith("(1/"), "chunks are numbered");
  // Each markdown payload stays bounded (chunk prefix + 1500 body).
  for (const text of calls) {
    assert.ok(text.length <= 1500 + 40, `chunk too large: ${text.length}`);
  }
});

test("M6: an empty reply sends nothing", async () => {
  const calls = [];
  const driver = { async sendMarkdown(p) { calls.push(p); } };
  const renderer = createDingTalkRenderer();
  await renderer.render({ kind: "text", text: "", conversationId: "c" }, { driver });
  assert.equal(calls.length, 0);
});
