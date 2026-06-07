import test from "node:test";
import assert from "node:assert/strict";
import {
  threadListSignature,
  threadRevision,
  newTranscriptMessages,
  transcriptRefreshLimit,
  advanceRefreshCursor,
  resolveRefreshTotal,
  shouldSkipPanelRefresh,
} from "../public/thread-view.js";

test("signature changes when a thread's updatedAt changes (same id set)", () => {
  const before = [{ id: "t1", updatedAt: "2024-01-01T00:00:00Z" }];
  const after = [{ id: "t1", updatedAt: "2024-01-01T00:05:00Z" }];
  assert.notEqual(
    threadListSignature(before, new Set()),
    threadListSignature(after, new Set()),
  );
});

test("signature changes when a thread's message count grows (same id set)", () => {
  const before = [{ id: "t1", messageCount: 3 }];
  const after = [{ id: "t1", messageCount: 4 }];
  assert.notEqual(
    threadListSignature(before, new Set()),
    threadListSignature(after, new Set()),
  );
});

test("signature changes when the latest preview/title text changes", () => {
  const before = [{ id: "t1", preview: "hello" }];
  const after = [{ id: "t1", preview: "hello there" }];
  assert.notEqual(
    threadListSignature(before, new Set()),
    threadListSignature(after, new Set()),
  );
});

test("signature is stable when nothing relevant changed", () => {
  const list = [{ id: "t1", updatedAt: "2024-01-01T00:00:00Z", title: "A" }];
  assert.equal(
    threadListSignature(list, new Set(["t1"])),
    threadListSignature(list, new Set(["t1"])),
  );
});

test("signature still changes when the id set changes", () => {
  const before = [{ id: "t1", updatedAt: "x" }];
  const after = [{ id: "t1", updatedAt: "x" }, { id: "t2", updatedAt: "y" }];
  assert.notEqual(
    threadListSignature(before, new Set()),
    threadListSignature(after, new Set()),
  );
});

test("signature still changes when the expansion set changes", () => {
  const list = [{ id: "t1", updatedAt: "x" }];
  assert.notEqual(
    threadListSignature(list, new Set()),
    threadListSignature(list, new Set(["t1"])),
  );
});

test("snake_case mutation indicators are honored too", () => {
  const before = [{ id: "t1", updated_at: "a", message_count: 1 }];
  const after = [{ id: "t1", updated_at: "b", message_count: 2 }];
  assert.notEqual(
    threadListSignature(before, new Set()),
    threadListSignature(after, new Set()),
  );
});

test("newTranscriptMessages returns only the new tail, oldest-first", () => {
  // Server now has 5 messages; panel last saw 3. Newest-first page from offset 0.
  const page = [
    { text: "m5" },
    { text: "m4" },
    { text: "m3" },
    { text: "m2" },
    { text: "m1" },
  ];
  assert.deepEqual(newTranscriptMessages(page, 3, 5), [{ text: "m4" }, { text: "m5" }]);
});

test("newTranscriptMessages returns nothing when total is unchanged", () => {
  const page = [{ text: "m3" }, { text: "m2" }, { text: "m1" }];
  assert.deepEqual(newTranscriptMessages(page, 3, 3), []);
});

test("newTranscriptMessages never re-appends when count goes backwards", () => {
  const page = [{ text: "m2" }, { text: "m1" }];
  assert.deepEqual(newTranscriptMessages(page, 4, 2), []);
});

test("transcriptRefreshLimit covers a >20 burst so no middle messages are skipped", () => {
  // Panel last saw 5; server now has 50 — a 45-message burst. The head-page
  // fetch must request at least 45 so newTranscriptMessages can slice all 45.
  assert.equal(transcriptRefreshLimit(5, 50), 45);
});

test("transcriptRefreshLimit floors at the default page size for small/no deltas", () => {
  assert.equal(transcriptRefreshLimit(5, 5), 20);
  assert.equal(transcriptRefreshLimit(5, 18), 20); // delta 13 < 20
  assert.equal(transcriptRefreshLimit(0, 0), 20);
});

test("transcriptRefreshLimit caps an absurd burst so we never fetch unbounded", () => {
  assert.equal(transcriptRefreshLimit(0, 100000), 500);
});

test("transcriptRefreshLimit ignores a backwards count (server trim)", () => {
  assert.equal(transcriptRefreshLimit(40, 10), 20);
});

