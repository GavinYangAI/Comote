export const WECHAT_CHANNEL_ID = "comote-wechat";
export const WECHAT_RUNTIME = "comote-native";
export const WECHAT_DRIVER = "tencent-ilink-json-api";

const WECHAT_INBOUND_MEDIA_NOTICE =
  "微信暂不支持把图片/文件直接发给 Codex。请改用飞书，或粘贴文本/本机路径。";

export class WeChatChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false }) {
    if (!commandRouter) {
      throw new Error("commandRouter is required");
    }
    this.commandRouter = commandRouter;
    this.sendReply = sendReply ?? noopSendReply;
    this.onDetectedIdentity = onDetectedIdentity;
    this.allowGroups = allowGroups;
    this.startedAt = new Date().toISOString();
  }

  getStatus() {
    return {
      id: "wechat",
      channelId: WECHAT_CHANNEL_ID,
      runtime: WECHAT_RUNTIME,
      driver: WECHAT_DRIVER,
      externalAgentHostRequired: false,
      state: "adapter_ready",
      supports: {
        directMessages: true,
        groupMessages: this.allowGroups,
        media: true,
      },
      startedAt: this.startedAt,
    };
  }

  normalizeInbound(payload) {
    const accountId = payload.accountId ?? payload.account?.id ?? "default";
    const peer = payload.peer ?? payload.sender ?? payload.from ?? {};
    const conversation = payload.conversation ?? payload.chat ?? {};
    const message = payload.message ?? payload;
    const peerId = peer.id ?? peer.stableId ?? payload.senderId ?? payload.fromId;
    if (!peerId) {
      throw new Error("WeChat inbound payload requires a stable peer id");
    }

    const conversationId =
      conversation.id ?? payload.conversationId ?? payload.chatId ?? `dm_${peerId}`;
    const conversationType = conversation.type ?? payload.conversationType ?? "direct";

    return {
      messageId: message.id ?? payload.messageId ?? null,
      conversationId,
      conversationType,
      accountId,
      identity: {
        channel: "wechat",
        stableId: `${accountId}:${peerId}`,
        displayName: peer.name ?? peer.displayName ?? payload.senderName ?? peerId,
      },
      text: message.text ?? message.content ?? payload.text ?? "",
      attachments: normalizeAttachments(message.attachments ?? payload.attachments ?? []),
    };
  }

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return {
        kind: "ignored",
        reason: "group messages are disabled",
      };
    }

    this.onDetectedIdentity?.(message.identity);

    // Inbound media on WeChat (AES+CDN encrypted) is not forwarded to Codex.
    // Tell the user and, when there is no accompanying text, stop here rather
    // than send an empty turn.
    if (message.attachments?.length > 0) {
      await this.sendReply({
        channel: "wechat",
        conversationId: message.conversationId,
        accountId: message.accountId,
        inReplyTo: message.messageId,
        text: WECHAT_INBOUND_MEDIA_NOTICE,
      });
      if (!message.text) {
        return { kind: "ignored", reason: "wechat inbound media is not supported" };
      }
    }

    const reply = await this.commandRouter.handleMessageAsync({
      identity: message.identity,
      text: message.text,
      attachments: message.attachments,
      conversation: {
        channel: "wechat",
        conversationId: message.conversationId,
        accountId: message.accountId,
      },
    });

    if (reply.kind === "denied") {
      return reply;
    }

    // Personal WeChat has no native attachment send path here, so a media reply
    // (/img, /file) is degraded to a descriptive text pointing at the file.
    const text = reply.media ? describeMediaFallback(reply.media) : reply.text;
    if (text) {
      await this.sendReply({
        channel: "wechat",
        conversationId: message.conversationId,
        accountId: message.accountId,
        inReplyTo: message.messageId,
        text,
      });
    }
    return reply;
  }
}

function describeMediaFallback(media) {
  const label = media.kind === "image" ? "图片" : "文件";
  return [
    `📎 已生成${label}：${media.name}`,
    `路径：${media.path}`,
    `（微信暂不支持直接发送${label}，请在飞书或电脑端查看）`,
  ].join("\n");
}

function normalizeAttachments(attachments) {
  return attachments.map((attachment) => ({
    type: attachment.type ?? attachment.kind ?? "file",
    url: attachment.url ?? null,
    path: attachment.path ?? null,
    name: attachment.name ?? attachment.filename ?? null,
    mimeType: attachment.mimeType ?? attachment.mimetype ?? null,
  }));
}

async function noopSendReply() {
  return { ok: true };
}
