const TERMINAL_STATUSES = new Set(["delivered", "failed"]);
const MAX_TERMINAL_ENTRIES = 200;

export class OutboundQueue {
  constructor({ entries = [], maxAttempts = 3, maxTerminalEntries = MAX_TERMINAL_ENTRIES } = {}) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.nextId = this.entries.length + 1;
    this.maxAttempts = maxAttempts;
    this.maxTerminalEntries = maxTerminalEntries;
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
    return { ...entry };
  }

  list({ channel = null, pendingOnly = true } = {}) {
    return this.entries
      .filter(
        (entry) =>
          (!channel || entry.channel === channel) &&
          (!pendingOnly || isPending(entry)),
      )
      .map((entry) => ({ ...entry }));
  }

  ack(id) {
    return this.markDelivered(id);
  }

  markDelivered(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`unknown outbound reply: ${id}`);
    }
    entry.status = "delivered";
    entry.ackedAt = new Date().toISOString();
    this.prune();
    return { ...entry };
  }

  markFailed(id, error) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`unknown outbound reply: ${id}`);
    }
    entry.attempts += 1;
    entry.lastError = error?.message ?? String(error);
    entry.status = entry.attempts >= this.maxAttempts ? "failed" : "retrying";
    entry.nextAttemptAt = entry.status === "retrying" ? new Date().toISOString() : null;
    if (TERMINAL_STATUSES.has(entry.status)) {
      this.prune();
    }
    return { ...entry };
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
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

function makeDedupeKey(reply) {
  if (reply.kind === "image" || reply.kind === "file") {
    return [
      reply.channel,
      reply.accountId ?? "",
      reply.conversationId ?? "",
      reply.inReplyTo ?? "",
      reply.kind,
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