test("newTranscriptMessages returns the whole burst when the page is large enough", () => {
  // 45-message burst, page fetched newest-first at the burst-covering limit.
  const page = [];
  for (let i = 50; i >= 1; i -= 1) {
    page.push({ text: `m${i}` });
  }
  const newest = newTranscriptMessages(page, 5, 50);
  assert.equal(newest.length, 45);
  assert.deepEqual(newest[0], { text: "m6" }); // oldest-first: first new is m6
  assert.deepEqual(newest[newest.length - 1], { text: "m50" });
});

test("advanceRefreshCursor advances offset and total by exactly what was appended", () => {
  // prevOffset 5, prevTotal 5, appended 45 → both advance by 45 in lockstep so a
  // later load-more (offset) and a later refresh (total=prevTotal) stay aligned.
  assert.deepEqual(advanceRefreshCursor(5, 5, 45), { offset: 50, total: 50 });
});

test("advanceRefreshCursor does NOT jump total to the server full count", () => {
  // The classic bug: appending only the head-page tail but setting total to the
  // server's full count strands the middle and makes the next delta read 0.
  // When only 20 of a 45 burst were appended, total must land at prevTotal+20,
  // not the server's 50 — so the next refresh's delta picks up the remaining 25.
  assert.deepEqual(advanceRefreshCursor(5, 5, 20), { offset: 25, total: 25 });
});

test("advanceRefreshCursor is a no-op when nothing was appended", () => {
  assert.deepEqual(advanceRefreshCursor(12, 30, 0), { offset: 12, total: 30 });
});

test("shouldSkipPanelRefresh skips a panel that is already fetching", () => {
  assert.equal(shouldSkipPanelRefresh({ dataset: { refreshing: "1" } }), true);
});

test("shouldSkipPanelRefresh allows an idle panel", () => {
  assert.equal(shouldSkipPanelRefresh({ dataset: {} }), false);
  assert.equal(shouldSkipPanelRefresh({ dataset: { refreshing: "" } }), false);
});

test("shouldSkipPanelRefresh treats a missing panel as skip", () => {
  assert.equal(shouldSkipPanelRefresh(null), true);
  assert.equal(shouldSkipPanelRefresh(undefined), true);
});

test("threadRevision prefers updatedAt, then count, then text", () => {
  assert.equal(threadRevision({ updatedAt: "u", messageCount: 2, preview: "p" }), "u");
  assert.equal(threadRevision({ messageCount: 2, preview: "p" }), "2");
  assert.equal(threadRevision({ preview: "p" }), "p");
  assert.equal(threadRevision({ title: "t" }), "t");
  assert.equal(threadRevision({}), "");
});

test("resolveRefreshTotal returns prevTotal+appended when the page carried the whole delta", () => {
  // delta 17, all 17 appended → next prevTotal is the real total, no overflow.
  assert.equal(resolveRefreshTotal(3, 20, 17), 20);
  assert.equal(resolveRefreshTotal(0, 0, 0), 0);
});

test("resolveRefreshTotal jumps to the server total when a burst overflowed the capped page", () => {
  // delta 1000 but only 500 carried (cap) → must report the real total, not 500,
  // so the next refresh sees delta 0 instead of re-fetching the same newest slice.
  assert.equal(resolveRefreshTotal(0, 1000, 500), 1000);
});

test("a >cap burst does not duplicate: the second tick appends nothing", () => {
  // Tick 1: prevTotal 0, server total 1000. The wide page is capped at 500, so it
  // carries only the newest 500 (m501..m1000). newTranscriptMessages slices them;
  // resolveRefreshTotal advances prevTotal to the real 1000 (not 500).
  const cap = transcriptRefreshLimit(0, 1000); // 500
  assert.equal(cap, 500);
  const pageTick1 = Array.from({ length: cap }, (_, i) => `m${1000 - i}`); // newest-first
  const appendedTick1 = newTranscriptMessages(pageTick1, 0, 1000);
  assert.equal(appendedTick1.length, 500, "tick 1 appends the newest 500");
  const prevTotalTick2 = resolveRefreshTotal(0, 1000, appendedTick1.length);
  assert.equal(prevTotalTick2, 1000, "prevTotal jumps to the real total, not 500");

  // Tick 2: no new server messages. delta = 1000 - 1000 = 0 → nothing re-appended.
  const pageTick2 = Array.from({ length: 20 }, (_, i) => `m${1000 - i}`);
  const appendedTick2 = newTranscriptMessages(pageTick2, prevTotalTick2, 1000);
  assert.equal(appendedTick2.length, 0, "tick 2 re-appends nothing — no duplicates");
});
