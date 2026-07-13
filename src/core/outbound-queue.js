const TERMINAL_STATUSES = new Set(["delivered", "failed"]);
const MAX_TERMINAL_ENTRIES = 200;
const MAX_ACTIVE_ENTRIES = 500;
// Exponential backoff between retries, capped so a stuck channel still retries
// periodically rather than effectively never.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class OutboundQueue {
  constructor({
    entries = [],
    maxAttempts = 3,
    maxTerminalEntries = MAX_TERMINAL_ENTRIES,
    maxActiveEntries = MAX_ACTIVE_ENTRIES,
    onShed = null,
    onTerminalFailure = null,
  } = {}) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.nextId = nextIdAfter(this.entries);
    this.maxAttempts = maxAttempts;
    this.maxTerminalEntries = maxTerminalEntries;
    this.maxActiveEntries = maxActiveEntries;
    // Optional sink for shed-entry notifications so callers can log/alert
    // instead of silently dropping undeliverable replies.
    this.onShed = onShed;
    // Optional sink invoked when an entry exhausts its retries and lands in the
    // "failed" terminal state. Lets the host surface the loss to the user (a
    // failed reply is otherwise only an event-log line). Called AFTER the entry
    // is finalized, with a copy of it.
    this.onTerminalFailure = onTerminalFailure;
  }

  enqueue(reply) {
    const dedupeKey = reply.dedupeKey ?? makeDedupeKey(reply);
    const existing = this.entries.find(
      (entry) => entry.dedupeKey === dedupeKey && entry.status !== "failed",
    );
    if (existing) {
      return { ...existing };
    }
    const entry = {
      id: reply.id ?? `out_${String(this.nextId++).padStart(6, "0")}`,
      ...reply,
      dedupeKey,
      createdAt: reply.createdAt ?? new Date().toISOString(),
      ackedAt: reply.ackedAt ?? null,
      status: reply.status ?? (reply.ackedAt ? "delivered" : "queued"),
      attempts: reply.attempts ?? 0,
      lastError: reply.lastError ?? null,
      nextAttemptAt: reply.nextAttemptAt ?? null,
    };
    this.entries.push(entry);
    this.shedActive();
    return { ...entry };
  }

  list({ channel = null, pendingOnly = true, now = Date.now() } = {}) {
    return this.entries
      .filter(
        (entry) =>
          (!channel || entry.channel === channel) &&
          (!pendingOnly || (isPending(entry) && isAttemptDue(entry, now))),
      )
      .map((entry) => ({ ...entry }));
  }

  // Pending entries (queued or retrying) for a channel REGARDLESS of whether
  // their backoff window has elapsed. `list({pendingOnly:true})` hides a not-
  // yet-due retry, but a re-drain scheduler must still see it to arm a timer for
  // when it becomes due — otherwise a backed-off retry is stranded.
  pendingActive({ channel = null } = {}) {
    return this.entries
      .filter((entry) => (!channel || entry.channel === channel) && isPending(entry))
      .map((entry) => ({ ...entry }));
  }

  /**
   * Cap the number of active (non-terminal) entries. When a channel cannot
   * drain, active entries would otherwise grow without bound and exhaust
   * memory / persistence. We drop the oldest active entries down to the cap and
   * surface each drop via `onShed` so the loss is never silent.
   */
  shedActive() {
    const active = [];
    const rest = [];
    for (const entry of this.entries) {
      (TERMINAL_STATUSES.has(entry.status) ? rest : active).push(entry);
    }
    if (active.length <= this.maxActiveEntries) {
      return;
    }
    const overflow = active.length - this.maxActiveEntries;
    // Entries are appended in order, so the head holds the oldest.
    const dropped = active.slice(0, overflow);
    const kept = active.slice(overflow);
    for (const entry of dropped) {
      this.onShed?.({ ...entry });
    }
    // Preserve original ordering of the survivors interleaved with terminals.
    const keptIds = new Set(kept.map((entry) => entry.id));
    this.entries = this.entries.filter(
      (entry) => TERMINAL_STATUSES.has(entry.status) || keptIds.has(entry.id),
    );
  }

  ack(id) {
    return this.markDelivered(id);
  }

  markDelivered(id) {
    const entry = findMutableEntry(this.entries, id);
    if (!entry) {
      throw new Error(`unknown outbound reply: ${id}`);
    }
    entry.status = "delivered";
    entry.ackedAt = new Date().toISOString();
    this.prune();
    return { ...entry };
  }

  markFailed(id, error) {
    const entry = findMutableEntry(this.entries, id);
    if (!entry) {
      throw new Error(`unknown outbound reply: ${id}`);
    }
    entry.attempts += 1;
    entry.lastError = error?.message ?? String(error);
    entry.status = entry.attempts >= this.maxAttempts ? "failed" : "retrying";
    entry.nextAttemptAt =
      entry.status === "retrying"
        ? new Date(Date.now() + backoffDelayMs(entry.attempts)).toISOString()
        : null;
    if (TERMINAL_STATUSES.has(entry.status)) {
      this.prune();
      // The entry just went terminal-failed (markFailed never produces
      // "delivered"): notify the host so the loss can be surfaced to the user.
      this.onTerminalFailure?.({ ...entry });
    }
    return { ...entry };
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Snapshot for on-disk persistence. Keeps EVERY active (queued/retrying) entry
   * — losing an undelivered reply across a restart would drop real work — but
   * only the most recent `maxTerminal` delivered/failed entries. Terminal
   * entries are historical (kept in memory up to maxTerminalEntries mainly for
   * dedup within a session); persisting all ~200 of them is what made state.json
   * 150KB and dominated the per-event rewrite cost. Order is preserved.
   */
  persistSnapshot({ maxTerminal = 30 } = {}) {
    const keptTerminalIds = new Set(
      this.entries
        .filter((entry) => TERMINAL_STATUSES.has(entry.status))
        .slice(-maxTerminal)
        .map((entry) => entry.id),
    );
    return this.entries
      .filter((entry) => !TERMINAL_STATUSES.has(entry.status) || keptTerminalIds.has(entry.id))
      .map((entry) => ({ ...entry }));
  }

  /**
   * Prune terminal (delivered/failed) entries down to `maxTerminalEntries`,
   * keeping the most recent ones. Active entries are never dropped.
   */
  prune() {
    const active = this.entries.filter((entry) => !TERMINAL_STATUSES.has(entry.status));
    const terminal = this.entries.filter((entry) => TERMINAL_STATUSES.has(entry.status));
    if (terminal.length > this.maxTerminalEntries) {
      // Keep the most recent N terminal entries (they're appended in order).
      this.entries = [...active, ...terminal.slice(-this.maxTerminalEntries)];
    }
  }
}

