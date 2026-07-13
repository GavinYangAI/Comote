// B-2 / B-3 / B-8③ / B-11 — turn feedback & delivery-failure UX at the state level.
//
// B-2: dingtalk declares liveUpdates=1, but without a status template its
//      openThreadCard silently no-ops — the whole turn used to produce ZERO
//      feedback. Degraded live-card channels must fall back to the milestone
//      text flow (turn-start line + milestones + final text).
// B-3: connectionLost/GaveUp only pushed error cards to live-card channels;
//      card-less channels (wechat) with an active turn went silent forever.
// B-8③: telegram declares typing=1 — turnStarted must fire sendChatAction.
// B-11: a reply that exhausts its retries (terminal "failed") must enqueue a
//      short failure notice into the same conversation, and the notice itself
//      must never loop.
import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState } from "../src/server/state.js";
import { t } from "../src/core/i18n/index.js";

function buildState({ persisted = {}, milestoneOptions = {} } = {}) {
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const state = createComoteState({
    desktop,
    stateStore: null,
    persisted,
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
    milestoneOptions,
  });
  return { desktop, state };
}

function bindThread(state, threadId, channel, conversationId = "conv-1") {
  state.commandRouter.threadBindings.set(threadId, { channel, conversationId, projectPath: null });
}

function textsFor(state, channel) {
  return state.outboundReplies
    .list({ channel, pendingOnly: false })
    .filter((r) => r.kind === "text")
    .map((r) => ({ text: r.text, dedupeKey: r.dedupeKey }));
}

// A persisted dingtalk config WITH a status template (renderer templates come
// from channelConfigs at build time; no driver/network needed for gating).
const DINGTALK_WITH_TEMPLATE = {
  channelConfigs: {
    dingtalk: { enabled: true, appKey: "ak", appSecret: "as", statusTemplateId: "st.schema" },
  },
};

// ---------------------------------------------------------------- B-2

test("B-2: dingtalk without a status template gets a turn-start text", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  const texts = textsFor(state, "dingtalk");
  assert.equal(texts.length, 1, "one turn-start line for a degraded dingtalk");
  assert.equal(texts[0].text, t("card.phase.started"));
  assert.match(texts[0].dedupeKey, /^turnstart:t1:\d+$/);
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("B-2: dingtalk without a status template receives milestone texts", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm test", threadId: "t1" });
  const ms = textsFor(state, "dingtalk").filter((r) => r.dedupeKey.startsWith("ms:"));
  assert.equal(ms.length, 1, "milestone text delivered on a degraded live-card channel");
  assert.ok(ms[0].text.includes("npm test"));
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("B-2: dingtalk without a status template receives the final agent text", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", text: "the answer" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  const agent = textsFor(state, "dingtalk").filter((r) => r.dedupeKey.startsWith("agent:"));
  assert.equal(agent.length, 1, "final reply enqueued as text (no live card to claim)");
  assert.equal(agent[0].text, "the answer");
});

test("B-2: dingtalk WITH a status template keeps the live-card behavior (no turn-start/milestone texts)", () => {
  const { desktop, state } = buildState({ persisted: DINGTALK_WITH_TEMPLATE });
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm test", threadId: "t1" });
  assert.equal(
    textsFor(state, "dingtalk").length,
    0,
    "a template-configured dingtalk stays on the card path — no fallback texts",
  );
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("B-2: wechat (liveUpdates=0 by design) gets no turn-start line — not 'degraded'", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  assert.equal(textsFor(state, "wechat").length, 0, "wechat keeps its typing-only turn start");
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

// ---------------------------------------------------------------- B-3

test("B-3: connectionLost mid-turn enqueues a disconnect text on a card-less channel (wechat)", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "connectionLost" });
  const texts = textsFor(state, "wechat").filter((r) => r.dedupeKey.startsWith("disconnect:"));
  assert.equal(texts.length, 1, "one disconnect notice for the active wechat turn");
  assert.equal(texts[0].text, t("state.disconnect.reply"));
});

test("B-3: connectionGaveUp mid-turn also notifies a degraded dingtalk thread", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "connectionGaveUp" });
  const texts = textsFor(state, "dingtalk").filter((r) => r.dedupeKey.startsWith("disconnect:"));
  assert.equal(texts.length, 1, "one disconnect notice for the degraded dingtalk turn");
});

test("B-3: no disconnect text without an active turn, and none for live-card channels", () => {
  const { desktop, state } = buildState({ persisted: DINGTALK_WITH_TEMPLATE });
  bindThread(state, "t-idle", "wechat");
  bindThread(state, "t-live", "dingtalk");
  // t-idle never started a turn; t-live is an ACTIVE turn on a live-card channel.
  desktop.onEvent({ type: "turnStarted", threadId: "t-live" });
  desktop.onEvent({ type: "connectionLost" });
  assert.equal(
    textsFor(state, "wechat").filter((r) => r.dedupeKey.startsWith("disconnect:")).length,
    0,
    "idle threads are not notified",
  );
  assert.equal(
    textsFor(state, "dingtalk").filter((r) => r.dedupeKey.startsWith("disconnect:")).length,
    0,
    "live-card channels get the error card, not the text",
  );
});

test("B-3: a second connection drop does not duplicate the notice for the same turn", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "connectionLost" });
  desktop.onEvent({ type: "connectionGaveUp" }); // milestone state already torn down
  const texts = textsFor(state, "wechat").filter((r) => r.dedupeKey.startsWith("disconnect:"));
  assert.equal(texts.length, 1, "exactly one disconnect notice per active turn");
});

// ---------------------------------------------------------------- B-8③ typing

