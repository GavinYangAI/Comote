import { BaseChannelAdapter } from "../base/adapter.js";
import { t } from "../../core/i18n/index.js";

// DingTalk inbound adapter. The shared BaseChannelAdapter owns the pipeline
// (group gate, identity, attachment download, route, enqueue semantic reply);
// this subclass only normalizes a Stream IM payload. 1:1 chats are addressed by
// senderStaffId (oToMessages batchSend userIds / card openSpaceId), so we use it
// as the conversationId.
export class DingTalkChannelAdapter extends BaseChannelAdapter {
  constructor({ commandRouter, sendReply, onDetectedIdentity = null, allowGroups = false, downloadAttachment = null, supportsMedia = null, singleMessageTurns = false }) {
    super({
      channelId: "dingtalk",
      commandRouter,
      sendReply,
      onDetectedIdentity,
      downloadAttachment,
      supportsMedia,
      allowGroups,
      singleMessageTurns,
      noProjectMessage: () => t("dingtalk.attachment.noProject"),
    });
    this.startedAt = new Date().toISOString();
  }

  getStatus() {
    return {
      id: "dingtalk",
      state: "adapter_ready",
      supports: { directMessages: true, groupMessages: this.allowGroups, cards: true },
      startedAt: this.startedAt,
    };
  }

  normalizeInbound(payload) {
    const staffId = payload.senderStaffId ?? payload.senderId ?? null;
    if (!staffId) throw new Error("DingTalk inbound payload requires senderStaffId");
    const isDirect = String(payload.conversationType) === "1";
    const msgType = payload.msgtype ?? "text";
    return {
      messageId: payload.msgId ?? null,
      // 1:1: reply target is the user (staffId). group: the open conversation id.
      conversationId: isDirect ? staffId : payload.conversationId,
      conversationType: isDirect ? "direct" : "group",
      identity: {
        channel: "dingtalk",
        stableId: staffId,
        displayName: payload.senderNick ?? staffId,
      },
      text: msgType === "text" ? (payload.text?.content ?? "") : "",
      attachments: readAttachments(msgType, payload, payload.msgId ?? null),
    };
  }
}

function readAttachments(msgType, payload, messageId) {
  const content = payload.content ?? {};
  if (msgType === "picture") {
    const code = content.downloadCode ?? content.pictureDownloadCode;
    if (!code) return [];
    return [{ type: "image", downloadCode: code, fileName: content.fileName ?? "image.png", messageId }];
  }
  if (msgType === "file") {
    if (!content.downloadCode) return [];
    return [{ type: "file", downloadCode: content.downloadCode, fileName: content.fileName ?? "file", messageId }];
  }
  return [];
}