function isPending(entry) {
  return !entry.ackedAt && (entry.status === "queued" || entry.status === "retrying");
}

function findMutableEntry(entries, id) {
  return entries.find((candidate) => candidate.id === id && isPending(candidate))
    ?? entries.find((candidate) => candidate.id === id);
}

function nextIdAfter(entries) {
  let max = 0;
  for (const entry of entries) {
    const match = /^out_(\d+)$/.exec(String(entry.id ?? ""));
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

// A retrying entry is only due once its backoff window has elapsed. Queued
// entries (never attempted) and entries without a stamp are always due.
function isAttemptDue(entry, now) {
  if (!entry.nextAttemptAt) {
    return true;
  }
  const due = Date.parse(entry.nextAttemptAt);
  if (Number.isNaN(due)) {
    return true;
  }
  return due <= now;
}

// Backoff schedule (attempts is 1-based on the first failure):
//   attempt 1 -> 0ms      (retry immediately on the next drain pass)
//   attempt 2 -> BASE
//   attempt 3 -> 2*BASE
//   ...        exponential, capped at BACKOFF_MAX_MS.
// The immediate first retry preserves the long-standing "a transient failure is
// retried on the very next drain" behavior while still backing off a channel
// that keeps failing.
function backoffDelayMs(attempts) {
  if (attempts <= 1) {
    return 0;
  }
  const delay = BACKOFF_BASE_MS * 2 ** (attempts - 2);
  return Math.min(delay, BACKOFF_MAX_MS);
}

function makeDedupeKey(reply) {
  if (reply.kind === "media") {
    return [
      reply.channel,
      reply.accountId ?? "",
      reply.conversationId ?? "",
      reply.inReplyTo ?? "",
      "media",
      reply.path ?? "",
    ].join("|");
  }
  return [
    reply.channel,
    reply.accountId ?? "",
    reply.conversationId ?? "",
    reply.inReplyTo ?? "",
    reply.text ?? "",
  ].join("|");
}
