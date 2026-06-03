import { createHash } from "node:crypto";

import { approvalResolvedCard, textCard } from "./cards.js";

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
    this.needsRelogin = false;
    this.startedAt = new Date().toISOString();
    this.running = false;
    this._startPromise = null;
    this._driverGeneration = 0;
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
    const shouldRestart = this.running || Boolean(this._startPromise);
    this._driverGeneration += 1;
    this._startPromise = null;
    if (shouldRestart && this.driver) {
      // A failed close on the outgoing socket (e.g. a half-open Lark WSClient on
      // re-bind) must not abort reconfiguration — otherwise the login confirm
      // path throws (HTTP 500) and the freshly-scanned binding is lost. Swallow
      // it and let the new driver take over.
      try {
        this.driver.stopEventStream?.();
      } catch (error) {
        this.lastError = error.message;
      }
    }
    this.driver = driver;
    this.lastError = null;
    this.needsRelogin = false;
    this.running = false;
    if (shouldRestart && this.driver) {
      void this.start().catch((e) => {
        this.lastError = e.message;
      });
    }
  }

  getStatus() {
    return {
      state: this.running ? "running" : this.driver ? "configured" : "not_configured",
      lastError: this.lastError,
      needsRelogin: this.needsRelogin,
      startedAt: this.startedAt,
      driver: this.driver?.getStatus?.() ?? null,
    };
  }

  async start() {
    const driver = this.driver;
    const generation = this._driverGeneration;
    if (!driver?.startEventStream) {
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
        await driver.startEventStream({
          onEvent: async (event) => this.handleInbound(event),
          onCardAction: async (action) => this.handleCardAction(action),
          onError: (error) => {
            if (generation !== this._driverGeneration || driver !== this.driver) {
              return;
            }
            this.lastError = error.message;
            this.updateReloginState(error);
            this.running = false;
          },
        });
      } catch (e) {
        this.running = false;
        this.lastError = e.message;
        this.updateReloginState(e);
        throw e;
      }
      if (generation !== this._driverGeneration || driver !== this.driver) {
        driver.stopEventStream?.();
        return this.getStatus();
      }
      this.running = true;
      this.needsRelogin = false;
      return this.getStatus();
    })();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  stop() {
    try {
      this.driver?.stopEventStream?.();
    } catch (error) {
      this.lastError = error.message;
    }
    this.running = false;
    return this.getStatus();
  }

  updateReloginState(error) {
    if (isFeishuAuthError(error)) {
      this.needsRelogin = true;
    }
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
    // Surface the inbound message type so image/post handling is observable in
    // the event log (helps diagnose attachments that don't reach Codex).
    const inboundMessageType =
      payload?.event?.message?.message_type ?? payload?.message?.message_type ?? "unknown";
    this.eventLog?.info("飞书入站消息", { messageType: inboundMessageType });
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
    let failed = false;
    for (const reply of this.outboundQueue.list({ channel: "feishu" })) {
      try {
        if (reply.media) {
          await this.deliverMedia(reply);
        } else if (reply.card) {
          await this.driver.sendCard({
            receiveId: reply.conversationId,
            receiveIdType: "chat_id",
            card: reply.card,
            uuid: deliveryId(reply),
          });
        } else {
          await this.driver.sendText({
            receiveId: reply.conversationId,
            receiveIdType: "chat_id",
            text: reply.text,
            uuid: deliveryId(reply),
          });
        }
        this.outboundQueue.markDelivered(reply.id);
        outbound += 1;
      } catch (error) {
        failed = true;
        this.lastError = error.message;
        this.outboundQueue.markFailed(reply.id, error);
        this.updateReloginState(error);
        this.eventLog?.error("飞书消息发送失败", {
          id: reply.id,
          kind: reply.media ? "media" : reply.card ? "card" : "text",
          conversationId: reply.conversationId,
          error: error.message,
        });
      }
    }
    await this.persist?.();
    if (!failed) {
      this.lastError = null;
      this.needsRelogin = false;
    }
    return { outbound };
  }

  // Uploads a local image/file and sends it as a native Feishu attachment.
  async deliverMedia(reply) {
    const { kind, path, name } = reply.media;
    if (kind === "image") {
      const imageKey = await this.driver.uploadImage(path);
      await this.driver.sendImage({
        receiveId: reply.conversationId,
        receiveIdType: "chat_id",
        imageKey,
        uuid: deliveryId(reply),
      });
      return;
    }
    const fileKey = await this.driver.uploadFile(path, name);
    await this.driver.sendFile({
      receiveId: reply.conversationId,
      receiveIdType: "chat_id",
      fileKey,
      uuid: deliveryId(reply),
    });
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
      this.updateReloginState(error);
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
      this.updateReloginState(error);
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
      void this.resolveApprovalActionAsync({
        router,
        code: action.value.code,
        decision: action.value.decision,
        messageId: action.messageId,
      });
      return { toast: { type: "info", content: "审批处理中…" } };
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

  async resolveApprovalActionAsync({ router, code, decision, messageId }) {
    if (!router?.resolveApproval) {
      const error = new Error("Codex Desktop 审批功能当前不可用。");
      this.recordApprovalActionFailure({ code, decision, error });
      await this.updateApprovalCardFailure({ messageId, code, error });
      return;
    }
    try {
      await router.resolveApproval(code, decision);
      this.lastError = null;
      if (messageId && this.driver?.updateCard) {
        await this.driver.updateCard({
          messageId,
          card: approvalResolvedCard({ code, decision }),
        });
      }
    } catch (error) {
      this.recordApprovalActionFailure({ code, decision, error });
      await this.updateApprovalCardFailure({ messageId, code, error });
    }
  }

  recordApprovalActionFailure({ code, decision, error }) {
    this.lastError = error.message;
    this.updateReloginState(error);
    this.eventLog?.error("飞书审批处理失败", {
      code,
      decision,
      error: error.message,
    });
  }

  async updateApprovalCardFailure({ messageId, code, error }) {
    if (!messageId || !this.driver?.updateCard) {
      return;
    }
    try {
      await this.driver.updateCard({
        messageId,
        card: textCard(`审批 ${code} 处理失败：${error.message}`),
      });
    } catch (updateError) {
      this.lastError = updateError.message;
      this.updateReloginState(updateError);
      this.eventLog?.error("飞书审批卡片更新失败", {
        code,
        error: updateError.message,
      });
    }
  }
}

function isUrlVerification(payload) {
  return payload?.type === "url_verification" && Boolean(payload.challenge);
}

function deliveryId(reply) {
  const source = reply.dedupeKey ?? reply.id;
  return `comote-${createHash("sha256").update(String(source)).digest("hex").slice(0, 32)}`;
}

function isFeishuAuthError(error) {
  const message = String(error?.message ?? error ?? "");
  return /(?:401|403|99991668|10003|token|app secret|app not found|invalid|unauthorized|forbidden|expired)/i.test(
    message,
  );
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
