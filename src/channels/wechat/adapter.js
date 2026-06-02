import { BaseChannelAdapter } from "../base/adapter.js";

export const WECHAT_CHANNEL_ID = "comote-wechat";
export const WECHAT_RUNTIME = "comote-native";
export const WECHAT_DRIVER = "tencent-ilink-json-api";

// WeChat inbound adapter. The shared BaseChannelAdapter owns the pipeline
// (group gate, identity detection, route, enqueue semantic reply); this
// subclass only normalizes a raw ilink payload and reports status. WeChat has
// no attachment download and no display-name resolution.
export class WeChatChannelAdapter extends BaseChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false }) {
    super({ channelId: "wechat", commandRouter, sendReply, onDetectedIdentity, allowGroups });
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
