import { classifyMedia } from "../../core/paths.js";
import { attachmentPromptLine } from "../../core/attachment-prompt.js";
import { routerReplyToSemantic } from "./messages.js";

// Shared inbound pipeline for every channel: normalize → group-gate → detect
// identity → optional attachment download → route to commandRouter → enqueue a
// semantic reply. Subclasses implement only normalizeInbound(payload).
export class BaseChannelAdapter {
  constructor({
    channelId,
    commandRouter,
    sendReply,
    onDetectedIdentity = null,
    resolveIdentityName = null,
    downloadAttachment = null,
    allowGroups = false,
    noProjectMessage = null,
  }) {
    this.channelId = channelId;
    this.commandRouter = commandRouter;
    this.sendReply = sendReply;
    this.onDetectedIdentity = onDetectedIdentity;
    this.resolveIdentityName = resolveIdentityName;
    this.downloadAttachment = downloadAttachment;
    this.allowGroups = allowGroups;
    this.noProjectMessage = noProjectMessage;
  }

  _noProjectText() {
    if (typeof this.noProjectMessage === "function") return this.noProjectMessage();
    if (typeof this.noProjectMessage === "string") return this.noProjectMessage;
    return "收到文件，但还没打开项目。先用 /open 选一个项目，再把文件发我。";
  }

  // Subclasses MUST override.
  normalizeInbound(payload) {
    throw new Error("normalizeInbound not implemented");
  }

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return { kind: "ignored", reason: "group messages are disabled" };
    }
    await this.resolveIdentityName?.(message.identity);
    this.onDetectedIdentity?.(message.identity);

    let promptText = message.text;
    let attachments = message.attachments;
    if (message.attachments?.length > 0 && this.downloadAttachment) {
      const prefixes = [];
      attachments = [];
      for (const attachment of message.attachments) {
        try {
          const { relativePath } = await this.downloadAttachment({ attachment, identity: message.identity });
          const kind = attachment.kind ?? classifyMedia(relativePath);
          // Images keep a bare path reference (pixels are forwarded separately as
          // a multimodal input by the command router); every other file type gets
          // an explicit instruction so Codex actually opens it from the project.
          prefixes.push(attachmentPromptLine({ relativePath, kind }));
          // Stamp the downloaded local path + media kind so the command router
          // can forward image attachments to Codex as real images (localImage /
          // --image) instead of only referencing them in the prompt text.
          attachments.push({ ...attachment, localPath: relativePath, kind });
        } catch (error) {
          if (error.message === "NO_PROJECT") {
            await this.sendReply({
              channel: this.channelId,
              conversationId: message.conversationId,
              kind: "text",
              inReplyTo: message.messageId,
              text: this._noProjectText(),
            });
            return { kind: "ignored", reason: "no project for attachment" };
          }
          // other download errors: skip this attachment, keep routing
        }
      }
      promptText = `${prefixes.join("\n")}\n${message.text}`.trim();
    }

    const reply = await this.commandRouter.handleMessageAsync({
      identity: message.identity,
      text: promptText,
      attachments,
      conversation: {
        channel: this.channelId,
        conversationId: message.conversationId,
        ...(message.accountId ? { accountId: message.accountId } : {}),
      },
    });

    const semantic = routerReplyToSemantic(reply, {
      channel: this.channelId,
      conversationId: message.conversationId,
      accountId: message.accountId,
      inReplyTo: message.messageId,
    });
    if (semantic) {
      await this.sendReply(semantic);
    }
    return reply ?? { kind: "ignored" };
  }
}
