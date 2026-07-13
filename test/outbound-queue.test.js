import test from "node:test";
import assert from "node:assert/strict";

import { OutboundQueue } from "../src/core/outbound-queue.js";

test("pendingActive surfaces a not-yet-due retry that list({pendingOnly}) hides", () => {
  // Regression: the push re-drain scheduler must see a backed-off retry even
  // before its window elapses, or the entry is stranded until the next inbound.
  const queue = new OutboundQueue();
  const entry = queue.enqueue({ channel: "feishu", conversationId: "c1", inReplyTo: "m1", text: "hi" });
  // Second failure → status "retrying" with nextAttemptAt ~1s in the future.
  queue.markFailed(entry.id, new Error("first"));
  queue.markFailed(entry.id, new Error("second"));

  // It is pending but NOT due, so the due-coupled list hides it...
  assert.equal(queue.list({ channel: "feishu", pendingOnly: true }).length, 0);
  // ...while pendingActive still reports it (with its future nextAttemptAt).
  const pending = queue.pendingActive({ channel: "feishu" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "retrying");
  assert.ok(Date.parse(pending[0].nextAttemptAt) > Date.now());
});

test("outbound queue deduplicates platform deliveries and tracks retry state", () => {
  const queue = new OutboundQueue();

  const first = queue.enqueue({
    channel: "wechat",
    conversationId: "dm_owner",
    inReplyTo: "msg_1",
    text: "hello",
  });
  const duplicate = queue.enqueue({
    channel: "wechat",
    conversationId: "dm_owner",
    inReplyTo: "msg_1",
    text: "hello",
  });
  const failed = queue.markFailed(first.id, new Error("network down"));

  assert.equal(duplicate.id, first.id);
  assert.equal(failed.status, "retrying");
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /network down/);
  assert.equal(queue.list({ channel: "wechat" }).length, 1);

  const delivered = queue.markDelivered(first.id);
  assert.equal(delivered.status, "delivered");
  assert.equal(queue.list({ channel: "wechat" }).length, 0);
});

test("outbound queue marks entries failed after the retry budget is exhausted", () => {
  const queue = new OutboundQueue({ maxAttempts: 2 });
  const entry = queue.enqueue({ channel: "wechat", conversationId: "dm_owner", text: "hello" });

  queue.markFailed(entry.id, new Error("first"));
  const failed = queue.markFailed(entry.id, new Error("second"));

  assert.equal(failed.status, "failed");
  assert.deepEqual(queue.list({ pendingOnly: false }).map((candidate) => candidate.status), ["failed"]);
  assert.deepEqual(queue.list(), []);
});

test("onTerminalFailure fires exactly once — when an entry lands terminal-failed (B-11)", () => {
  const failedEntries = [];
  const queue = new OutboundQueue({ maxAttempts: 3, onTerminalFailure: (e) => failedEntries.push(e) });
  const entry = queue.enqueue({ channel: "wechat", conversationId: "dm_owner", text: "hello" });

  queue.markFailed(entry.id, new Error("first"));
  queue.markFailed(entry.id, new Error("second"));
  assert.equal(failedEntries.length, 0, "retrying attempts do not fire the terminal callback");

  queue.markFailed(entry.id, new Error("third"));
  assert.equal(failedEntries.length, 1, "the exhausting attempt fires it once");
  assert.equal(failedEntries[0].id, entry.id);
  assert.equal(failedEntries[0].status, "failed");
  assert.equal(failedEntries[0].lastError, "third");
});

test("delivered entries never fire onTerminalFailure (B-11)", () => {
  const failedEntries = [];
  const queue = new OutboundQueue({ onTerminalFailure: (e) => failedEntries.push(e) });
  const entry = queue.enqueue({ channel: "wechat", conversationId: "dm_owner", text: "hello" });
  queue.markDelivered(entry.id);
  assert.equal(failedEntries.length, 0);
});

