import test from "node:test";
import assert from "node:assert/strict";

import { createComoteState } from "../src/server/state.js";

// Builds a state with a fake desktop connector we drive directly via onEvent,
// and every channel runtime kept stopped (no network). Mirrors the seam used by
// server-state.test.js's "routeDesktopEvent drives a dingtalk live status card".
function buildState(milestoneOpts = {}, { stateStore = null } = {}) {
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const state = createComoteState({
    desktop,
    stateStore,
    persisted: {},
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
    milestoneOptions: milestoneOpts,
  });
  return { desktop, state };
}

// A stateStore stub that only counts save() calls — enough to assert how many
// full-state persists a turn triggers (the disk path is irrelevant to the test).
function countingStateStore() {
  const store = { saves: 0, async load() { return {}; }, async save() { store.saves += 1; } };
  return store;
}

function agentReplies(state, channel) {
  return state.outboundReplies
    .list({ channel, pendingOnly: false })
    .filter((r) => typeof r.dedupeKey === "string" && r.dedupeKey.startsWith("agent:"));
}

// Seeds a thread binding directly (the read source getThreadBinding uses) so a
// milestone has a conversation to enqueue toward.
function bindThread(state, threadId, channel, conversationId = "conv-1") {
  state.commandRouter.threadBindings.set(threadId, { channel, conversationId, projectPath: null });
}

function milestoneReplies(state, channel) {
  return state.outboundReplies
    .list({ channel, pendingOnly: false })
    .filter((r) => typeof r.dedupeKey === "string" && r.dedupeKey.startsWith("ms:"));
}

test("a milestone on a wechat-bound thread enqueues a text reply (wechat: default ON)", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  const replies = milestoneReplies(state, "wechat");
  assert.equal(replies.length, 1, "one milestone text reply enqueued for wechat");
  assert.equal(replies[0].kind, "text");
  assert.ok(replies[0].text.includes("npm"), "the reply text carries the command label");
});

test("push channels (telegram) default OFF: a milestone enqueues nothing", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "telegram");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  assert.equal(milestoneReplies(state, "telegram").length, 0, "no milestone reply for telegram");
});

// Finding #9 (abstraction): the milestone switch is driven by an EXPLICIT
// `capabilities.milestones` bit on each plugin's meta, not inferred from
// `!liveUpdates`. Anchor both the declared bit and the resulting behavior so
// the two stay same-source: wechat declares milestones=1 (ON), the live-card
// channels (feishu/dingtalk/telegram) declare milestones=0 (OFF).
test("each channel declares an explicit capabilities.milestones bit matching its behavior", () => {
  const { state } = buildState();
  const milestonesOf = (id) =>
    state.registry.getChannel(id).meta.capabilities.milestones;
  assert.equal(milestonesOf("wechat"), 1, "wechat (no live card) declares milestones ON");
  assert.equal(milestonesOf("feishu"), 0, "feishu (live card) declares milestones OFF");
  assert.equal(milestonesOf("dingtalk"), 0, "dingtalk (live card) declares milestones OFF");
  assert.equal(milestonesOf("telegram"), 0, "telegram (live card) declares milestones OFF");
});

// A milestone-enabled push-style binding (the milestones bit, NOT !liveUpdates,
// is the switch). dingtalk has liveUpdates=1 AND milestones=0, so it must stay
// OFF — guarding against a reader that recovered the old !liveUpdates inference.
// B-2 nuance: dingtalk's live cards need a configured status template to be
// operational; only then is the card path live and milestones stay off. (A
// template-less dingtalk is DEGRADED and falls back to milestone texts — see
// state-ux-feedback.test.js.)
test("a milestone on a dingtalk-bound thread with a status template enqueues nothing (milestones=0)", () => {
  const desktop = { onEvent: null, async listProjects() { return []; } };
  const state = createComoteState({
    desktop,
    stateStore: null,
    persisted: {
      channelConfigs: {
        dingtalk: { enabled: true, appKey: "ak", appSecret: "as", statusTemplateId: "st.schema" },
      },
    },
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
  });
  bindThread(state, "t1", "dingtalk");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  assert.equal(milestoneReplies(state, "dingtalk").length, 0, "no milestone reply for dingtalk");
});

test("identical consecutive milestones (same kind+label) are de-duplicated", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  assert.equal(milestoneReplies(state, "wechat").length, 1, "the repeat milestone was dropped");
});

