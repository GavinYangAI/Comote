// src/channels/telegram/runtime.js
import { BaseChannelRuntime } from "../base/runtime.js";
import { routerReplyToSemantic } from "../base/messages.js";
import { createTelegramRenderer } from "./renderer.js";
import { decodeCallback } from "./cards.js";

// Telegram runtime. BaseChannelRuntime owns inbound (push), outbound delivery via the
// renderer, status + driver wiring. This subclass adds: inline-keyboard callback
// handling (driver onAction hook), live thread-card methods (editMessageText, mirrors
// dingtalk's throttle), and a start() override that ensures a pairing code exists
// before the channel begins listening (so the config page can show it).
export class TelegramRuntimeService extends BaseChannelRuntime {
  constructor({ adapter, outboundQueue, renderer, driver = null, persist = null, eventLog = null, ensurePairingCode = null, cardUpdateIntervalMs = 700 }) {
    if (!adapter) throw new Error("adapter is required");
    if (!outboundQueue) throw new Error("outboundQueue is required");
    super({
      channelId: "telegram",
      inboundMode: "push",
      adapter,
      outboundQueue,
      renderer: renderer ?? createTelegramRenderer(),
      driver,
      persist,
      eventLog,
      dedupMax: 500,
    });
    this.ensurePairingCode = ensurePairingCode;
    this.cardUpdateIntervalMs = cardUpdateIntervalMs;
    // threadId -> { messageId, conversationId, lastSentAt, pendingCard, timer }
    this.cardSessions = new Map();
    this.onAction = (cq) => this.handleCallbackQuery(cq);
  }

  async start() {
    await this.ensurePairingCode?.();
    return super.start();
  }

  buildStatusCard(status) {
    return this.renderer.buildStatusCard(status);
  }

  hasThreadCard(threadId) {
    return this.cardSessions.has(threadId);
  }

  // card = { text, replyMarkup } from buildStatusCard.
  async openThreadCard({ threadId, conversationId, card }) {
    if (!conversationId) return false;
    const msg = await this.driver.sendMessage({ chatId: conversationId, text: card.text, replyMarkup: card.replyMarkup ?? null });
    this.cardSessions.set(threadId, { messageId: msg.message_id, conversationId, lastSentAt: Date.now(), pendingCard: null, timer: null });
    return true;
  }

  updateThreadCard(threadId, card) {
    const session = this.cardSessions.get(threadId);
    if (!session) return false;
    session.pendingCard = card;
    if (session.timer) return true;
    const wait = Math.max(0, this.cardUpdateIntervalMs - (Date.now() - session.lastSentAt));
    session.timer = setTimeout(() => { session.timer = null; this.flushThreadCard(threadId); }, wait);
    session.timer.unref?.();
    return true;
  }

  async flushThreadCard(threadId) {
    const session = this.cardSessions.get(threadId);
    if (!session || !session.pendingCard) return false;
    const card = session.pendingCard;
    session.pendingCard = null;
    session.lastSentAt = Date.now();
    await this._edit(session, card);
    return true;
  }

  // Claims the session synchronously (clears the throttle timer, drops it from
  // the map) so a racing completion path can't double-deliver. Mirrors feishu /
  // dingtalk so state.js's agentMessage completion path works for telegram too.
  detachThreadCard(threadId) {
    const session = this.cardSessions.get(threadId);
    if (!session) return null;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    this.cardSessions.delete(threadId);
    return session;
  }

  async sendDetachedThreadCard(session, card) {
    return this._edit(session, card);
  }

  async finishThreadCard(threadId, card) {
    const session = this.detachThreadCard(threadId);
    if (!session) return false;
    return this.sendDetachedThreadCard(session, card);
  }

  async _edit(session, card) {
    try {
      await this.driver.editMessageText({ chatId: session.conversationId, messageId: session.messageId, text: card.text, replyMarkup: card.replyMarkup ?? null });
      return true;
    } catch (error) {
      // Telegram rejects an identical edit with "message is not modified" — benign.
      if (/not modified/i.test(error.message)) return true;
      this.lastError = error.message;
      return false;
    }
  }

  // Handles an inline-keyboard callback_query (driver onAction). The chat id + sender
  // come on the callback_query itself, so callback_data only carries the action ref.
  async handleCallbackQuery(cq) {
    const params = decodeCallback(cq.data);
    const conversationId = cq.message?.chat?.id != null ? String(cq.message.chat.id) : null;
    await this.driver.answerCallbackQuery({ callbackQueryId: cq.id }).catch(() => {});
    if (!params) return;
    const router = this.adapter?.commandRouter ?? null;

    if (params.action === "approve" || params.action === "reject") {
      const decision = params.action === "approve" ? "accept" : "decline";
      await router?.resolveApproval?.(params.code, decision);
      return;
    }
    if (params.action === "cancel") {
      await router?.cancelThread?.(params.threadId);
      return;
    }
    if (params.action === "pick") {
      if (!router || !conversationId) return;
      const identity = { channel: "telegram", stableId: conversationId };
      void this.dispatchPickAsync({ identity, selector: String(params.index), pickKind: params.pickKind, conversationId });
    }
  }

  async dispatchPickAsync({ identity, selector, pickKind, conversationId }) {
    const router = this.adapter?.commandRouter ?? null;
    if (!router) return;
    let reply;
    try {
      reply = pickKind === "project" ? await router.chooseProject(identity, selector) : await router.useSessionAsync(identity, selector);
    } catch (error) {
      this.eventLog?.error?.("Telegram 选择器点击：路由失败", { error: error.message });
      const semantic = routerReplyToSemantic({ kind: "text", text: error.message }, { channel: "telegram", conversationId });
      if (semantic) { await this.adapter.sendReply(semantic).catch(() => {}); await this.deliverQueued().catch(() => {}); }
      return;
    }
    const normalized = typeof reply === "string" ? { kind: "text", text: reply } : reply;
    const dedupeKey = `telegram:pick:${identity.stableId}:${pickKind}:${selector}:${Date.now()}`;
    const semantic = routerReplyToSemantic(normalized, { channel: "telegram", conversationId });
    if (semantic) { await this.adapter.sendReply({ ...semantic, dedupeKey }).catch(() => {}); await this.deliverQueued().catch(() => {}); }
  }
}