test("outbound queue prunes terminal entries above the cap while keeping active entries", () => {
  const cap = 10;
  const queue = new OutboundQueue({ maxAttempts: 1, maxTerminalEntries: cap });

  // Enqueue and deliver 15 messages — all should produce terminal entries.
  const deliveredIds = [];
  for (let i = 0; i < 15; i++) {
    const entry = queue.enqueue({
      channel: "wechat",
      conversationId: "dm_owner",
      inReplyTo: `msg_${i}`,
      text: `message ${i}`,
    });
    queue.markDelivered(entry.id);
    deliveredIds.push(entry.id);
  }

  // Snapshot must be bounded to the cap.
  const snap = queue.snapshot();
  assert.ok(
    snap.length <= cap,
    `expected snapshot length <= ${cap}, got ${snap.length}`,
  );
  // All remaining entries are terminal.
  assert.ok(
    snap.every((e) => e.status === "delivered" || e.status === "failed"),
    "non-terminal entries should not have been pruned",
  );

  // Active (pending) entries must never be pruned.
  const pending = queue.enqueue({
    channel: "wechat",
    conversationId: "dm_owner",
    inReplyTo: "msg_active",
    text: "still pending",
  });
  // Trigger another prune by delivering one more entry.
  const extra = queue.enqueue({
    channel: "wechat",
    conversationId: "dm_owner",
    inReplyTo: "msg_extra",
    text: "extra",
  });
  queue.markDelivered(extra.id);

  const snapWithPending = queue.snapshot();
  const pendingInSnap = snapWithPending.find((e) => e.id === pending.id);
  assert.ok(pendingInSnap, "active (queued) entry must survive pruning");
  assert.equal(pendingInSnap.status, "queued");
  assert.ok(
    snapWithPending.filter((e) => e.status === "delivered" || e.status === "failed").length <= cap,
    "terminal count must remain within cap after additional delivery",
  );
});

test("media replies dedupe on path, not just channel+conversation", () => {
  const queue = new OutboundQueue();
  const a = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "file", path: "/p/a.txt" });
  const b = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "file", path: "/p/b.txt" });
  assert.notEqual(a.id, b.id);
  const dup = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "media", mediaKind: "file", path: "/p/a.txt" });
  assert.equal(dup.id, a.id);
});

test("persistSnapshot keeps all active entries but caps terminal history", () => {
  const queue = new OutboundQueue();
  // 3 active (undelivered) entries that MUST survive a restart.
  const active = [];
  for (let i = 0; i < 3; i++) {
    active.push(queue.enqueue({ channel: "feishu", conversationId: `c${i}`, inReplyTo: `a${i}`, text: `active ${i}` }));
  }
  // 50 delivered (terminal) entries — historical, only the most recent few are worth persisting.
  for (let i = 0; i < 50; i++) {
    const e = queue.enqueue({ channel: "feishu", conversationId: `t${i}`, inReplyTo: `t${i}`, text: `done ${i}` });
    queue.markDelivered(e.id);
  }

  const snap = queue.persistSnapshot({ maxTerminal: 30 });
  const snapActive = snap.filter((e) => e.status === "queued" || e.status === "retrying");
  const snapTerminal = snap.filter((e) => e.status === "delivered" || e.status === "failed");

  assert.equal(snapActive.length, 3, "every active entry must be persisted");
  assert.equal(snapTerminal.length, 30, "terminal history is capped");
  // The retained terminal entries are the most recent ones.
  assert.equal(snapTerminal.at(-1).text, "done 49");
  assert.equal(snapTerminal[0].text, "done 20");
  // Order is preserved: actives precede the terminal tail as inserted.
  assert.deepEqual(snap.slice(0, 3).map((e) => e.text), ["active 0", "active 1", "active 2"]);
});

test("restored queue allocates ids after the highest existing outbound id", () => {
  const queue = new OutboundQueue({
    entries: [
      { id: "out_000278", channel: "feishu", conversationId: "c1", text: "old", status: "delivered", ackedAt: "2026-01-01T00:00:00.000Z" },
      { id: "out_000205", channel: "feishu", conversationId: "c1", text: "pending", status: "queued", ackedAt: null },
    ],
  });

  const next = queue.enqueue({ channel: "feishu", conversationId: "c1", text: "new" });

  assert.equal(next.id, "out_000279");
});

test("markDelivered prefers a pending duplicate id over a terminal historical entry", () => {
  const queue = new OutboundQueue({
    entries: [
      { id: "out_000205", channel: "feishu", conversationId: "c1", text: "old", status: "delivered", ackedAt: "2026-01-01T00:00:00.000Z" },
      { id: "out_000205", channel: "feishu", conversationId: "c1", text: "new", status: "queued", ackedAt: null },
    ],
  });

  queue.markDelivered("out_000205");

  const remaining = queue.list({ pendingOnly: false });
  assert.deepEqual(remaining.map((entry) => entry.status), ["delivered", "delivered"]);
});
