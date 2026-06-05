// test/hardening-telegram.test.js
// Regression coverage for the Telegram channel hardening pass:
//   H1  callback authorization (gate the real clicker before any side effect)
//   M1  'pick' routes under the clicker's identity, not the chat id
//   H4  long replies survive: status body clamps + over-long edit falls back to sends
//   M2  pairing code is 8 chars from a CSPRNG (injectable index seam)
//   LOW constant-time pairing compare + rate-limited pairing-prompt disclosure
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramRuntimeService } from "../src/channels/telegram/runtime.js";
import { TelegramChannelAdapter } from "../src/channels/telegram/adapter.js";
import { createTelegramRenderer } from "../src/channels/telegram/renderer.js";
import { generatePairingCode, statusText, chunkMessage, clampStatusBody, TELEGRAM_MESSAGE_LIMIT } from "../src/channels/telegram/cards.js";

// --- runtime test harness -------------------------------------------------

function makeRuntime({ authorized = new Set(["9"]), routerOverrides = {}, ...overrides } = {}) {
  const calls = { resolve: [], cancel: [], answer: [], pick: [], enqueue: [], sent: [] };
  const router = {
    authorization: { isAuthorized: (id) => authorized.has(id?.stableId) },
    resolveApproval: async (code, decision) => { calls.resolve.push([code, decision]); },
    cancelThread: async (tid) => { calls.cancel.push(tid); },
    chooseProject: async () => "chosen project",
    useSessionAsync: async () => "chosen session",
    getThreadBinding: () => null,
    ...routerOverrides,
  };
  const driver = {
    async answerCallbackQuery(a) { calls.answer.push(a); },
    async editMessageText() {},
    async sendMessage(m) { calls.sent.push(m); return { message_id: 1 }; },
  };
  const adapter = { commandRouter: router, sendReply: async (r) => { calls.sent.push(r); return { ok: true }; } };
  const rt = new TelegramRuntimeService({
    adapter,
    outboundQueue: { enqueue: (m) => calls.enqueue.push(m), list: () => [], markDelivered() {}, markFailed() {} },
    renderer: createTelegramRenderer(),
    driver,
    ensurePairingCode: async () => {},
    eventLog: { warn() {}, error() {}, info() {} },
    ...overrides,
  });
  return { rt, calls, router, driver };
}

const cq = ({ data, fromId = 9, chatId = 9, message = { chat: { id: chatId }, message_id: 5 } }) =>
  ({ id: "cq", data, message, from: { id: fromId } });

// --- H1 authorization -----------------------------------------------------

test("H1: unauthorized clicker is dropped before any side effect (approve)", async () => {
  const { rt, calls } = makeRuntime({ authorized: new Set(["9"]) });
  await rt.handleCallbackQuery(cq({ data: "ap:A1", fromId: 999 }));
  assert.equal(calls.resolve.length, 0, "approval must not resolve for an unauthorized clicker");
  assert.equal(calls.answer.length, 1, "the callback query is still answered (no spinner)");
});

test("H1: unauthorized clicker cannot cancel a thread", async () => {
  const { rt, calls } = makeRuntime({ authorized: new Set(["9"]) });
  await rt.handleCallbackQuery(cq({ data: "ck:t-7", fromId: 4242 }));
  assert.equal(calls.cancel.length, 0);
});

test("H1: authorized clicker still works (approve resolves)", async () => {
  const { rt, calls } = makeRuntime({ authorized: new Set(["9"]) });
  await rt.handleCallbackQuery(cq({ data: "ap:A1", fromId: 9 }));
  assert.deepEqual(calls.resolve[0], ["A1", "accept"]);
});