test("B-8: turnStarted on a telegram-bound thread fires the typing chat action", async () => {
  const { desktop, state } = buildState();
  const actions = [];
  state.runtime.telegram.__setTestDriver({
    startEventStream: async () => ({ ok: true }),
    stopEventStream() {},
    async sendChatAction(a) { actions.push(a); },
    async sendMessage() { return { message_id: 1 }; },
  });
  bindThread(state, "t1", "telegram", "chat-77");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  await waitFor(() => actions.length >= 1);
  assert.equal(actions[0].chatId, "chat-77");
  assert.equal(actions[0].action, "typing");
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

// ---------------------------------------------------------------- B-11

test("B-11: a terminally failed reply enqueues one short failure notice into the same conversation", () => {
  const { state } = buildState();
  const long = "A".repeat(200);
  const entry = state.outboundReplies.enqueue({
    channel: "wechat",
    conversationId: "dm-1",
    kind: "text",
    text: long,
    dedupeKey: "orig-1",
  });
  for (let i = 0; i < 3; i += 1) {
    state.outboundReplies.markFailed(entry.id, new Error("boom"));
  }
  const notices = textsFor(state, "wechat").filter((r) => r.dedupeKey === `deliveryfail:${entry.id}`);
  assert.equal(notices.length, 1, "one failure notice enqueued");
  assert.ok(notices[0].text.includes("A".repeat(80)), "notice carries the 80-char preview");
  assert.ok(!notices[0].text.includes("A".repeat(81)), "preview is truncated at 80 chars");
  // The notice itself is flagged so its own failure can never loop.
  const raw = state.outboundReplies
    .list({ channel: "wechat", pendingOnly: false })
    .find((r) => r.dedupeKey === `deliveryfail:${entry.id}`);
  assert.equal(raw.noFailureNotice, true);
});

test("B-11: a failed failure-notice only logs — no second-order notice (no loop)", () => {
  const { state } = buildState();
  const entry = state.outboundReplies.enqueue({
    channel: "wechat",
    conversationId: "dm-1",
    kind: "text",
    noFailureNotice: true,
    text: "the notice itself",
    dedupeKey: "notice-1",
  });
  for (let i = 0; i < 3; i += 1) {
    state.outboundReplies.markFailed(entry.id, new Error("boom"));
  }
  const followups = state.outboundReplies
    .list({ channel: "wechat", pendingOnly: false })
    .filter((r) => String(r.dedupeKey).startsWith("deliveryfail:"));
  assert.equal(followups.length, 0, "a noFailureNotice entry never spawns another notice");
});

test("B-11: a failed media reply's notice previews the file name", () => {
  const { state } = buildState();
  const entry = state.outboundReplies.enqueue({
    channel: "dingtalk",
    conversationId: "dm-2",
    kind: "media",
    mediaKind: "file",
    path: "/repo/out/report.pdf",
    fileName: "report.pdf",
    dedupeKey: "media-1",
  });
  for (let i = 0; i < 3; i += 1) {
    state.outboundReplies.markFailed(entry.id, new Error("upload failed"));
  }
  const notices = textsFor(state, "dingtalk").filter((r) => r.dedupeKey === `deliveryfail:${entry.id}`);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes("report.pdf"));
});

async function waitFor(predicate, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ---------------------------------------------------------------------------
// codex review round-2: shed-notice cascade (B-11). A full queue that sheds
// must NOT enqueue failure notices — each notice would evict the next real
// reply until nothing but notices remain.
// ---------------------------------------------------------------------------
import { OutboundQueue } from "../src/core/outbound-queue.js";

test("review-2: shedding a full queue never replaces real replies with failure notices", async () => {
  const shed = [];
  const queue = new OutboundQueue({ maxActiveEntries: 3, onShed: (e) => shed.push(e) });
  for (let i = 1; i <= 4; i += 1) {
    queue.enqueue({ channel: "wechat", conversationId: "c1", kind: "text", text: `msg ${i}` });
  }
  // Let any (buggy) deferred enqueues run.
  await new Promise((resolve) => setImmediate(resolve));
  const active = queue.list().filter((e) => e.status === "queued" || e.status === "retrying");
  assert.equal(shed.length, 1, "exactly one oldest entry shed");
  assert.equal(active.length, 3);
  for (const entry of active) {
    assert.match(entry.text, /^msg /, `real reply survived, got: ${entry.text}`);
  }
});

test("review-2: hasCapacity reflects active headroom", () => {
  const queue = new OutboundQueue({ maxActiveEntries: 2 });
  assert.equal(queue.hasCapacity(), true);
  queue.enqueue({ channel: "wechat", conversationId: "c1", kind: "text", text: "a" });
  queue.enqueue({ channel: "wechat", conversationId: "c1", kind: "text", text: "b" });
  assert.equal(queue.hasCapacity(), false);
});

test("review-3: shed cascade guard holds through the real createComoteState onShed", async () => {
  const { state } = buildState();
  // The daemon queue caps active entries at 500; the 501st enqueue sheds the
  // oldest. The original defect enqueued a failure notice from onShed, which
  // evicted the next real reply, cascading until only notices remained.
  for (let i = 1; i <= 501; i += 1) {
    state.outboundReplies.enqueue({
      channel: "wechat",
      conversationId: "conv-1",
      kind: "text",
      text: `msg ${i}`,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  const entries = state.outboundReplies.list({ channel: "wechat", pendingOnly: false });
  const notices = entries.filter((entry) => entry.noFailureNotice);
  assert.equal(notices.length, 0, "no failure notices enqueued by shedding");
  const active = entries.filter((entry) => entry.status === "queued");
  assert.equal(active.length, 500);
  for (const entry of active) {
    assert.match(entry.text, /^msg /, `real reply survived, got: ${entry.text}`);
  }
});