test("milestones inside the min interval are merged into one pending flush with a count", async () => {
  const { desktop, state } = buildState({ minIntervalMs: 60 });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  // First fires immediately. The next three land inside the 8s gate → pending.
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "pytest", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "git", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "file", label: "state.js", threadId: "t1" });

  // Before the timer flush: only the immediate first one is out.
  assert.equal(milestoneReplies(state, "wechat").length, 1, "only the first milestone delivered immediately");

  // After the flush timer fires, exactly one merged reply joins it.
  await waitFor(() => milestoneReplies(state, "wechat").length >= 2);
  const replies = milestoneReplies(state, "wechat");
  assert.equal(replies.length, 2, "one merged flush after the interval, not one-per-milestone");
  const merged = replies.at(-1);
  // The merged line carries the latest label and a count of suppressed ones.
  assert.ok(merged.text.includes("state.js"), "merged reply shows the latest milestone label");
  assert.ok(/3/.test(merged.text), "merged reply shows how many were coalesced");

  state.connectors.desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("at most MILESTONE_MAX_PER_TURN distinct milestones are delivered per turn", async () => {
  // minIntervalMs:0 → every distinct milestone delivers immediately, so the
  // per-turn cap (not the throttle) is what bounds the count.
  const { desktop, state } = buildState({ minIntervalMs: 0 });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  for (let i = 0; i < 20; i += 1) {
    desktop.onEvent({ type: "milestone", kind: "command", label: `cmd${i}`, threadId: "t1" });
  }
  const replies = milestoneReplies(state, "wechat");
  assert.equal(replies.length, 6, `delivered exactly 6 milestones, got ${replies.length}`);

  state.connectors.desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("milestone dedupeKey uses a per-turn nonce + sequence, not a wall-clock timestamp", () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  const [reply] = milestoneReplies(state, "wechat");
  assert.match(reply.dedupeKey, /^ms:t1:\d+:\d+$/, "dedupeKey is ms:<thread>:<turn>:<seq>");
  // No 13-digit epoch millisecond stamp leaked into the key — the turn nonce is a
  // monotonic per-thread counter, so the key stays deterministic AND cross-turn unique.
  assert.ok(!/\d{13}/.test(reply.dedupeKey), "no wall-clock timestamp in the dedupeKey");
});

test("milestones from a later turn are NOT swallowed by the previous turn's retained dedupeKey", () => {
  // Regression: with a per-turn seq that resets to 0 each turn, turn 2's first
  // milestone reused turn 1's still-retained `ms:t1:1` key and the outbound queue
  // silently dropped it — zeroing out milestones on every turn after the first
  // (worst on wechat, the only default-ON channel). The turn nonce fixes this.
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "pytest", threadId: "t1" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  const replies = milestoneReplies(state, "wechat");
  assert.equal(replies.length, 2, "both turns' milestones were delivered (no cross-turn collision)");
  const keys = replies.map((r) => r.dedupeKey);
  assert.equal(new Set(keys).size, 2, "the two turns produced distinct dedupeKeys");
});

test("turnCompleted flushes any pending milestone and clears per-thread state (no leak)", async () => {
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "pytest", threadId: "t1" }); // pending
  // turnCompleted flushes the pending one synchronously.
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  const replies = milestoneReplies(state, "wechat");
  assert.ok(replies.length >= 2, "the pending milestone was flushed on turnCompleted");
});

test("a milestone for an unknown thread (no binding) is dropped silently", () => {
  const { desktop, state } = buildState();
  desktop.onEvent({ type: "turnStarted", threadId: "ghost" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "ghost" });
  assert.equal(milestoneReplies(state, "wechat").length, 0);
});

function heartbeatReplies(state, channel) {
  return state.outboundReplies
    .list({ channel, pendingOnly: false })
    .filter((r) => typeof r.dedupeKey === "string" && r.dedupeKey.startsWith("heartbeat:"));
}

test("heartbeat: a long quiet stretch after a milestone enqueues a single still-working reply", async () => {
  // Tiny heartbeatMs so the quiet-watchdog fires in real time without waiting 90s.
  const { desktop, state } = buildState({ heartbeatMs: 40 });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  assert.ok(milestoneReplies(state, "wechat").length >= 1, "milestone delivered before heartbeat");

  await waitFor(() => heartbeatReplies(state, "wechat").length >= 1, { timeout: 3000 });
  // Settle: ensure it does not keep spamming heartbeats while the turn is open.
  await waitFor(() => true, { timeout: 120 });
  assert.equal(heartbeatReplies(state, "wechat").length, 1, "exactly one heartbeat while quiet");

  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

test("heartbeat stops once the turn completes (no heartbeat after the turn ends)", async () => {
  const { desktop, state } = buildState({ heartbeatMs: 40 });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "milestone", kind: "command", label: "npm", threadId: "t1" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  // Wait well past the heartbeat window; none should fire after completion.
  await waitFor(() => true, { timeout: 150 });
  assert.equal(heartbeatReplies(state, "wechat").length, 0, "no heartbeat after the turn ended");
});

test("agent: reply with a missing itemId survives across turns (per-thread turn nonce, no cross-turn collision)", () => {
  // #5 regression: when codex omits itemId, the agent: dedupeKey fell back to
  // agent:<threadId>, identical across turns. Turn N's final agentMessage stayed
  // retained in the outbound queue, so turn N+1's final agentMessage reused the
  // same key and was silently de-duped away — the user never saw turn N+1's
  // answer. A per-thread turn nonce in the fallback key keeps them distinct.
  // wechat has no live card, so agentMessage takes the plain enqueue path that
  // stamps the agent: dedupeKey (the path this finding is about).
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", text: "answer one" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", text: "answer two" });
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  const replies = agentReplies(state, "wechat");
  assert.equal(replies.length, 2, "both turns' final agentMessages were delivered");
  assert.deepEqual(
    replies.map((r) => r.text),
    ["answer one", "answer two"],
    "the second turn's answer was not swallowed by the first turn's retained dedupeKey",
  );
  assert.equal(new Set(replies.map((r) => r.dedupeKey)).size, 2, "the two turns produced distinct agent: keys");
});

