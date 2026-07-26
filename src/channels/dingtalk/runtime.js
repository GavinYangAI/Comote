// src/channels/dingtalk/runtime.js
import { BaseChannelRuntime } from "../base/runtime.js";
import { routerReplyToSemantic } from "../base/messages.js";
import { createDingTalkRenderer } from "./renderer.js";
import { approvalResolvedCardData } from "./cards.js";
import { toParamMap } from "./cards.js";

// DingTalk runtime. Inbound (Stream), outbound queue delivery via the renderer,
// status and driver wiring are owned by BaseChannelRuntime. This subclass adds the
// card-button callback handling (handleCardAction via the driver onAction hook):
// approvals resolve + update the card in-frame; picks dispatch async (the callback
// has a tight ack window). Live thread-card methods are added in Part B.
export class DingTalkRuntimeService extends BaseChannelRuntime {
  constructor({ adapter, outboundQueue, renderer, driver = null, persist = null, eventLog = null, cardUpdateIntervalMs = 700 }) {
    if (!adapter) throw new Error("adapter is required");
    if (!outboundQueue) throw new Error("outboundQueue is required");
    super({
      channelId: "dingtalk",
      inboundMode: "push",
      adapter,
      outboundQueue,
      renderer: renderer ?? createDingTalkRenderer(),
      driver,
      persist,
      eventLog,
      dedupMax: 500,
    });
    this.cardUpdateIntervalMs = cardUpdateIntervalMs;
    // threadId -> { outTrackId, conversationId, lastSentAt, pendingCard, timer }
    this.cardSessions = new Map();
    // Card-action callbacks arrive through the driver onAction hook; the base
    // start() wires this into driver.startEventStream.
    this.onAction = (action) => this.handleCardAction(action);
  }

  // Status cards are built by the renderer so callers share one shape.
  buildStatusCard(status) {
    return this.renderer.buildStatusCard(status);
  }

  // Whether live thread cards can ACTUALLY be rendered right now. dingtalk
  // declares capabilities.liveUpdates=1, but without a console-built status
  // template openThreadCard degrades to a silent no-op — the host must know so
  // it can fall back to the milestone text flow instead of a fully silent turn.
  liveCardsOperational() {
    return Boolean(this.renderer?.templates?.status);
  }

  hasThreadCard(threadId) {
    return this.cardSessions.has(threadId);
  }

  // card = cardParamMap from buildStatusCard. No status template configured →
  // degrade silently (return false); the final agent reply still arrives as text.
  async openThreadCard({ threadId, conversationId, card }) {
    if (!this.renderer.templates?.status) return false;
    const outTrackId = `status:${threadId}:${Date.now()}`;
    await this.driver.createCard({
      cardTemplateId: this.renderer.templates.status,
      outTrackId,
      receiveId: conversationId,
      cardParamMap: card,
    });
    this.cardSessions.set(threadId, { outTrackId, conversationId, lastSentAt: Date.now(), pendingCard: null, timer: null });
    return true;
  }

