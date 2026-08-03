// src/channels/telegram/runtime.js
import { BaseChannelRuntime } from "../base/runtime.js";
import { routerReplyToSemantic } from "../base/messages.js";
import { EditableApprovalMessages } from "../base/editable-approval-messages.js";
import { describeResolvedApprovalForChat } from "../base/approval-format.js";
import { createTelegramRenderer } from "./renderer.js";
import { decodeCallback, chunkMessage, BOT_COMMANDS } from "./cards.js";
import { resolveWithinProject, classifyMedia } from "../../core/paths.js";

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
    this.approvalMessages = new EditableApprovalMessages({
      update: async (message, resolution) => {
        if (message.threadId) {
          return this._resumeLiveApproval(message, resolution);
        }
        await this.driver.editMessageText({
          chatId: message.conversationId,
          messageId: message.messageId,
          text: describeResolvedApprovalForChat(resolution.approval, resolution),
          replyMarkup: null,
        });
      },
    });
    // threadId -> { messageId, conversationId, lastSentAt, pendingCard, timer }
    this.cardSessions = new Map();
    // threadId -> files[] remembered for pushfile callbacks after the card detaches.
    this.threadFiles = new Map();
    this._maxThreadFiles = 200;
    this.onAction = (cq) => this.handleCallbackQuery(cq);
  }

  rememberApprovalMessage(code, message) {
    return this.approvalMessages.remember(code, message);
  }

  resolveApprovalMessage({ code, decision, approval = null, fallback = null }) {
    return this.approvalMessages.resolve({ code, decision, approval, fallback });
  }

  async start() {
    await this.ensurePairingCode?.();
    const status = await super.start();
    // Register the command menu (the "/" button) so users can discover commands
    // without typing them blind. Fire-and-forget: a menu registration failure
    // must never block or fail the channel start.
    if (this.running && typeof this.driver?.setMyCommands === "function") {
      Promise.resolve(this.driver.setMyCommands(BOT_COMMANDS)).catch((error) => {
        this.eventLog?.warn?.("telegram 注册命令菜单失败", { error: error?.message ?? String(error) });
      });
    }
    return status;
  }

  // Best-effort "Codex is typing" indicator (state.js calls this on turnStarted
  // for every channel that declares capabilities.typing). Mirrors the wechat
  // runtime's contract: never throws, no-ops without a driver/conversation.
  async sendTyping({ conversationId }) {
    if (!this.driver?.sendChatAction || !conversationId) {
      return;
    }
    try {
      await this.driver.sendChatAction({ chatId: conversationId, action: "typing" });
    } catch {
      // A failed typing indicator must never disrupt the runtime.
    }
  }

  async addInboundReaction(message) {
    if (!this.driver?.setMessageReaction || !message.conversationId || message.messageId == null) return null;
    await this.driver.setMessageReaction({
      chatId: message.conversationId,
      messageId: message.messageId,
      emoji: "👀",
    });
    return { conversationId: message.conversationId, messageId: message.messageId };
  }

  async removeInboundReaction(feedback) {
    if (!this.driver?.setMessageReaction || !feedback?.conversationId || feedback.messageId == null) return false;
    await this.driver.setMessageReaction({
      chatId: feedback.conversationId,
      messageId: feedback.messageId,
      emoji: null,
    });
    return true;
  }

  buildStatusCard(status) {
    if (status.done && status.threadId && status.files?.length) {
      this.threadFiles.set(status.threadId, status.files);
      if (this.threadFiles.size > this._maxThreadFiles) {
        this.threadFiles.delete(this.threadFiles.keys().next().value);
      }
    }
    return this.renderer.buildStatusCard(status);
  }

  hasThreadCard(threadId) {
    return this.cardSessions.has(threadId);
  }

  // card = { text, replyMarkup } from buildStatusCard.
  async openThreadCard({ threadId, conversationId, card }) {
    if (!conversationId) return false;
    let msg;
    try {
      msg = await this.driver.sendMessage({
        chatId: conversationId,
        text: card.text,
        parseMode: card.parseMode ?? null,
        replyMarkup: card.replyMarkup ?? null,
      });
    } catch (error) {
      const parseRejected = card.parseMode && error?.code === 400 && /can't parse entities/i.test(error?.message ?? "");
      if (!parseRejected || card.plainText == null) throw error;
      msg = await this.driver.sendMessage({
        chatId: conversationId,
        text: card.plainText,
        replyMarkup: card.replyMarkup ?? null,
      });
    }
    // Remember who owns this thread so a different (even authorized) user cannot
    // drive someone else's card via a forwarded/leaked button. Telegram's
    // accountId on the binding is the sender's id (== identity.stableId).
    const ownerStableId = this.adapter?.commandRouter?.getThreadBinding?.(threadId)?.accountId ?? null;
    this.cardSessions.set(threadId, {
      messageId: msg.message_id,
      conversationId,
      ownerStableId,
      lastSentAt: Date.now(),
      lastCard: card,
      pendingCard: null,
      timer: null,
      paused: false,
      resumeCard: null,
      updateChain: Promise.resolve(),
    });
    return true;
  }

  updateThreadCard(threadId, card) {
    const session = this.cardSessions.get(threadId);
    if (!session) return false;
    session.pendingCard = card;
    if (session.paused) return true;
    if (session.timer) return true;
    const wait = Math.max(0, this.cardUpdateIntervalMs - (Date.now() - session.lastSentAt));
    session.timer = setTimeout(() => { session.timer = null; this.flushThreadCard(threadId); }, wait);
    session.timer.unref?.();
    return true;
  }

  async flushThreadCard(threadId) {
    const session = this.cardSessions.get(threadId);
    if (!session || session.paused || !session.pendingCard) return false;
    const card = session.pendingCard;
    session.pendingCard = null;
    session.lastSentAt = Date.now();
    await this._updateSessionCard(session, card);
    session.lastCard = card;
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
    return this._updateSessionCard(session, card);
  }

  async finishThreadCard(threadId, card) {
    const session = this.detachThreadCard(threadId);
    if (!session) return false;
    return this.sendDetachedThreadCard(session, card);
  }

  async showThreadApproval({ threadId, code, approval, autoApproved = false }) {
    const session = this.cardSessions.get(threadId);
    if (!session) return false;
    const previousState = {
      paused: session.paused,
      pendingCard: session.pendingCard,
      resumeCard: session.resumeCard,
    };
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.resumeCard = session.pendingCard ?? session.lastCard;
    session.pendingCard = null;
    session.paused = true;
    this.rememberApprovalMessage(code, {
      messageId: session.messageId,
      conversationId: session.conversationId,
      approval,
      threadId,
    });
    const card = this.renderer.buildApprovalCard({ code, approval, autoApproved });
    const updated = await this._updateSessionCard(session, card);
    if (!updated) {
      session.paused = previousState.paused;
      session.pendingCard = previousState.pendingCard;
      session.resumeCard = previousState.resumeCard;
      this.approvalMessages.messages.delete(String(code));
      if (!session.paused && session.pendingCard) {
        this.updateThreadCard(threadId, session.pendingCard);
      }
      return false;
    }
    return true;
  }

  async _resumeLiveApproval(message, resolution) {
    const session = this.cardSessions.get(message.threadId);
    if (!session || session.messageId !== message.messageId) {
      await this.driver.editMessageText({
        chatId: message.conversationId,
        messageId: message.messageId,
        text: describeResolvedApprovalForChat(resolution.approval, resolution),
        replyMarkup: null,
      });
      return;
    }
    const card = session.pendingCard ?? session.resumeCard
      ?? this.buildStatusCard({ phase: "progress", threadId: message.threadId });
    const updated = await this._updateSessionCard(session, card);
    if (!updated) {
      throw new Error(this.lastError || "Failed to resume Telegram live approval message");
    }
    if (session.pendingCard === card) session.pendingCard = null;
    session.resumeCard = null;
    session.lastCard = card;
    session.lastSentAt = Date.now();
    session.paused = false;
    if (session.pendingCard) {
      this.updateThreadCard(message.threadId, session.pendingCard);
    }
  }

  async _edit(session, card) {
    let editError;
    try {
      await this.driver.editMessageText({
        chatId: session.conversationId,
        messageId: session.messageId,
        text: card.text,
        parseMode: card.parseMode ?? null,
        replyMarkup: card.replyMarkup ?? null,
      });
      return true;
    } catch (error) {
      const parseRejected = card.parseMode && error?.code === 400 && /can't parse entities/i.test(error?.message ?? "");
      if (parseRejected && card.plainText != null) {
        try {
          await this.driver.editMessageText({
            chatId: session.conversationId,
            messageId: session.messageId,
            text: card.plainText,
            replyMarkup: card.replyMarkup ?? null,
          });
          return true;
        } catch (fallbackError) {
          editError = fallbackError;
        }
      } else {
        editError = error;
      }
      const message = editError?.message ?? "";
      // Telegram rejects an identical edit with "message is not modified" — benign.
      if (/not modified/i.test(message)) return true;
      // Defensive backstop: completion cards pre-clamp their body (tail kept), so
      // this rarely fires — but a "message is too long" 400 would otherwise strand
      // the card mid-progress. Fall back to chunked fresh sends so the reply survives.
      if (/too long|message_too_long|MESSAGE_TOO_LONG/i.test(message)) {
        const delivered = await this._sendChunked(session.conversationId, card.plainText ?? card.text).catch((err) => { this.lastError = err.message; return false; });
        return delivered;
      }
      this.lastError = message;
      return false;
    }
  }

  _updateSessionCard(session, card) {
    const update = Promise.resolve(session.updateChain)
      .catch(() => {})
      .then(() => this._edit(session, card));
    session.updateChain = update;
    return update;
  }

  // Sends a body as one or more fresh messages, each <=4096 chars. Used as the
  // recovery path when editMessageText rejects an over-long card body.
  async _sendChunked(chatId, text) {
    // Reserve room for a possible "(i/n)\n" prefix so a prefixed chunk never overflows.
    const chunks = chunkMessage(text, 4096 - 16);
    if (chunks.length === 0) return true;
    for (let i = 0; i < chunks.length; i += 1) {
      const body = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
      await this.driver.sendMessage({ chatId, text: body });
    }
    return true;
  }

  // Handles an inline-keyboard callback_query (driver onAction). The chat id + sender
  // come on the callback_query itself, so callback_data only carries the action ref.
  async handleCallbackQuery(cq) {
    const params = decodeCallback(cq.data);
    const conversationId = cq.message?.chat?.id != null ? String(cq.message.chat.id) : null;
    await this.driver.answerCallbackQuery({ callbackQueryId: cq.id }).catch(() => {});
    if (!params) return;
    const router = this.adapter?.commandRouter ?? null;

    // Authorize the REAL clicker (callback_query.from), not the chat. Inline buttons
    // can be pressed by anyone who can see the message (e.g. in a shared/forwarded
    // context), so every side effect below must pass the same gate inbound messages
    // do. Drop silently (the callback was already answered) before any side effect.
    const clickerId = cq.from?.id != null ? String(cq.from.id) : null;
    const identity = clickerId != null ? { channel: "telegram", stableId: clickerId } : null;
    if (!identity || !router?.authorization?.isAuthorized?.(identity)) {
      this.eventLog?.warn?.("telegram 回调：未授权点击，已忽略", { action: params.action, clickerId });
      return;
    }
    // Where a card session exists, the clicker must be its owner — an authorized
    // user still may not drive another operator's thread.
    if (params.threadId != null) {
      const session = this.cardSessions.get(params.threadId);
      if (session?.ownerStableId != null && session.ownerStableId !== clickerId) {
        this.eventLog?.warn?.("telegram 回调：点击者非线程归属人，已忽略", { action: params.action, clickerId });
        return;
      }
    }

    if (["approve", "approve_session", "reject"].includes(params.action)) {
      const decision = params.action === "approve"
        ? "accept"
        : params.action === "approve_session"
          ? "acceptForSession"
          : "decline";
      // Pass the clicker identity so the router's thread-owner check applies —
      // approval callbacks carry only the code (no threadId), so the card
      // session owner gate above never covers them. Only the typed ownership
      // rejection is swallowed; anything else (RPC timeout, connector down)
      // rethrows — the approval survives an unresolved fault, so the click
      // can simply be retried.
      try {
        await router?.resolveApproval?.(params.code, decision, identity);
      } catch (error) {
        if (error?.code !== "not_owner") {
          throw error;
        }
        this.eventLog?.warn?.("telegram 审批被拒绝：非任务发起人", {
          code: params.code,
          clickerId,
        });
        return;
      }
      const messageId = cq.message?.message_id ?? null;
      if (conversationId && messageId != null) {
        await this.resolveApprovalMessage({
          code: params.code,
          decision,
          fallback: {
            messageId,
            conversationId,
            text: cq.message?.text ?? "",
          },
        }).catch(() => {});
      }
      return;
    }
    if (params.action === "cancel") {
      await router?.cancelThread?.(params.threadId);
      return;
    }
    if (params.action === "pick") {
      if (!router || !conversationId) return;
      // M1: route under the clicker's identity (already authorized above), not the chat id.
      void this.dispatchPickAsync({ identity, selector: String(params.index), pickKind: params.pickKind, conversationId });
      return;
    }
    if (params.action === "pushfile") {
      const files = this.threadFiles.get(params.threadId);
      const file = files?.[params.fileIndex];
      const binding = router?.getThreadBinding?.(params.threadId);
      const projectPath = binding?.projectPath ?? null;
      const conv = binding?.conversationId ?? conversationId;
      if (!file || !projectPath || !conv) return;
      const safePath = resolveWithinProject(projectPath, file.path);
      if (!safePath) { this.eventLog?.warn?.("telegram 推送文件：路径越界", { path: file.path }); return; }
      const { basename } = await import("node:path");
      this.outboundQueue.enqueue({
        channel: "telegram", conversationId: conv, kind: "media",
        mediaKind: classifyMedia(safePath), path: safePath, fileName: basename(safePath),
        dedupeKey: `pushfile:${conv}:${safePath}:${Date.now()}`,
      });
      void this.deliverQueued().catch((err) => this.eventLog?.error?.("telegram 推送文件：发送失败", { error: err.message }));
    }
  }

  async dispatchPickAsync({ identity, selector, pickKind, conversationId }) {
    const router = this.adapter?.commandRouter ?? null;
    if (!router) return;
    let reply;
    try {
      reply = pickKind === "project"
        ? await router.chooseProject(identity, selector)
        : pickKind === "model"
          ? await router.chooseModel(identity, selector)
          : pickKind === "reasoning"
            ? await router.chooseReasoning(identity, selector)
            : await router.useSessionAsync(identity, selector);
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