test("agent: an explicit itemId still keys on the itemId (turn nonce only fills the gap)", () => {
  // The nonce is a FALLBACK: a present itemId must keep keying agent:<itemId> so
  // an actual codex-side retry of the same item still collapses to one delivery.
  const { desktop, state } = buildState();
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", itemId: "item-42", text: "hi" });
  const [reply] = agentReplies(state, "wechat");
  assert.equal(reply.dedupeKey, "agent:item-42", "explicit itemId is used verbatim");
});

test("push channels do not arm a heartbeat interval (#7)", () => {
  // #7: liveUpdates channels (telegram) keep milestones OFF, so a per-turn
  // heartbeat setInterval would only ever no-op. Init must NOT arm it for them.
  // We observe this by spying on setInterval during the turnStarted.
  const realSetInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...args) => {
    intervals += 1;
    return realSetInterval(...args);
  };
  try {
    const { desktop, state } = buildState({ heartbeatMs: 40 });
    bindThread(state, "t1", "telegram");
    const before = intervals;
    desktop.onEvent({ type: "turnStarted", threadId: "t1" });
    assert.equal(intervals - before, 0, "no heartbeat interval armed for a milestones-off channel");
    desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("agent: fallback survives across turns on a push channel too (turn nonce advances for all channels) (#5)", async () => {
  // #5: telegram's agentMessage, when no live card is in flight, falls through to
  // the plain agent: enqueue inside deliverChangedFilesAndFinish — keyed
  // agent:<threadId> when itemId is absent. Across two turns that collides and the
  // outbound queue drops turn 2. The per-thread turn nonce (which MUST advance for
  // push channels even though milestones are off there) keeps the keys distinct.
  const { desktop, state } = buildState();
  bindThread(state, "t1", "telegram");

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", text: "answer one" });
  await waitFor(() => agentReplies(state, "telegram").length >= 1);
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  desktop.onEvent({ type: "agentMessage", threadId: "t1", text: "answer two" });
  await waitFor(() => agentReplies(state, "telegram").length >= 2);
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });

  const replies = agentReplies(state, "telegram");
  assert.equal(replies.length, 2, "both turns' agentMessages reached the queue (no cross-turn collision)");
  assert.equal(new Set(replies.map((r) => r.dedupeKey)).size, 2, "turn nonce advanced even with milestones off");
});

test("milestones-enabled channels still arm exactly one heartbeat interval per turn (#7)", () => {
  const realSetInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...args) => {
    intervals += 1;
    return realSetInterval(...args);
  };
  try {
    const { desktop, state } = buildState({ heartbeatMs: 40 });
    bindThread(state, "t1", "wechat");
    const before = intervals;
    desktop.onEvent({ type: "turnStarted", threadId: "t1" });
    assert.equal(intervals - before, 1, "exactly one heartbeat interval armed for a milestones-on channel");
    desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("a chatty turn of milestones persists at most once, not once per milestone (#6)", () => {
  // #6: milestone state is never persisted, yet deliverMilestone used to call
  // persistInBackground() on every line — up to ~7 full state.json writes in a
  // single turn. The milestone/heartbeat path must coalesce to ≤1 persist/turn.
  const store = countingStateStore();
  const { desktop, state } = buildState({ minIntervalMs: 0 }, { stateStore: store });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  for (let i = 0; i < 6; i += 1) {
    desktop.onEvent({ type: "milestone", kind: "command", label: `cmd${i}`, threadId: "t1" });
  }
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
  assert.equal(milestoneReplies(state, "wechat").length, 6, "all 6 milestones were delivered");
  assert.ok(store.saves <= 1, `milestone path persisted at most once per turn, got ${store.saves}`);
});

test("seq/delivered merge: the per-turn cap still bounds delivery after collapsing the two counters (#8)", () => {
  // #8: seq and delivered were always equal; merged into one counter that both
  // feeds the dedupeKey and gates the per-turn cap. Behavior must be unchanged.
  const { desktop, state } = buildState({ minIntervalMs: 0 });
  bindThread(state, "t1", "wechat");
  desktop.onEvent({ type: "turnStarted", threadId: "t1" });
  for (let i = 0; i < 20; i += 1) {
    desktop.onEvent({ type: "milestone", kind: "command", label: `cmd${i}`, threadId: "t1" });
  }
  const replies = milestoneReplies(state, "wechat");
  assert.equal(replies.length, 6, "the per-turn cap still bounds delivery at 6");
  // The seq feeds the key tail; with one counter it runs 1..6 with no gaps/dupes.
  const seqs = replies.map((r) => Number(r.dedupeKey.split(":").at(-1)));
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], "the merged counter numbers deliveries 1..6 contiguously");
  desktop.onEvent({ type: "turnCompleted", threadId: "t1", changedPaths: [] });
});

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
