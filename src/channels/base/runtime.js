import { DedupTracker } from "./dedup.js";

// Shared runtime for every channel. Push channels drive inbound via a driver
// event stream; poll channels via a timer loop. Outbound is one path: drain the
// shared OutboundQueue for this channel and hand each semantic reply to the
// channel's renderer. Re-entrant deliverQueued coalesces so a reply is never
// double-sent (mirrors the proven feishu delivery guard).
export class BaseChannelRuntime {
  constructor({
    channelId,
    inboundMode = "push",
    adapter,
    outboundQueue,
    renderer,
    driver = null,
    persist = null,
    eventLog = null,
    onAction = null,
    pollIntervalMs = 2500,
    dedupMax = 1000,
  }) {
    this.channelId = channelId;
    this.inboundMode = inboundMode;
    this.adapter = adapter;
    this.outboundQueue = outboundQueue;
    this.renderer = renderer;
    this.driver = driver;
    this.persist = persist;
    this.eventLog = eventLog;
    this.onAction = onAction;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.lastError = null;
    this.startedAt = null;
    this.cursor = null;
    this._timer = null;
    this._polling = false;
    this._delivering = false;
    this._deliverPending = false;
    this._dedup = new DedupTracker(dedupMax);
  }

  getStatus() {
    return {
      state: this.running ? "running" : this.driver ? "configured" : "not_configured",
      lastError: this.lastError,
      startedAt: this.startedAt,
      driver: this.driver?.getStatus?.() ?? null,
    };
  }

  configureDriver(driver) {
    const wasRunning = this.running;
    if (wasRunning) {
      this.stop();
    }
    this.driver = driver;
    if (wasRunning && driver) {
      this.start();
    }
  }

  async start() {
    if (!this.driver || this.running) {
      return this.getStatus();
    }
    if (this.inboundMode === "push") {
      await this.driver.startEventStream({
        onEvent: async (payload) => {
          await this.adapter.handleInbound(payload);
          await this.deliverQueued().catch((error) => {
            this.eventLog?.error?.(`${this.channelId} 投递失败`, { error: error.message });
          });
        },
        onAction: this.onAction ?? (async () => ({})),
        onError: (error) => {
          this.lastError = error?.message ?? String(error);
          this.running = false;
        },
      });
    } else {
      this._startPollLoop();
    }
    this.running = true;
    this.startedAt = new Date().toISOString();
    return this.getStatus();
  }

  stop() {
    if (this.inboundMode === "push") {
      this.driver?.stopEventStream?.();
    } else if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.running = false;
    return this.getStatus();
  }

  _startPollLoop() {
    this._timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.lastError = error?.message ?? String(error);
      });
    }, this.pollIntervalMs);
    this._timer.unref?.();
  }

  // Override point: how to derive a stable inbound id for dedup from a normalized
  // payload. Default reads payload.message.id (matches wechat); a channel whose
  // updates carry a different id field can override.
  dedupKeyOf(payload) {
    return payload?.message?.id ?? null;
  }

  async pollOnce() {
    if (!this.driver) {
      throw new Error(`${this.channelId} driver is not configured`);
    }
    if (this._polling) {
      return { inbound: 0, outbound: 0, cursor: this.cursor, skipped: true };
    }
    this._polling = true;
    try {
      const result = await this.driver.fetchUpdates({ cursor: this.cursor });
      this.cursor = result.nextCursor ?? this.cursor;
      let inbound = 0;
      for (const update of result.updates ?? []) {
        const payload = this.driver.normalizeUpdate(update);
        const id = this.dedupKeyOf(payload);
        if (id != null && !this._dedup.add(id)) {
          continue;
        }
        await this.adapter.handleInbound(payload);
        inbound += 1;
      }
      const { outbound } = await this.deliverQueued();
      await this.persist?.();
      this.lastError = null;
      return { inbound, outbound, cursor: this.cursor };
    } finally {
      this._polling = false;
    }
  }

  async deliverQueued() {
    if (!this.driver) {
      throw new Error(`${this.channelId} driver is not configured`);
    }
    if (this._delivering) {
      this._deliverPending = true;
      return { outbound: 0, coalesced: true };
    }
    this._delivering = true;
    try {
      let outbound = 0;
      do {
        this._deliverPending = false;
        outbound += await this._drainOnce();
      } while (this._deliverPending);
      this.lastError = null;
      return { outbound };
    } finally {
      this._delivering = false;
    }
  }

  async _drainOnce() {
    let n = 0;
    for (const reply of this.outboundQueue.list({ channel: this.channelId })) {
      try {
        await this.renderer.render(reply, { driver: this.driver, runtime: this });
        this.outboundQueue.markDelivered(reply.id);
        n += 1;
      } catch (error) {
        this.outboundQueue.markFailed(reply.id, error);
        this.eventLog?.error?.(`${this.channelId} 投递失败`, { id: reply.id, error: error.message });
      }
    }
    await this.persist?.();
    return n;
  }
}
