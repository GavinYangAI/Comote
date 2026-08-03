import { classifyMedia } from "../../core/paths.js";
import { attachmentPromptLine } from "../../core/attachment-prompt.js";
import { routerReplyToSemantic } from "./messages.js";
import { t } from "../../core/i18n/index.js";

// Classifies a download error into one of the user-facing reason buckets. The
// raw error message is NEVER shown to the user (it can carry an absolute path or
// an HTTP body); we only map it to a translated reason key so the failure is
// explained without leaking internals. UNSAFE_ATTACHMENT_PATH is the sentinel
// makeDownloadAttachment throws when the dest escapes the project root.
function classifyDownloadErrorKey(error) {
  if (error?.message === "UNSAFE_ATTACHMENT_PATH") return "cmd.attachment.reason.unsafePath";
  const code = String(error?.code ?? "");
  const message = error?.message ?? "";
  // Timeout: undici surfaces UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT /
  // UND_ERR_BODY_TIMEOUT, the socket layer surfaces ETIMEDOUT, and a wrapped
  // driver error only carries the word "timeout" in its message.
  if (code === "ETIMEDOUT" || /UND_ERR_\w*TIMEOUT/i.test(code) || /time\s*-?\s*d?\s*out/i.test(message)) {
    return "cmd.attachment.reason.timeout";
  }
  if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
    return "cmd.attachment.reason.unreadable";
  }
  // Too large: HTTP 413 (driver wraps it as "… failed: 413 …") or any "too
  // big"/"too large" wording. Telegram says "file is too big" (note the "is"),
  // so match "too" followed by "big"/"large" with words allowed in between.
  if (/\b413\b/.test(message) || /too\b.*\b(?:big|large)/i.test(message)) {
    return "cmd.attachment.reason.tooLarge";
  }
  return "cmd.attachment.reason.network";
}

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
    supportsMedia = null,
    allowGroups = false,
    noProjectMessage = null,
    beginInboundFeedback = null,
    finishInboundFeedback = null,
    singleMessageTurns = false,
  }) {
    this.channelId = channelId;
    this.commandRouter = commandRouter;
    this.sendReply = sendReply;
    this.onDetectedIdentity = onDetectedIdentity;
    this.resolveIdentityName = resolveIdentityName;
    this.downloadAttachment = downloadAttachment;
    // Whether this channel can take inbound media. The host wires the plugin's
    // EXPLICIT capabilities.media bit here (single source of truth) so the
    // "unsupported attachment" path is driven by the declaration, not inferred
    // from whether a downloadAttachment closure happens to be present. Left null
    // (e.g. a test that omits it) falls back to the presence of downloadAttachment
    // so the two stay equivalent.
    this.supportsMedia = supportsMedia ?? Boolean(downloadAttachment);
    this.allowGroups = allowGroups;
    this.noProjectMessage = noProjectMessage;
    this.beginInboundFeedback = beginInboundFeedback;
    this.finishInboundFeedback = finishInboundFeedback;
    this.singleMessageTurns = singleMessageTurns;
    // Group conversations already told "direct messages only" — one notice per
    // group, in-memory (a restart re-noticing once is acceptable), FIFO-capped
    // so an adapter that sees many groups can't grow this without bound.
    this._groupNoticeSent = new Set();
    this._groupNoticeMax = 200;
  }

  _noProjectText() {
    if (typeof this.noProjectMessage === "function") return this.noProjectMessage();
    if (typeof this.noProjectMessage === "string") return this.noProjectMessage;
    return "收到文件，但还没打开项目。先用 /open 选一个项目，再把文件发我。";
  }

  // Sends a plain-text reply back into the conversation a normalized message
  // came from, through the channel's sendReply (the shared outbound queue).
  async _reply(message, text) {
    await this.sendReply({
      channel: this.channelId,
      conversationId: message.conversationId,
      kind: "text",
      inReplyTo: message.messageId,
      text,
    });
  }

  // Subclasses MUST override.
  normalizeInbound(payload) {
    throw new Error("normalizeInbound not implemented");
  }

  // Ignores a group message on a groups-disabled channel — but tells the group
  // WHY, once. Silence here reads as a dead bot to anyone who @-mentions it; one
  // "direct messages only" notice per group explains it without letting repeat
  // messages spam the room. Best-effort: a notice failure must not break the
  // ignore result. Shared by the base pipeline and subclass overrides (telegram).
  async _ignoreGroupMessage(message) {
    const groupId = message.conversationId;
    if (groupId && !this._groupNoticeSent.has(groupId)) {
      this._groupNoticeSent.add(groupId);
      if (this._groupNoticeSent.size > this._groupNoticeMax) {
        this._groupNoticeSent.delete(this._groupNoticeSent.values().next().value);
      }
      try {
        await this._reply(message, t("cmd.group.onlyDirect"));
      } catch {
        // best effort — the group stays ignored either way
      }
    }
    return { kind: "ignored", reason: "group messages are disabled" };
  }

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return this._ignoreGroupMessage(message);
    }
    await this.resolveIdentityName?.(message.identity);
    this.onDetectedIdentity?.(message.identity);

    let feedback = null;
    try {
      const isAuthorized = this.commandRouter?.authorization?.isAuthorized;
      const mayAcknowledge = typeof isAuthorized !== "function"
        || isAuthorized.call(this.commandRouter.authorization, message.identity);
      feedback = mayAcknowledge
        ? await this.beginInboundFeedback?.(message) ?? null
        : null;
    } catch {
      // An acknowledgement reaction is optional UI feedback. It must never
      // prevent the actual user message from reaching the command router.
    }

    let result = null;
    try {
      result = await this._handleRoutableMessage(message);
      return result;
    } finally {
      try {
        await this.finishInboundFeedback?.({
          feedback,
          message,
          threadId: result?.startedThreadId ?? null,
        });
      } catch {
        // Removing/binding optional feedback is best-effort for the same reason.
      }
    }
  }

  async _handleRoutableMessage(message) {

    let promptText = message.text;
    let attachments = message.attachments;
    if (message.attachments?.length > 0) {
      // A channel that doesn't support media (wechat — capabilities.media=0)
      // can't fetch the file. We still must not lose the user's caption: an image
      // sent with "修一下截图里的 bug" carries a real instruction in its text. If
      // there's non-empty text, route the text alone and warn the image was
      // dropped (the caption survives). Only a pure image with no caption is a
      // dead end — reply unsupported and don't submit an empty/no-image turn.
      if (!this.supportsMedia) {
        if (message.text?.trim()) {
          await this._reply(message, t("cmd.attachment.imageDroppedTextKept"));
          promptText = message.text;
          attachments = [];
        } else {
          await this._reply(message, t("cmd.attachment.unsupportedChannel"));
          return { kind: "ignored", reason: "channel does not support attachment download" };
        }
      } else {
        const prefixes = [];
        const failures = [];
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
              await this._reply(message, this._noProjectText());
              return { kind: "ignored", reason: "no project for attachment" };
            }
            // Every other download error used to be silently skipped. Collect the
            // file name + a classified reason so we can report it back instead of
            // dropping the attachment without a trace. Other attachments keep going.
            failures.push({
              name: attachment.fileName ?? attachment.name ?? "file",
              reason: t(classifyDownloadErrorKey(error)),
            });
          }
        }
        promptText = `${prefixes.join("\n")}\n${message.text}`.trim();

        if (failures.length > 0) {
          // One coalesced failure reply (never one-per-attachment) so a batch of
          // failures can't spam the chat. Names + reasons only, no raw error text
          // (the raw message can carry an absolute path or an HTTP body).
          const details = failures.map((f) => `${f.name} (${f.reason})`).join("; ");
          await this._reply(message, t("cmd.attachment.downloadFailed", { details }));
        }

        // Empty-turn guard: if nothing downloaded AND the user typed no text, the
        // turn would be an empty no-image prompt — don't submit it. Tell the user
        // their images never arrived instead of sending Codex a blank turn.
        if (attachments.length === 0 && !message.text?.trim()) {
          await this._reply(message, t("cmd.attachment.allFailed"));
          return { kind: "ignored", reason: "all attachments failed to download" };
        }
      }
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
    const oneMessageMode = typeof this.singleMessageTurns === "function"
      ? this.singleMessageTurns()
      : this.singleMessageTurns;
    const redundantLiveReply = oneMessageMode
      && (reply?.startedThreadId || reply?.approvalResolution);
    if (semantic && !redundantLiveReply) {
      await this.sendReply(semantic);
    }
    return reply ?? { kind: "ignored" };
  }

  // Last-resort fallback when handleInbound throws (called by the runtime). A
  // direct (private) message gets one generic error reply so the sender isn't
  // left in silence; group messages stay quiet (we don't spam a room on a
  // backend hiccup). This MUST NOT throw — it's the catch-all error path — so
  // normalize/sendReply failures are swallowed.
  async handleInboundFailure(payload, _error) {
    try {
      const message = this.normalizeInbound(payload);
      if (message.conversationType !== "direct") return;
      await this._reply(message, t("cmd.error.inboundFailed"));
    } catch {
      // The error path itself failed (bad payload, sendReply threw) — give up
      // silently; the runtime has already logged the original error.
    }
  }
}