  updateThreadCard(threadId, card) {
    const session = this.cardSessions.get(threadId);
    if (!session) return false;
    session.pendingCard = card;
    if (session.timer) return true;
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
    if (!session || !session.pendingCard) return false;
    const card = session.pendingCard;
    session.pendingCard = null;
    session.lastSentAt = Date.now();
    try {
      await this.driver.updateCard({ outTrackId: session.outTrackId, cardParamMap: card });
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  // Synchronously removes (and returns) a thread's card session, cancelling any
  // pending throttled flush. Lets a caller CLAIM the card before doing async work
  // (e.g. reading changed files) so a racing turnCompleted sees no card and skips.
  detachThreadCard(threadId) {
    const session = this.cardSessions.get(threadId);
    if (!session) return null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    this.cardSessions.delete(threadId);
    return session;
  }

  // Sends a final card to an ALREADY-detached session (from detachThreadCard).
  async sendDetachedThreadCard(session, card) {
    try {
      await this.driver.updateCard({ outTrackId: session.outTrackId, cardParamMap: card });
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  async finishThreadCard(threadId, card) {
    const session = this.detachThreadCard(threadId);
    if (!session) return false;
    return this.sendDetachedThreadCard(session, card);
  }

  // Handles a DingTalk TOPIC_CARD callback payload. Returns an in-frame card-update
  // object (becomes the ACK) or {} when nothing to update.
  async handleCardAction(payload) {
    const params = readCallbackParams(payload);
    if (!params?.action) return {};
    const router = this.adapter?.commandRouter ?? null;

    // Authorize the REAL operator who clicked the button (their staffId), not the
    // conversationId. A card button is a side-effecting command — anyone in a
    // group, or any unconfirmed user, must not be able to approve/reject/cancel/
    // pick. Resolve identity from the callback payload and gate on the router's
    // authorization store; deny silently (no card update) otherwise.
    const operatorStaffId = readOperatorStaffId(payload);
    const identity = operatorStaffId ? { channel: "dingtalk", stableId: operatorStaffId } : null;
    if (!router?.authorization?.isAuthorized?.(identity)) {
      this.eventLog?.warn?.("钉钉卡片点击：未授权", { action: params.action, operator: operatorStaffId ?? null });
      return {};
    }

    if (["approve", "approve_session", "reject"].includes(params.action)) {
      const decision = params.action === "approve"
        ? "accept"
        : params.action === "approve_session"
          ? "acceptForSession"
          : "decline";
      // Pass the clicker identity so the router's thread-owner check applies —
      // an authorized user still may not resolve another user's approval. Only
      // the typed ownership rejection is swallowed; anything else (RPC
      // timeout, connector down) rethrows — the approval survives an
      // unresolved fault, so the click can simply be retried.
      try {
        await router?.resolveApproval?.(params.code, decision, identity);
      } catch (error) {
        if (error?.code !== "not_owner") {
          throw error;
        }
        this.eventLog?.warn?.("钉钉卡片审批被拒绝：非任务发起人", {
          code: params.code,
          operator: operatorStaffId ?? null,
        });
        return {};
      }
      const resolved = approvalResolvedCardData({ code: params.code, decision });
      // In-frame card update: flip the card to its resolved face.
      return { cardUpdateOptions: { updateCardDataByKey: true }, cardData: { cardParamMap: toParamMap({ title: resolved.title, body: resolved.body, done: true }) } };
    }

    if (params.action === "pick") {
      const conversationId = params.conv;
      if (!conversationId) return {};
      // The callback has a tight ack window; routing a pick involves a Codex RPC +
      // a follow-up card. Hand it off and ack immediately; the result lands as a
      // fresh message when ready (mirrors feishu). The pick runs under the
      // authorized operator's identity (not the conversationId).
      void this.dispatchPickAsync({ identity, selector: String(params.index), pickKind: params.pickKind, conversationId });
      return {};
    }

    if (params.action === "cancel") {
      // Cancel button on a live status card: request thread cancellation (mirrors
      // feishu's cancel handling). The card finishes via the turn's end event.
      await router?.cancelThread?.(params.threadId);
      return {};
    }

    return {};
  }

  async dispatchPickAsync({ identity, selector, pickKind, conversationId }) {
    const router = this.adapter?.commandRouter ?? null;
    if (!router) return;
    let reply;
    try {
      reply = pickKind === "project" ? await router.chooseProject(identity, selector) : await router.useSessionAsync(identity, selector);
    } catch (error) {
      this.eventLog?.error?.("钉钉卡片点击：路由失败", { error: error.message });
      const semantic = routerReplyToSemantic({ kind: "text", text: error.message }, { channel: "dingtalk", conversationId });
      if (semantic) {
        await this.adapter.sendReply(semantic).catch(() => {});
        await this.deliverQueued().catch(() => {});
      }
      return;
    }
    // The success tail is also fired-and-forgotten (void dispatchPickAsync), so a
    // throw here (e.g. routerReplyToSemantic or a sync send error) would surface
    // as an unhandled rejection. Catch + log so it never crashes the process.
    try {
      const normalized = typeof reply === "string" ? { kind: "text", text: reply } : reply;
      const dedupeKey = `dingtalk:pick:${identity.stableId}:${pickKind}:${selector}:${Date.now()}`;
      const semantic = routerReplyToSemantic(normalized, { channel: "dingtalk", conversationId });
      if (semantic) {
        await this.adapter.sendReply({ ...semantic, dedupeKey }).catch(() => {});
        await this.deliverQueued().catch(() => {});
      }
    } catch (error) {
      this.eventLog?.error?.("钉钉卡片点击：回复派发失败", { error: error.message });
    }
  }
}

// Pulls the button params out of a TOPIC_CARD callback payload. The params object
// is JSON-nested under content.cardPrivateData.params.
function readCallbackParams(payload) {
  try {
    const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content ?? {};
    return content?.cardPrivateData?.params ?? null;
  } catch {
    return null;
  }
}

// Resolves the staffId of the user who clicked the card button. DingTalk's
// TOPIC_CARD callback carries the operator's userId at the top level (the same
// staffId namespace the adapter authorizes inbound messages under); fall back to
// other known field names defensively across SDK shapes. Returns null when no
// operator can be determined (caller denies).
function readOperatorStaffId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.userId ?? payload.userid ?? payload.operatorUserId ?? payload.senderStaffId ?? null;
}