test("H1: a session owner mismatch blocks an otherwise-authorized clicker", async () => {
  // Both ids authorized, but the card session is owned by 9, so 10 cannot cancel it.
  const { rt, calls } = makeRuntime({
    authorized: new Set(["9", "10"]),
    routerOverrides: { getThreadBinding: (tid) => (tid === "t-7" ? { accountId: "9", conversationId: "9" } : null) },
  });
  await rt.openThreadCard({ threadId: "t-7", conversationId: "9", card: { text: "x", replyMarkup: null } });
  await rt.handleCallbackQuery(cq({ data: "ck:t-7", fromId: 10 }));
  assert.equal(calls.cancel.length, 0, "a non-owner cannot drive another operator's card");
  await rt.handleCallbackQuery(cq({ data: "ck:t-7", fromId: 9 }));
  assert.deepEqual(calls.cancel, ["t-7"], "the owner can cancel");
});

// --- M1 pick uses the sender identity -------------------------------------

test("M1: pick routes under the clicker's id (from.id), not the chat id", async () => {
  const seen = [];
  const { rt } = makeRuntime({
    authorized: new Set(["77"]),
    routerOverrides: { chooseProject: async (identity, sel) => { seen.push([identity.stableId, sel]); return "ok"; } },
  });
  // chat id 500, sender id 77 (the authorized operator messaging from a group/forward).
  await rt.handleCallbackQuery(cq({ data: "pk:p:2", fromId: 77, chatId: 500 }));
  // dispatchPickAsync is fire-and-forget; let the microtask drain.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen[0], ["77", "2"], "the pick must use the sender's id, not the chat id");
});

