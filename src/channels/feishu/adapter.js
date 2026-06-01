import { textCard, pickerCard } from "./cards.js";

export class FeishuChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false, resolveDisplayName = null, downloadAttachment = null }) {
    if (!commandRouter) {
      throw new Error("commandRouter is required");
    }
    this.commandRouter = commandRouter;
    this.sendReply = sendReply ?? noopSendReply;
    this.onDetectedIdentity = onDetectedIdentity;
    this.allowGroups = allowGroups;
    this.resolveDisplayName = resolveDisplayName;
    this.downloadAttachment = downloadAttachment;
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

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return { kind: "ignored", reason: "group messages are disabled" };
    }

    await this.resolveIdentityName(message.identity);
    this.onDetectedIdentity?.(message.identity);

    let promptText = message.text;
    if (message.attachments.length > 0) {
      if (!this.downloadAttachment) {
        return { kind: "ignored", reason: "no download capability" };
      }
      const prefixes = [];
      for (const attachment of message.attachments) {
        try {
          const { relativePath } = await this.downloadAttachment({ attachment, identity: message.identity });
          prefixes.push(`[附件: ${relativePath}]`);
        } catch (error) {
          if (error.message === "NO_PROJECT") {
            await this.sendReply({
              channel: "feishu",
              conversationId: message.conversationId,
              inReplyTo: message.messageId,
              text: "收到文件，但还没打开项目。先用 /open <编号或路径> 选一个项目，再把文件发我。",
            });
            return { kind: "ignored", reason: "no project for attachment" };
          }
          // Non-NO_PROJECT download failure: skip this attachment gracefully.
        }
      }
      promptText = `${prefixes.join("\n")}\n${message.text}`.trim();
    }

    const reply = await this.commandRouter.handleMessageAsync({
      identity: message.identity,
      text: promptText,
      attachments: message.attachments,
      conversation: {
        channel: "feishu",
        conversationId: message.conversationId,
      },
    });

    if (reply.kind === "denied") {
      return reply;
    }
    if (reply.text) {
      await this.sendReplyCard({
        conversationId: message.conversationId,
        inReplyTo: message.messageId,
        reply,
      });
    }
    return reply;
  }

  async resolveIdentityName(identity) {
    // Feishu message events carry only the open_id; if displayName fell back to
    // the stableId, try the injected resolver. Best effort: keep the open_id on
    // any failure.
    if (!this.resolveDisplayName || identity.displayName !== identity.stableId) {
      return;
    }
    try {
      const resolved = await this.resolveDisplayName(identity.stableId);
      if (resolved) {
        identity.displayName = resolved;
      }
    } catch {
      // keep the open_id
    }
  }

  async sendReplyCard({ conversationId, inReplyTo = null, reply, dedupeKey = null }) {
    if (!reply?.text) {
      return;
    }
    const card = reply.picker
      ? pickerCard({
          kind: reply.picker.pickKind,
          title: pickerTitle(reply.picker.pickKind),
          items: reply.picker.items,
          text: reply.text,
        })
      : textCard(reply.text);
    await this.sendReply({
      channel: "feishu",
      conversationId,
      inReplyTo,
      text: reply.text,
      card,
      ...(dedupeKey ? { dedupeKey } : {}),
    });
  }
}

function pickerTitle(pickKind) {
  return pickKind === "project" ? "请选择项目" : "请选择对话";
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

async function noopSendReply() {
  return { ok: true };
}
