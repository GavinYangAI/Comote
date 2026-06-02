import { BaseChannelAdapter } from "../base/adapter.js";
import { t } from "../../core/i18n/index.js";

// Feishu inbound adapter. The shared BaseChannelAdapter owns the pipeline
// (group gate, identity, attachment download, route, enqueue semantic reply);
// this subclass only normalizes a Feishu event payload and reports status.
// Outbound cards are no longer built here — the feishu renderer turns the
// semantic reply into a card at delivery time.
export class FeishuChannelAdapter extends BaseChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false, resolveDisplayName = null, downloadAttachment = null }) {
    super({
      channelId: "feishu",
      commandRouter,
      sendReply,
      onDetectedIdentity,
      downloadAttachment,
      allowGroups,
      noProjectMessage: () => t("feishu.attachment.noProject"),
      // Feishu message events carry only the open_id; if displayName fell back
      // to the stableId, try the injected resolver. Best effort: keep the
      // open_id on any failure.
      resolveIdentityName: async (identity) => {
        if (!resolveDisplayName || identity.displayName !== identity.stableId) {
          return;
        }
        try {
          const resolved = await resolveDisplayName(identity.stableId);
          if (resolved) {
            identity.displayName = resolved;
          }
        } catch {
          // keep the open_id
        }
      },
    });
    this.startedAt = new Date().toISOString();
  }

  getStatus() {
    return {
      id: "feishu",
      state: "adapter_ready",
      supports: {
        directMessages: true,
        groupMessages: this.allowGroups,
        cards: true,
      },
      startedAt: this.startedAt,
    };
  }

  normalizeInbound(payload) {
    const event = payload.event ?? payload;
    const message = event.message ?? {};
    const sender = event.sender ?? {};
    const senderId = sender.sender_id ?? sender.id ?? {};
    const stableId = senderId.open_id ?? senderId.user_id ?? payload.openId ?? payload.userId;
    if (!stableId) {
      throw new Error("Feishu inbound payload requires open_id or user_id");
    }

    const chatType = message.chat_type ?? payload.chatType ?? "p2p";
    const messageType = message.message_type ?? payload.messageType ?? "text";
    return {
      messageId: message.message_id ?? payload.messageId ?? null,
      conversationId: message.chat_id ?? payload.chatId ?? stableId,
      conversationType: chatType === "p2p" ? "direct" : "group",
      identity: {
        channel: "feishu",
        stableId,
        displayName: sender.name ?? payload.senderName ?? stableId,
      },
      text: (messageType === "image" || messageType === "file") ? "" : readFeishuText(message.content ?? payload.text ?? ""),
      attachments: readFeishuAttachments(messageType, message),
    };
  }
}

function readFeishuText(content) {
  if (typeof content !== "string") {
    return content.text ?? "";
  }
  try {
    return JSON.parse(content).text ?? content;
  } catch {
    return content;
  }
}

function readFeishuAttachments(messageType, message) {
  if (messageType !== "image" && messageType !== "file") {
    return [];
  }
  let content = {};
  try {
    content = typeof message.content === "string" ? JSON.parse(message.content) : message.content ?? {};
  } catch {
    return [];
  }
  if (messageType === "image") {
    if (!content.image_key) {
      return [];
    }
    return [{ type: "image", fileKey: content.image_key, fileName: content.file_name ?? "image.png", messageId: message.message_id ?? null }];
  }
  if (!content.file_key) {
    return [];
  }
  return [{ type: "file", fileKey: content.file_key, fileName: content.file_name ?? "file", messageId: message.message_id ?? null }];
}
