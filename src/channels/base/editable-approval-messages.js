// Tracks editable approval messages for a channel runtime. Message references
// are intentionally in-memory: platform message ids are short-lived delivery
// state, while unresolved approvals themselves remain owned by the connector.
export class EditableApprovalMessages {
  constructor({ update, maxEntries = 200 } = {}) {
    if (typeof update !== "function") {
      throw new Error("approval message update function is required");
    }
    this.update = update;
    this.maxEntries = maxEntries;
    this.messages = new Map();
    this.inFlight = new Map();
    this.resolved = new Set();
    this.resolvedOrder = [];
  }

  remember(code, message) {
    const key = approvalKey(code);
    if (!key || !message) return false;
    this.messages.delete(key);
    this.messages.set(key, message);
    trimMap(this.messages, this.maxEntries);
    return true;
  }

  async resolve({ code, decision, approval = null, fallback = null } = {}) {
    const key = approvalKey(code);
    if (!key) return false;
    if (this.resolved.has(key)) return true;
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const message = this.messages.get(key) ?? fallback;
    if (!message) return false;
    this.messages.delete(key);

    const task = (async () => {
      try {
        await this.update(message, {
          code: key,
          decision,
          approval: approval ?? message.approval ?? null,
        });
        this.markResolved(key);
        return true;
      } catch (error) {
        // Let the outbound queue retry the same original message after a
        // transient platform failure.
        if (!this.resolved.has(key) && !this.messages.has(key)) {
          this.messages.set(key, message);
          trimMap(this.messages, this.maxEntries);
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, task);
    return task;
  }

  markResolved(code) {
    const key = approvalKey(code);
    if (!key) return false;
    this.messages.delete(key);
    if (!this.resolved.has(key)) {
      this.resolved.add(key);
      this.resolvedOrder.push(key);
      while (this.resolvedOrder.length > this.maxEntries) {
        this.resolved.delete(this.resolvedOrder.shift());
      }
    }
    return true;
  }
}

function approvalKey(code) {
  if (code == null) return null;
  const value = String(code).trim();
  return value || null;
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}
