import { BaseChannelRuntime } from "../base/runtime.js";
import { routerReplyToSemantic } from "../base/messages.js";
import { approvalResolvedCard } from "./cards.js";
import { createFeishuRenderer } from "./renderer.js";
import { classifyMedia, resolveWithinProject } from "../../core/paths.js";
import { t } from "../../core/i18n/index.js";

// Re-exported for back-compat: the media size guard now lives in the renderer
// (A5), but external references still import it from here.
export { MAX_MEDIA_BYTES } from "./renderer.js";

// Feishu runtime. Inbound (push event stream), outbound queue delivery via the
// renderer, status, and driver wiring are all owned by BaseChannelRuntime. This
// subclass keeps only what is genuinely feishu-specific: the url_verification
// handshake + at-least-once event dedup (handleInbound override), the live
// "thread card" used to stream Codex status (open/update-throttled/finish),
// card-button callbacks (handleCardAction via the driver's onAction hook), and
// async pick dispatch.
export class FeishuRuntimeService extends BaseChannelRuntime {
  constructor({ adapter, outboundQueue, renderer, driver = null, persist = null, eventLog = null, cardUpdateIntervalMs = 700 }) {
    if (!adapter) {
      throw new Error("adapter is required");
    }
    if (!outboundQueue) {
      throw new Error("outboundQueue is required");
    }
    // The renderer is the feishu semantic-reply renderer (A5). It is supplied
    // by callers (and by every test via makeRuntime); we default to a fresh one
    // so the not-yet-migrated state.js construction (A12 wires it explicitly)
    // keeps working. The runtime always has a working renderer either way.
    super({
      channelId: "feishu",
      inboundMode: "push",
      adapter,
      outboundQueue,
      // Intentional fallback: state.js injects a renderer explicitly; the default covers constructions that omit one (e.g. tests).
      renderer: renderer ?? createFeishuRenderer(),
      driver,
      persist,
      eventLog,
      dedupMax: 500,
    });
    this.cardUpdateIntervalMs = cardUpdateIntervalMs;
    // threadId -> { messageId, conversationId, lastSentAt, pendingCard, timer }
    this.cardSessions = new Map();
    // Feishu delivers events at-least-once and redelivers when the consumer is
    // slow to ack; track recent event ids so a redelivered message is not
    // processed (and routed to Codex) twice.
    this.recentEventIds = new Set();
    this.recentEventOrder = [];
    // Card-action button callbacks come back through the driver's onAction hook;
    // the base start() wires this into driver.startEventStream.
    this.onAction = (action) => this.handleCardAction(action);
  }

  // Status cards are built by the renderer so callers and the queue path share
  // one card shape.
  buildStatusCard(status) {
    return this.renderer.buildStatusCard(status);
  }

  // Override start() to preserve two feishu-specific guarantees the base does
  // not provide: (1) a missing/incomplete driver throws rather than silently
  // no-ops, and (2) a WebSocket setup failure rejects (the base swallows it).
  // Re-entry is guarded by the base `running` flag set synchronously before the
  // await, so concurrent start() calls invoke startEventStream exactly once.
  async start() {
    if (!this.driver?.startEventStream) {
      throw new Error("Feishu WebSocket driver is not configured");
    }
    if (this.running) {
      return this.getStatus();
    }
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    try {
      await this.driver.startEventStream({
        onEvent: async (payload) => {
          try {
            await this.handleInbound(payload);
          } catch (error) {
            this.eventLog?.error?.("feishu 入站处理失败", { error: error.message });
          }
        },
        onAction: this.onAction ?? (async () => ({})),
        onError: (error) => {
          this.lastError = error?.message ?? String(error);
          this.running = false;
        },
      });
    } catch (e) {
      this.running = false;
      throw e;
    }
    return this.getStatus();
  }

  // Override configureDriver to restart asynchronously and swallow the restart
  // error into lastError — the base restarts synchronously and our start() now
  // rejects on failure, which would surface as an unhandled rejection.
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

  // Override the base inbound entry: the url_verification handshake and
  // at-least-once event dedup run before the shared adapter + queue pipeline.
  // Used by both the WS event stream and the inbound webhook.
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
    return reply ?? { kind: "ok" };
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
      return {
        toast: {
          type: accepted ? "success" : "info",
          content: accepted ? t("feishu.toast.approved") : t("feishu.toast.rejected"),
        },
      };
    }
    if (action.value.kind === "cancel") {
      await router?.cancelThread?.(action.value.threadId);
      return { toast: { type: "info", content: t("feishu.toast.cancelRequested") } };
    }
    if (action.value.kind === "pushfile") {
      const binding = router?.getThreadBinding?.(action.value.threadId);
      const projectPath = binding?.projectPath ?? null;
      const conversationId = binding?.conversationId ?? action.chatId ?? null;
      if (!projectPath || !conversationId) {
        return { toast: { type: "error", content: t("feishu.toast.noProject") } };
      }
      const safePath = resolveWithinProject(projectPath, action.value.path);
      if (!safePath) {
        this.eventLog?.warn?.("飞书推送文件：路径越界", {
          threadId: action.value.threadId,
          projectPath,
          path: action.value.path,
        });
        return { toast: { type: "error", content: t("feishu.toast.pathDenied") } };
      }
      const { basename } = await import("node:path");
      this.outboundQueue.enqueue({
        channel: "feishu",
        conversationId,
        kind: "media",
        mediaKind: classifyMedia(safePath),
        path: safePath,
        fileName: basename(safePath),
      });
      // Fire-and-forget so the toast returns within Feishu's ~3s callback window.
      void this.deliverQueued().catch((err) =>
        this.eventLog?.error?.("飞书推送文件：发送失败", { error: err.message }),
      );
      return { toast: { type: "info", content: t("feishu.toast.pushing") } };
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
        return { toast: { type: "error", content: t("feishu.toast.noConversation") } };
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
      return { toast: { type: "info", content: t("feishu.toast.processing") } };
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
      // Enqueue a semantic failure reply; the feishu renderer turns it into a
      // text card at delivery (replaces the removed adapter card-send method).
      const failReply = { kind: "text", text: t("feishu.reply.actionFailed", { error: error.message }) };
      const semantic = routerReplyToSemantic(failReply, { channel: "feishu", conversationId });
      if (semantic) {
        await this.adapter.sendReply(semantic).catch(() => {});
        await this.deliverQueued().catch(() => {});
      }
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
      // The renderer (A5) builds the card from the semantic reply at delivery,
      // so enqueue a semantic picker/text reply rather than a prebuilt card.
      // routerReplyToSemantic returns null for denied/ignored and for empty
      // text — matching the old code's `!reply.text` bail.
      const semantic = routerReplyToSemantic(normalized, { channel: "feishu", conversationId });
      if (semantic) {
        await this.adapter.sendReply({ ...semantic, dedupeKey });
        await this.deliverQueued();
        this.eventLog?.info("飞书卡片回复已派发");
      }
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
