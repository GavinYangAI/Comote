import { BaseChannelAdapter } from "../base/adapter.js";
import { t } from "../../core/i18n/index.js";

// Feishu inbound adapter. The shared BaseChannelAdapter owns the pipeline
// (group gate, identity, attachment download, route, enqueue semantic reply);
// this subclass only normalizes a Feishu event payload and reports status.
// Outbound cards are no longer built here — the feishu renderer turns the
// semantic reply into a card at delivery time.
export class FeishuChannelAdapter extends BaseChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false, resolveDisplayName = null, downloadAttachment = null, supportsMedia = null }) {
    super({
      channelId: "feishu",
      commandRouter,
      sendReply,
      onDetectedIdentity,
      downloadAttachment,
      supportsMedia,
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
      text: readFeishuTextForType(messageType, message.content ?? payload.text ?? ""),
      attachments: readFeishuAttachments(messageType, message),
    };
  }
}

// Routable text for an inbound message. image/file carry only a resource key
// (no text); a `post` (rich text) message — what Feishu sends when an image is
// pasted alongside text — carries both, so its text is assembled from the body.
function readFeishuTextForType(messageType, rawContent) {
  if (messageType === "image" || messageType === "file") {
    return "";
  }
  if (messageType === "post") {
    return readFeishuPost(parseFeishuContent(rawContent)).text;
  }
  return readFeishuText(rawContent);
}

function readFeishuText(content) {
  if (typeof content !== "string") {
    return typeof content?.text === "string" ? content.text : "";
  }
  try {
    const parsed = JSON.parse(content);
    // Only a genuine text field is routable. Returning the raw JSON for an
    // unrecognized type would leak image_key/file_key blobs to Codex as text.
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    // Not JSON — treat the whole thing as plain text.
    return content;
  }
}

// Walks a received `post` body (`{ title, content: [[element, ...], ...] }`),
// collecting plain text from `text`/`a` elements and resource keys from `img`
// elements (and `media` file_keys). The attachments mirror an image/file
// message's shape so the rest of the pipeline is unchanged.
function readFeishuPost(content, messageId = null) {
  const attachments = [];
  const lines = [];
  const paragraphs = Array.isArray(content?.content) ? content.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const parts = [];
    for (const element of paragraph) {
      if (element?.tag === "text" && element.text) {
        parts.push(element.text);
      } else if (element?.tag === "a" && element.text) {
        parts.push(element.href ? `${element.text}（${element.href}）` : element.text);
      } else if (element?.tag === "img" && element.image_key) {
        attachments.push({ type: "image", fileKey: element.image_key, fileName: element.file_name ?? "image.png", messageId });
      } else if (element?.tag === "media" && element.file_key) {
        attachments.push({ type: "file", fileKey: element.file_key, fileName: element.file_name ?? "file", messageId });
      }
    }
    if (parts.length > 0) {
      lines.push(parts.join(""));
    }
  }
  const title = typeof content?.title === "string" ? content.title.trim() : "";
  const text = [title, ...lines].filter(Boolean).join("\n");
  return { text, attachments };
}

function parseFeishuContent(content) {
  if (typeof content !== "string") {
    return content ?? {};
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function readFeishuAttachments(messageType, message) {
  if (messageType === "post") {
    return readFeishuPost(parseFeishuContent(message.content), message.message_id ?? null).attachments;
  }
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
