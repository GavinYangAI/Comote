import { createHash } from "node:crypto";

export class WeChatRuntimeService {
  constructor({ adapter, outboundQueue, driver = null, pollIntervalMs = 2500, persist = null, cursor = null }) {
    if (!adapter) {
      throw new Error("adapter is required");
    }
    if (!outboundQueue) {
      throw new Error("outboundQueue is required");
    }
    this.adapter = adapter;
    this.outboundQueue = outboundQueue;
    this.driver = driver;
    this.pollIntervalMs = pollIntervalMs;
    this.persist = persist;
    // Restored from disk so a restart does not re-fetch already-seen messages.
    this.cursor = cursor;
    this.timer = null;
    this.lastError = null;
    this.startedAt = null;
    this.needsRelogin = false;
    // Concurrency guard + delivered-message dedup. The iLink getUpdates cursor
    // does not advance past a message until it is consumed, so the same
    // message is re-fetched on every poll — dedup by id makes routing idempotent.
    this.polling = false;
    // Track seen message ids: Set for O(1) membership checks + parallel array
    // recording insertion order for bounded eviction when the cap is exceeded.
    this.seenMessageIds = new Set();
    this.seenMessageOrder = [];
  }

  configureDriver(driver) {
    this.driver = driver;
    this.lastError = null;
    this.needsRelogin = false;
  }

  getStatus() {
    return {
      state: this.timer ? "running" : this.driver ? "configured" : "not_configured",
      cursor: this.cursor,
      pollIntervalMs: this.pollIntervalMs,
      lastError: this.lastError,
      needsRelogin: this.needsRelogin,
      startedAt: this.startedAt,
      driver: this.driver?.getStatus?.() ?? null,
    };
  }

  start() {
    if (!this.driver) {
      throw new Error("WeChat driver is not configured");
    }
    if (this.timer) {
      return this.getStatus();
    }
    this.startedAt = new Date().toISOString();
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.lastError = error.message;
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getStatus();
  }

  async pollOnce() {
    if (!this.driver) {
      throw new Error("WeChat driver is not configured");
    }
    // Routing a message to Codex can take longer than the poll interval;
    // without this guard overlapping polls re-process the same message.
    if (this.polling) {
      return { inbound: 0, outbound: 0, cursor: this.cursor, skipped: true };
    }
    this.polling = true;
    try {
      let updateResult;
      try {
        updateResult = await this.driver.getUpdates({ cursor: this.cursor });
      } catch (error) {
        // An expired bot token would otherwise fail silently forever — stop the
        // poll loop and flag that the user must rebind WeChat.
        if (isWeChatAuthError(error)) {
          this.needsRelogin = true;
          this.lastError = "微信登录已失效，请在设置里重新绑定微信。";
          this.stop();
        }
        throw error;
      }
      this.cursor = updateResult.nextCursor ?? this.cursor;
      let inbound = 0;
      for (const update of updateResult.updates ?? []) {
        const payload = this.driver.normalizeUpdate(update);
        if (this.#alreadyHandled(payload)) {
          continue;
        }
        await this.adapter.handleInbound(payload);
        inbound += 1;
      }

      let outbound = 0;
      for (const reply of this.outboundQueue.list({ channel: "wechat" })) {
        try {
          await this.driver.sendText({ ...reply, clientId: deliveryId(reply) });
          this.outboundQueue.markDelivered(reply.id);
          outbound += 1;
        } catch (error) {
          this.outboundQueue.markFailed(reply.id, error);
        }
      }
      await this.persist?.();
      this.lastError = null;
      return { inbound, outbound, cursor: this.cursor };
    } finally {
      this.polling = false;
    }
  }

  // True when this message id was already routed — skips re-delivered copies.
  #alreadyHandled(payload) {
    const id = payload?.message?.id;
    if (!id) {
      return false;
    }
    if (this.seenMessageIds.has(id)) {
      return true;
    }
    this.seenMessageIds.add(id);
    this.seenMessageOrder.push(id);
    // Evict the oldest id when the order tracking exceeds the cap.
    if (this.seenMessageOrder.length > 1000) {
      this.seenMessageIds.delete(this.seenMessageOrder.shift());
    }
    return false;
  }

  async startLogin() {
    if (!this.driver?.startLogin) {
      throw new Error("WeChat login is not configured");
    }
    return this.driver.startLogin();
  }

  async getLoginStatus({ loginId }) {
    if (!this.driver?.getLoginStatus) {
      throw new Error("WeChat login is not configured");
    }
    return this.driver.getLoginStatus({ loginId });
  }

  // Best-effort "Codex is typing" indicator while a turn is being processed.
  async sendTyping({ conversationId }) {
    if (!this.driver?.sendTyping || !conversationId) {
      return;
    }
    try {
      await this.driver.sendTyping({ conversationId });
    } catch {
      // A failed typing indicator must never disrupt the runtime.
    }
  }
}

function deliveryId(reply) {
  const source = reply.dedupeKey ?? reply.id;
  return `comote-${createHash("sha256").update(String(source)).digest("hex").slice(0, 32)}`;
}

function isWeChatAuthError(error) {
  const message = error?.message ?? String(error);
  return /\b40[13]\b/.test(message) || /unauthorized|invalid.?token|登录/i.test(message);
}
