import test from "node:test";
import assert from "node:assert/strict";

import { OutboundQueue } from "../src/core/outbound-queue.js";
import { DedupTracker } from "../src/channels/base/dedup.js";
import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";

// ---------------------------------------------------------------------------
// [LOW-backoff] outbound-queue honors nextAttemptAt with growing backoff
// ---------------------------------------------------------------------------

test("first retry is immediate, later retries are skipped until their backoff window elapses", () => {
  const q = new OutboundQueue({ maxAttempts: 5 });
  const entry = q.enqueue({ channel: "telegram", conversationId: "c1", text: "hi" });

  // First failure -> immediate retry preserved (drainable on the next pass).
  q.markFailed(entry.id, new Error("boom"));
  let failed = q.snapshot().find((e) => e.id === entry.id);
  assert.equal(failed.status, "retrying");
  assert.ok(failed.nextAttemptAt, "nextAttemptAt should be stamped on failure");
  assert.equal(q.list({ channel: "telegram" }).length, 1, "first retry is immediately due");

  // Second failure -> a real backoff window in the future.
  q.markFailed(entry.id, new Error("boom2"));
  failed = q.snapshot().find((e) => e.id === entry.id);
  const due = Date.parse(failed.nextAttemptAt);
  assert.equal(q.list({ channel: "telegram", now: due - 1 }).length, 0, "not yet due -> skipped");
  assert.equal(q.list({ channel: "telegram", now: due }).length, 1, "due -> drainable again");
});

test("backoff grows with each successive failure", () => {
  const q = new OutboundQueue({ maxAttempts: 10 });
  const entry = q.enqueue({ channel: "telegram", conversationId: "c1", text: "hi" });

  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    const before = Date.now();
    q.markFailed(entry.id, new Error("boom"));
    const e = q.snapshot().find((x) => x.id === entry.id);
    delays.push(Date.parse(e.nextAttemptAt) - before);
  }
  // First retry is immediate; subsequent retries grow monotonically.
  // delays[0] is measured against an external Date.now(), so allow a few ms of
  // jitter for a millisecond boundary crossed between the two clock reads
  // (asserting === 0 here is a real timing flake).
  assert.ok(delays[0] <= 50, "first retry effectively immediate");
  for (let i = 2; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `delay[${i}] >= delay[${i - 1}]`);
  }
  assert.ok(delays[2] > delays[1], "exponential growth after the immediate first retry");
});

// ---------------------------------------------------------------------------
// [LOW-unbounded] active entries are capped and shedding is observable
// ---------------------------------------------------------------------------

test("active entries are capped and oldest are shed with a notification", () => {
  const shed = [];
  const q = new OutboundQueue({ maxActiveEntries: 3, onShed: (e) => shed.push(e) });

  for (let i = 0; i < 5; i += 1) {
    q.enqueue({ channel: "telegram", conversationId: "c1", text: `m${i}` });
  }

  const active = q.snapshot().filter((e) => e.status === "queued");
  assert.equal(active.length, 3, "active entries capped to maxActiveEntries");
  assert.equal(shed.length, 2, "two oldest entries shed");
  // The shed entries are the oldest two (m0, m1); survivors are the newest three.
  assert.deepEqual(
    shed.map((e) => e.text),
    ["m0", "m1"],
  );
  assert.deepEqual(
    active.map((e) => e.text),
    ["m2", "m3", "m4"],
  );
});

test("shedding never drops terminal (delivered/failed) history", () => {
  const q = new OutboundQueue({ maxActiveEntries: 1 });
  const a = q.enqueue({ channel: "telegram", conversationId: "c1", text: "a" });
  q.markDelivered(a.id);
  // Now enqueue beyond the active cap; terminal 'a' must survive.
  q.enqueue({ channel: "telegram", conversationId: "c1", text: "b" });
  q.enqueue({ channel: "telegram", conversationId: "c1", text: "c" });
  const ids = q.snapshot().map((e) => e.text);
  assert.ok(ids.includes("a"), "delivered history retained across shedding");
});

// ---------------------------------------------------------------------------
// [LOW-quota] turn budget is only consumed once the turn actually starts
// ---------------------------------------------------------------------------

function makeAuthorizedRouter(opts = {}) {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wxid_owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);
  const router = new CommandRouter({ authorization, projects, sessions, ...opts });
  return { router, identity, sessions };
}