test("M1: unauthorized pick is dropped", async () => {
  const seen = [];
  const { rt } = makeRuntime({
    authorized: new Set(["9"]),
    routerOverrides: { chooseProject: async (identity) => { seen.push(identity.stableId); return "ok"; } },
  });
  await rt.handleCallbackQuery(cq({ data: "pk:p:2", fromId: 31337 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 0);
});

// --- H4 long replies ------------------------------------------------------

test("H4: statusText clamps an over-long body under the Telegram ceiling", () => {
  const body = "x".repeat(20000);
  const text = statusText({ phase: "progress", steps: 3, text: body });
  assert.ok(text.length <= TELEGRAM_MESSAGE_LIMIT, `status card body ${text.length} must be <= 4096`);
});

test("H4: clampStatusBody keeps the tail and marks elision", () => {
  const out = clampStatusBody("HEAD" + "y".repeat(5000) + "TAIL", 1000);
  assert.ok(out.length <= 1000);
  assert.ok(out.endsWith("TAIL"), "the latest output (tail) is preserved");
  assert.ok(!out.startsWith("HEAD"), "the head is elided");
});

test("H4: chunkMessage splits long text into <=limit pieces", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ` + "z".repeat(200)).join("\n");
  const chunks = chunkMessage(text, 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000);
  assert.equal(chunks.join("\n"), text, "chunking is lossless across line boundaries");
});

test("H4: a single over-long line is hard-split", () => {
  const chunks = chunkMessage("q".repeat(5000), 1000);
  assert.equal(chunks.length, 5);
  for (const c of chunks) assert.ok(c.length <= 1000);
});

test("H4: an over-long editMessageText falls back to chunked fresh sends (answer not lost)", async () => {
  const sent = [];
  let editCalls = 0;
  const { rt } = makeRuntime();
  rt.driver.editMessageText = async () => { editCalls += 1; throw new Error("Bad Request: message is too long"); };
  rt.driver.sendMessage = async (m) => { sent.push(m); return { message_id: 1 }; };
  const longText = "a".repeat(9000);
  const ok = await rt._edit({ conversationId: "9", messageId: 5 }, { text: longText, replyMarkup: null });
  assert.equal(ok, true, "the edit recovers via sends");
  assert.equal(editCalls, 1);
  assert.ok(sent.length >= 2, "the long reply is delivered as multiple fresh messages");
  for (const m of sent) assert.ok(m.text.length <= TELEGRAM_MESSAGE_LIMIT);
});

test("H4: 'not modified' edit error stays benign (no fallback sends)", async () => {
  const sent = [];
  const { rt } = makeRuntime();
  rt.driver.editMessageText = async () => { throw new Error("Bad Request: message is not modified"); };
  rt.driver.sendMessage = async (m) => { sent.push(m); return { message_id: 1 }; };
  const ok = await rt._edit({ conversationId: "9", messageId: 5 }, { text: "x", replyMarkup: null });
  assert.equal(ok, true);
  assert.equal(sent.length, 0);
});

// --- M2 CSPRNG pairing code ----------------------------------------------

test("M2: generatePairingCode is 8 chars from the safe alphabet by default", () => {
  const code = generatePairingCode();
  assert.equal(code.length, 8);
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
});

test("M2: the index seam stays injectable for deterministic tests", () => {
  const code = generatePairingCode(() => 0); // always picks alphabet[0] === '2'
  assert.equal(code, "22222222");
});

test("M2: default codes vary (CSPRNG, not a constant)", () => {
  const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode()));
  assert.ok(codes.size > 1, "a CSPRNG must not emit identical codes every call");
});

// --- LOW constant-time compare + disclosure rate limit --------------------

function makeAdapter(overrides = {}) {
  const sent = [];
  const paired = [];
  const adapter = new TelegramChannelAdapter({
    commandRouter: { handleMessageAsync: async () => ({ kind: "text", text: "ok" }) },
    sendReply: async (r) => { sent.push(r); return { ok: true }; },
    onDetectedIdentity: () => {},
    isAuthorized: () => false,
    getPairingState: () => ({ pairingCode: "AB23CDEF", linkedChatId: null }),
    onPaired: async (p) => { paired.push(p); },
    ...overrides,
  });
  return { adapter, sent, paired };
}

const inbound = ({ text, fromId = 9 }) =>
  ({ message: { message_id: 1, chat: { id: fromId, type: "private" }, from: { id: fromId, first_name: "Ann", username: "ann" }, text } });

test("LOW-compare: the exact pairing code still pairs (constant-time path is correct)", async () => {
  const { adapter, paired } = makeAdapter();
  const res = await adapter.handleInbound(inbound({ text: "AB23CDEF" }));
  assert.equal(res.kind, "paired");
  assert.equal(paired.length, 1);
});

test("LOW-compare: a wrong code of equal length does not pair", async () => {
  const { adapter, paired } = makeAdapter();
  const res = await adapter.handleInbound(inbound({ text: "AB23CDEX" }));
  assert.equal(res.kind, "ignored");
  assert.equal(paired.length, 0);
});

test("LOW-compare: a wrong code of different length does not pair or throw", async () => {
  const { adapter, paired } = makeAdapter();
  const res = await adapter.handleInbound(inbound({ text: "SHORT" }));
  assert.equal(res.kind, "ignored");
  assert.equal(paired.length, 0);
});

test("LOW-disclose: pairing prompts are rate-limited per sender (code stops being echoed)", async () => {
  const { adapter, sent } = makeAdapter();
  for (let i = 0; i < 6; i += 1) await adapter.handleInbound(inbound({ text: "nope", fromId: 9 }));
  const prompts = sent.filter((s) => typeof s.text === "string" && s.text.includes("AB23CDEF"));
  assert.equal(prompts.length, 3, "at most 3 prompts disclose the code; further messages drop silently");
});

test("LOW-disclose: the rate limit is per-sender, not global", async () => {
  const { adapter, sent } = makeAdapter();
  for (let i = 0; i < 5; i += 1) await adapter.handleInbound(inbound({ text: "nope", fromId: 9 }));
  for (let i = 0; i < 5; i += 1) await adapter.handleInbound(inbound({ text: "nope", fromId: 10 }));
  const prompts = sent.filter((s) => typeof s.text === "string" && s.text.includes("AB23CDEF"));
  assert.equal(prompts.length, 6, "each distinct sender gets its own 3-prompt budget");
});

test("LOW-disclose: a successful pair resets the sender's prompt budget", async () => {
  const { adapter, sent } = makeAdapter();
  await adapter.handleInbound(inbound({ text: "nope", fromId: 9 }));
  await adapter.handleInbound(inbound({ text: "AB23CDEF", fromId: 9 }));
  // After unlink scenarios a re-prompt should be possible again; budget cleared.
  assert.equal(adapter._pairingPromptCounts.has("9"), false);
});
