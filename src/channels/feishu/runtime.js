import { approvalResolvedCard } from "./cards.js";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export class FeishuRuntimeService {
  constructor({ adapter, outboundQueue, driver = null, persist = null, eventLog = null, cardUpdateIntervalMs = 700 }) {
    if (!adapter) {
      throw new Error("adapter is required");
    }
    if (!outboundQueue) {
      throw new Error("outboundQueue is required");
    }
    this.adapter = adapter;
    this.outboundQueue = outboundQueue;
    this.driver = driver;
    this.persist = persist;
    this.eventLog = eventLog;
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    this.running = false;
    this._startPromise = null;
    this.cardUpdateIntervalMs = cardUpdateIntervalMs;
    // threadId -> { messageId, conversationId, lastSentAt, pendingCard, timer }
    this.cardSessions = new Map();
    // Feishu delivers events at-least-once and redelivers when the consumer is
    // slow to ack; track recent event ids so a redelivered message is not
    // processed (and routed to Codex) twice.
    this.recentEventIds = new Set();
    this.recentEventOrder = [];
  }

  // Returns true when this event was already handled. Keys on the Feishu event
  // id, falling back to the message id when no schema-2.0 header is present.
  isDuplicateEvent(payload) {
    const id =
      payload?.header?.event_id ??
      payload?.event?.message?.message_id ??
      payload?.event?.message_id ??
      payload?.message?.message_id ??
      null;
    if (!id) {
      return false;
    }
    if (this.recentEventIds.has(id)) {
      return true;
    }
    this.recentEventIds.add(id);
    this.recentEventOrder.push(id);
    if (this.recentEventOrder.length > 500) {
      this.recentEventIds.delete(this.recentEventOrder.shift());
    }
    return false;
  }

  configureDriver(driver) {
    const wasRunning = this.running;
    if (wasRunning && this.driver) {
      this.driver.stopEventStream?.();
    }
    this.driver = driver;
    this.lastError = null;
    this.running = false;
    if (wasRunning) {
      void this.start().catch((e) => {
        this.lastError = e.message;
      });
    }
  }

  getStatus() {
    return {
      state: this.running ? "running" : this.driver ? "configured" : "not_configured",
      lastError: this.lastError,
      startedAt: this.startedAt,
      driver: this.driver?.getStatus?.() ?? null,
    };
  }

  async start() {
    if (!this.driver?.startEventStream) {
      throw new Error("Feishu WebSocket driver is not configured");
    }
    if (this.running) {
      return this.getStatus();
    }
    if (this._startPromise) {
      return this._startPromise;
    }
    this._startPromise = (async () => {
      // Do NOT set running = true before startEventStream resolves; if it throws
      // we must not leave running in an inconsistent state.
      try {
        await this.driver.startEventStream({
          onEvent: async (event) => this.handleInbound(event),
          onCardAction: async (action) => this.handleCardAction(action),
          onError: (error) => {
            this.lastError = error.message;
            this.running = false;
          },
        });
      } catch (e) {
        this.running = false;
        throw e;
      }
      this.running = true;
      return this.getStatus();
    })();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  stop() {
    this.driver?.stopEventStream?.();
    this.running = false;
    return this.getStatus();
  }

  async handleInbound(payload) {
    if (!this.driver) {
      throw new Error("Feishu driver is not configured");
    }
    if (!this.driver.verifyEvent(payload)) {
      throw new Error("Feishu event verification failed");
    }
    if (isUrlVerification(payload)) {
      return { kind: "challenge", challenge: payload.challenge };
    }
    if (this.isDuplicateEvent(payload)) {
      return { kind: "ignored", reason: "duplicate event" };
    }
    const reply = await this.adapter.handleInbound(payload);
    await this.deliverQueued();
    await this.persist?.();
    this.lastError = null;
    return reply;
  }

  async deliverQueued() {
    if (!this.driver) {
      throw new Error("Feishu driver is not configured");
    }
    let outbound = 0;
    for (const reply of this.outboundQueue.list({ channel: "feishu" })) {
      try {
        if (reply.kind === "image" || reply.kind === "file") {
          await this._deliverMedia(reply);
        } else if (reply.card) {
          await this.driver.sendCard({
            receiveId: reply.conversationId,
            receiveIdType: "chat_id",
            card: reply.card,
          });
        } else {
          await this.driver.sendText({
            receiveId: reply.conversationId,
            receiveIdType: "chat_id",
            text: reply.text,
          });
        }
        this.outboundQueue.markDelivered(reply.id);
        outbound += 1;
      } catch (error) {
        this.outboundQueue.markFailed(reply.id, error);
        this.eventLog?.error("飞书消息发送失败", {
          id: reply.id,
          kind: reply.kind === "image" || reply.kind === "file" ? reply.kind : reply.card ? "card" : "text",
          conversationId: reply.conversationId,
          error: error.message,
        });
      }
    }
    await this.persist?.();
    this.lastError = null;
    return { outbound };
  }

  async _deliverMedia(reply) {
    const { stat } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    let size = 0;
    try {
      size = (await stat(reply.path)).size;
    } catch {
      await this.driver.sendText({
        receiveId: reply.conversationId,
        receiveIdType: "chat_id",
        text: `⚠️ 文件不存在，无法发送：${reply.path}`,
      });
      return;
    }
    if (size > MAX_MEDIA_BYTES) {
      await this.driver.sendText({
        receiveId: reply.conversationId,
        receiveIdType: "chat_id",
        text: `⚠️ 文件超过 20MB，未发送：${basename(reply.path)}（${Math.round(size / 1024 / 1024)}MB）。可在本机直接查看：${reply.path}`,
      });
      return;
    }
    if (reply.kind === "image") {
      const imageKey = await this.driver.uploadImage(reply.path);
      await this.driver.sendImage({ receiveId: reply.conversationId, receiveIdType: "chat_id", imageKey });
    } else {
      const fileKey = await this.driver.uploadFile(reply.path, reply.fileName ?? basename(reply.path));
      await this.driver.sendFile({ receiveId: reply.conversationId, receiveIdType: "chat_id", fileKey });
    }
  }

  async openThreadCard({ threadId, conversationId, card }) {
    if (!this.driver?.sendCard) {
      throw new Error("Feishu driver does not support cards");
    }
    const result = await this.driver.sendCard({
      receiveId: conversationId,
      receiveIdType: "chat_id",
      card,
    });
    if (result.messageId) {
      this.cardSessions.set(threadId, {
        messageId: result.messageId,
        conversationId,
        lastSentAt: Date.now(),
        pendingCard: null,
        timer: null,
      });
    }
    return result;
  }

  hasThreadCard(threadId) {
    return this.cardSessions.has(threadId);
  }

  // Stores the latest card and schedules a single throttled flush. Repeated
  // calls within the interval collapse into one PATCH carrying the newest card.
  updateThreadCard(threadId, card) {
    const session = this.cardSessions.get(threadId);
    if (!session) {
      return false;
    }
    session.pendingCard = card;
    if (session.timer) {
      return true;
    }
    const wait = Math.max(0, this.cardUpdateIntervalMs - (Date.now() - session.lastSentAt));
    session.timer = setTimeout(() => {
      session.timer = null;
      this.flushThreadCard(threadId);
    }, wait);
    session.timer.unref?.();
    return true;
  }

  async flushThreadCard(threadId) {
    const session = this.cardSessions.get(threadId);
    if (!session || !session.pendingCard) {
      return false;
    }
    const card = session.pendingCard;
    session.pendingCard = null;
    session.lastSentAt = Date.now();
    try {
      await this.driver.updateCard({ messageId: session.messageId, card });
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  // Sends the final card immediately and drops the session.
  async finishThreadCard(threadId, card) {
    const session = this.cardSessions.get(threadId);
    if (!session) {
      return false;
    }
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    this.cardSessions.delete(threadId);
    try {
      await this.driver.updateCard({ messageId: session.messageId, card });
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  // Handles a Feishu `card.action.trigger` callback. Returns a toast payload.
  async handleCardAction(payload) {
    const action = normalizeCardAction(payload);
    if (!action.value) {
      return {};
    }
    const router = this.adapter?.commandRouter ?? null;
    if (action.value.kind === "approval") {
      await router?.resolveApproval(action.value.code, action.value.decision);
      if (action.messageId && this.driver?.updateCard) {
        await this.driver
          .updateCard({
            messageId: action.messageId,
            card: approvalResolvedCard({
              code: action.value.code,
              decision: action.value.decision,
            }),
          })
          .catch(() => {});
      }
      const accepted = action.value.decision === "accept";
      return { toast: { type: accepted ? "success" : "info", content: accepted ? "已批准" : "已拒绝" } };
    }
    if (action.value.kind === "cancel") {
      await router?.cancelThread?.(action.value.threadId);
      return { toast: { type: "info", content: "已请求取消任务" } };
    }
    if (action.value.kind === "pick") {
      const conversation = router?.conversationByIdentity?.get(`feishu:${action.openId}`);
      const conversationId = conversation?.conversationId ?? action.chatId;
      this.eventLog?.info("飞书卡片点击", {
        pickKind: action.value.pickKind,
        index: action.value.index,
        hasRouter: Boolean(router),
        hasOpenId: Boolean(action.openId),
        conversationId,
      });
      if (!router || !action.openId || !conversationId) {
        return { toast: { type: "error", content: "无法定位会话，请直接回复编号" } };
      }
      // Feishu's card-action callback has a tight timeout (~3s). Routing the
      // pick involves a Codex Desktop RPC + sending a follow-up card, which
      // can easily exceed it. Hand the work off and toast immediately; the
      // result lands as a fresh card in the chat when ready.
      const identity = { channel: "feishu", stableId: action.openId };
      const selector = String(action.value.index);
      void this.dispatchPickAsync({
        identity,
        selector,
        pickKind: action.value.pickKind,
        conversationId,
      });
      return { toast: { type: "info", content: "处理中…" } };
    }
    return {};
  }

  // Runs the slow part of a card pick (router dispatch + reply send) in the
  // background. Pushes either the real reply card or an error card; never
  // throws — Feishu has already moved on.
  async dispatchPickAsync({ identity, selector, pickKind, conversationId }) {
    const router = this.adapter?.commandRouter ?? null;
    if (!router) {
      return;
    }
    let reply;
    try {
      reply =
        pickKind === "project"
          ? await router.chooseProject(identity, selector)
          : await router.useSessionAsync(identity, selector);
    } catch (error) {
      this.eventLog?.error("飞书卡片点击：路由失败", { error: error.message });
      await this.adapter
        .sendReplyCard({
          conversationId,
          reply: { kind: "text", text: `操作失败：${error.message}` },
        })
        .catch(() => {});
      await this.deliverQueued().catch(() => {});
      return;
    }
    const normalized = typeof reply === "string" ? { kind: "text", text: reply } : reply;
    this.eventLog?.info("飞书卡片回复就绪", {
      kind: normalized?.kind,
      textLength: (normalized?.text ?? "").length,
      hasPicker: Boolean(normalized?.picker),
    });
    // Card-action replies often have identical text+conversation across clicks
    // (e.g. picking the same project twice), so set an explicit unique
    // dedupeKey to bypass the outbound queue's content-based dedup.
    const dedupeKey = `feishu:pick:${identity.stableId}:${pickKind}:${selector}:${Date.now()}`;
    try {
      await this.adapter.sendReplyCard({ conversationId, reply: normalized, dedupeKey });
      await this.deliverQueued();
      this.eventLog?.info("飞书卡片回复已派发");
    } catch (error) {
      this.eventLog?.error("飞书卡片回复派发失败", { error: error.message });
    }
  }
}

function isUrlVerification(payload) {
  return payload?.type === "url_verification" && Boolean(payload.challenge);
}

// Feishu card-action callback payloads vary by SDK version; pull the fields
// we need defensively from the common shapes.
function normalizeCardAction(payload) {
  const event = payload?.event ?? payload ?? {};
  const action = event.action ?? payload?.action ?? {};
  return {
    value: action.value ?? null,
    openId: event.open_id ?? event.operator?.open_id ?? payload?.open_id ?? null,
    messageId: event.open_message_id ?? payload?.open_message_id ?? null,
    chatId: event.open_chat_id ?? payload?.open_chat_id ?? null,
  };
}