test("a turn that fails to start refunds the reserved hourly quota", async () => {
  // codexDesktop reports connected but startTurn throws -> the reserved quota
  // unit must be refunded so a failed hand-off does not burn the user's budget.
  const fakeDesktop = {
    getStatus: () => ({ state: "connected" }),
    startThread: async () => ({ thread: { id: "t1" } }),
    startTurn: async () => {
      throw new Error("desktop blew up");
    },
  };
  const { router, identity } = makeAuthorizedRouter({ codexDesktop: fakeDesktop, maxTurnsPerHour: 2 });
  router.currentProjectByIdentity.set(router.identityKey(identity), "/tmp/project");

  await assert.rejects(() => router.newSessionAsync(identity, "do a thing"), /desktop blew up/);

  const key = router.identityKey(identity);
  assert.equal(
    (router.turnTimestamps.get(key) ?? []).length,
    0,
    "failed start should be refunded",
  );
});

test("a turn that actually starts consumes exactly one quota unit", async () => {
  const started = [];
  const fakeCli = {
    runPrompt: async ({ text }) => {
      started.push(text);
      return { id: "run_1", output: "ok" };
    },
  };
  const { router, identity } = makeAuthorizedRouter({ codexCli: fakeCli, maxTurnsPerHour: 5 });
  // Set a current project directly so newSessionAsync reaches the CLI start.
  router.currentProjectByIdentity.set(router.identityKey(identity), "/tmp/project");

  await router.newSessionAsync(identity, "hello");

  const key = router.identityKey(identity);
  assert.equal((router.turnTimestamps.get(key) ?? []).length, 1, "exactly one turn recorded");
  assert.deepEqual(started, ["hello"]);
});

test("refundTurnStart drops exactly the reserved unit, freeing budget for a retry", () => {
  const { router, identity } = makeAuthorizedRouter({ maxTurnsPerHour: 1 });
  const reservation = router.enforceTurnRate(identity); // budget now full
  assert.throws(() => router.enforceTurnRate(identity), /.*/);
  router.refundTurnStart(identity, reservation); // free the failed reservation
  // The single slot is available again.
  assert.doesNotThrow(() => router.enforceTurnRate(identity));
});

// ---------------------------------------------------------------------------
// [LOW-deadswitch] sync handleMessage stays aligned with the async path
// (it is a LIVE production fallthrough for /help, /status and unknown /cmds).
// ---------------------------------------------------------------------------

test("async path routes /help and /status through the sync handleMessage fallthrough", async () => {
  const { router, identity } = makeAuthorizedRouter();

  const help = await router.dispatchAuthorizedMessage({ identity, text: "/help" });
  const helpDirect = router.handleMessage({ identity, text: "/help" });
  assert.equal(help.kind, "text");
  // The async path defers to the same sync handler, so output must match.
  assert.equal(help.text, helpDirect.text);

  const status = await router.dispatchAuthorizedMessage({ identity, text: "/status" });
  const statusDirect = router.handleMessage({ identity, text: "/status" });
  assert.equal(status.text, statusDirect.text);
});

// ---------------------------------------------------------------------------
// [LOW-dedup] LRU eviction must not resurrect a recently-seen id
// ---------------------------------------------------------------------------

test("a recently-seen id is not evicted/resurrected after maxSize distinct ids", () => {
  const d = new DedupTracker(3);
  assert.equal(d.add("keep"), true);
  assert.equal(d.add("a"), true);
  assert.equal(d.add("b"), true);

  // Re-seeing "keep" must refresh its recency so it survives further inserts.
  assert.equal(d.has("keep"), true);

  // Now push enough new ids to overflow; "keep" was just touched so it must
  // remain, while the genuinely-oldest untouched id is evicted instead.
  assert.equal(d.add("c"), true); // overflow -> evicts LRU (which is "a", not "keep")
  assert.equal(d.add("d"), true); // overflow -> evicts "b"

  assert.equal(d.has("keep"), true, "recently-touched id must not be resurrected");
  // A repeat of "keep" is correctly recognized as a duplicate (returns false).
  assert.equal(d.add("keep"), false);
});

test("add refreshes recency so frequent ids are never the eviction victim", () => {
  const d = new DedupTracker(2);
  d.add("x");
  d.add("y");
  // Re-add x (already seen) -> refreshes recency; y becomes LRU.
  assert.equal(d.add("x"), false);
  d.add("z"); // overflow -> evicts y (the true LRU), keeps x
  assert.equal(d.has("x"), true);
  assert.equal(d.has("y"), false);
});
