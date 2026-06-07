// Pure helpers for the advanced "Codex 对话" thread panel. Kept DOM-free so the
// signature logic that drives the 5s repaint can be unit-tested in node.

// A short string that changes whenever a thread's content does. Codex Desktop's
// thread/list response is passed through verbatim, so we don't control which
// metadata field is present — prefer an explicit mutation timestamp, then a
// message count, then the latest preview/title text (both of which grow as the
// conversation does). Without this the repaint signature only tracked the id
// set, so new messages in an existing thread never triggered a repaint.
export function threadRevision(thread) {
  const t = thread ?? {};
  const updatedAt = t.updatedAt ?? t.updated_at ?? null;
  if (updatedAt != null) {
    return String(updatedAt);
  }
  const count = t.messageCount ?? t.message_count ?? null;
  if (count != null) {
    return String(count);
  }
  return String(t.preview ?? t.title ?? t.name ?? "");
}

// Given the message count a panel was last rendered at (prevTotal), the server's
// current total, and the newest-first page just fetched at offset 0, return the
// genuinely-new messages in oldest-first display order. Returns [] when nothing
// is new (or the count went backwards, e.g. server-side trimming), so the 5s
// refresh never re-appends — and thus never duplicates — already-shown history.
export function newTranscriptMessages(page, prevTotal, total) {
  const delta = Number(total ?? 0) - Number(prevTotal ?? 0);
  if (delta <= 0) {
    return [];
  }
  return (page ?? []).slice(0, delta).reverse();
}

// Default head-page size the 5s refresh fetches, and the hard cap we never go
// past so a runaway count can't trigger an unbounded fetch.
const DEFAULT_REFRESH_LIMIT = 20;
const MAX_REFRESH_LIMIT = 500;

// How many newest-first messages the refresh must fetch so a burst since the
// panel was last rendered (prevTotal) is fully covered. With the old fixed
// limit=20, a burst larger than 20 left the page too short for
// newTranscriptMessages to slice the whole delta — the middle messages were
// fetched by nobody and lost forever. Grow the page to the delta (floored at the
// default, capped so a bogus total can't ask for everything).
export function transcriptRefreshLimit(prevTotal, total, maxLimit = MAX_REFRESH_LIMIT) {
  const delta = Number(total ?? 0) - Number(prevTotal ?? 0);
  if (delta <= DEFAULT_REFRESH_LIMIT) {
    return DEFAULT_REFRESH_LIMIT;
  }
  return Math.min(delta, maxLimit);
}

// Advance the panel's pagination cursor after the refresh appended exactly
// appendedCount newest messages. offset (used by "load more" to page older) and
// total (used as the next refresh's prevTotal) must move by the *appended*
// amount in lockstep — never jump total to the server's full count, or any tail
// the head page didn't carry would be stranded and the next delta would read 0.
export function advanceRefreshCursor(prevOffset, prevTotal, appendedCount) {
  const appended = Number(appendedCount ?? 0);
  return {
    offset: Number(prevOffset ?? 0) + appended,
    total: Number(prevTotal ?? 0) + appended,
  };
}

// The panel's next prevTotal after a refresh appended `appended` newest-first
// messages. Normally `appended === delta` (the page carried the whole burst) and
// the answer is prevTotal+appended, which equals total. But when a burst OVERFLOWS
// even the capped wide page (appended < delta), we've only caught up to the newest
// `appended`; the un-carried middle is older history reachable via "load more".
// Jump total to the real server count so the next refresh sees delta 0 — otherwise
// it re-fetches the same newest slice and appends it AGAIN, duplicating messages.
export function resolveRefreshTotal(prevTotal, total, appended) {
  const prev = Number(prevTotal ?? 0);
  const srvTotal = Number(total ?? 0);
  const a = Number(appended ?? 0);
  return a < srvTotal - prev ? srvTotal : prev + a;
}

// Whether the 5s refresh should leave this panel alone: a missing panel, or one
// whose fetch (refresh or "load more") is still in flight. The in-flight flag is
// a per-panel mutex so a slow tick (or a tick landing on a load-more in progress)
// can't read-modify-write the same offset/total/DOM concurrently and duplicate,
// reorder, or desync messages.
export function shouldSkipPanelRefresh(panel) {
  if (!panel) {
    return true;
  }
  return (panel.dataset?.refreshing ?? "") === "1";
}

// Signature of the painted list: the ordered ids paired with each thread's
// revision, plus the expansion set. Any of these changing means the rendered
// list is stale and must be repainted.
export function threadListSignature(threadList, expandedIds) {
  return JSON.stringify({
    threads: threadList.map((thread) => [
      String(thread.id ?? ""),
      threadRevision(thread),
    ]),
    expanded: [...expandedIds].sort(),
  });
}
