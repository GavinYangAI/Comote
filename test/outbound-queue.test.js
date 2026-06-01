import test from "node:test";
import assert from "node:assert/strict";

import { OutboundQueue } from "../src/core/outbound-queue.js";

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
  const a = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "file", path: "/p/a.txt" });
  const b = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "file", path: "/p/b.txt" });
  assert.notEqual(a.id, b.id);
  const dup = queue.enqueue({ channel: "feishu", conversationId: "c1", kind: "file", path: "/p/a.txt" });
  assert.equal(dup.id, a.id);
});
