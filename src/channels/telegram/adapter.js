// src/channels/telegram/adapter.js
import { BaseChannelAdapter } from "../base/adapter.js";
import { t } from "../../core/i18n/index.js";

// Telegram inbound adapter. normalizeInbound shapes a Bot API update; handleInbound
// is overridden to add a pairing pre-gate BEFORE the base pipeline: an unauthorized
// sender must prove ownership by sending the pairing code (the router silently drops
// unauthorized messages, so without this an unpaired user could never bind). Once
// authorized, delegate to the base pipeline (route → enqueue semantic reply).
export class TelegramChannelAdapter extends BaseChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, downloadAttachment = null, allowGroups = false,
    isAuthorized = () => false, getPairingState = () => ({ pairingCode: null, linkedChatId: null }), onPaired = async () => {} }) {
    super({
      channelId: "telegram",
      commandRouter,
      sendReply,
      onDetectedIdentity,
      downloadAttachment,
      allowGroups,
      noProjectMessage: () => t("telegram.attachment.noProject"),
    });
    this.isAuthorized = isAuthorized;
    this.getPairingState = getPairingState;
    this.onPaired = onPaired;
    this.startedAt = new Date().toISOString();
  }

  getStatus() {
    return { id: "telegram", state: "adapter_ready", supports: { directMessages: true, groupMessages: this.allowGroups, cards: true }, startedAt: this.startedAt };
  }

  normalizeInbound(update) {
    const m = update.message ?? update.edited_message;
    if (!m) throw new Error("Telegram inbound payload requires a message");
    const from = m.from ?? {};
    const isDirect = (m.chat?.type ?? "private") === "private";
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
    return {
      messageId: m.message_id ?? null,
      conversationId: String(m.chat?.id),
      conversationType: isDirect ? "direct" : "group",
      identity: {
        channel: "telegram",
        stableId: String(from.id),
        displayName: from.username ?? (fullName || String(from.id)),
      },
      text: m.text ?? m.caption ?? "",
      attachments: readAttachments(m, m.message_id ?? null),
      accountId: String(from.id),
    };
  }

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return { kind: "ignored", reason: "group messages are disabled" };
    }
    this.onDetectedIdentity?.(message.identity);

    if (!this.isAuthorized(message.identity)) {
      const { pairingCode } = this.getPairingState();
      if (pairingCode && message.text.trim() === pairingCode) {
        await this.onPaired({ chatId: message.conversationId, identity: message.identity, displayName: message.identity.displayName });
        await this.sendReply({ channel: "telegram", conversationId: message.conversationId, kind: "text", inReplyTo: message.messageId, text: t("telegram.pair.success") });
        return { kind: "paired" };
      }
      await this.sendReply({ channel: "telegram", conversationId: message.conversationId, kind: "text", inReplyTo: message.messageId, text: t("telegram.pair.prompt", { code: pairingCode ?? "" }) });
      return { kind: "ignored", reason: "unpaired" };
    }

    // Authorized → run the shared pipeline (re-normalizes; idempotent detect).
    return super.handleInbound(payload);
  }
}

function readAttachments(m, messageId) {
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    const largest = m.photo.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
    return [{ type: "image", downloadCode: largest.file_id, fileName: "image.jpg", messageId }];
  }
  if (m.document?.file_id) {
    return [{ type: "file", downloadCode: m.document.file_id, fileName: m.document.file_name ?? "file", messageId }];
  }
  return [];
}
