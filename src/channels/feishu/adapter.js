import { textCard, pickerCard } from "./cards.js";

export class FeishuChannelAdapter {
  constructor({
    commandRouter,
    sendReply,
    onDetectedIdentity = null,
    allowGroups = false,
    resolveDisplayName = null,
    downloadAttachment = null,
  }) {
    if (!commandRouter) {
      throw new Error("commandRouter is required");
    }
    this.commandRouter = commandRouter;
    this.sendReply = sendReply ?? noopSendReply;
    this.onDetectedIdentity = onDetectedIdentity;
    this.allowGroups = allowGroups;
    this.resolveDisplayName = resolveDisplayName;
    // Injected by state.js: downloads an inbound image/file resource to a local
    // path so it can be forwarded to Codex. Null = inbound media is dropped.
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
    const { text, attachments } = readFeishuPayload(messageType, message.content ?? payload.text ?? "");
    return {
      messageId: message.message_id ?? payload.messageId ?? null,
      conversationId: message.chat_id ?? payload.chatId ?? stableId,
      conversationType: chatType === "p2p" ? "direct" : "group",
      identity: {
        channel: "feishu",
        stableId,
        displayName: sender.name ?? payload.senderName ?? stableId,
      },
      text,
      attachments,
    };
  }

  async handleInbound(payload) {
    const message = this.normalizeInbound(payload);
    if (message.conversationType !== "direct" && !this.allowGroups) {
      return { kind: "ignored", reason: "group messages are disabled" };
    }

    await this.resolveIdentityName(message.identity);
    this.onDetectedIdentity?.(message.identity);
    const attachments = await this.resolveInboundAttachments(message);
    const reply = await this.commandRouter.handleMessageAsync({
      identity: message.identity,
      text: message.text,
      attachments,
      conversation: {
        channel: "feishu",
        conversationId: message.conversationId,
      },
    });

    if (reply.kind === "denied") {
      return reply;
    }
    if (reply.text || reply.media) {
      await this.sendReplyCard({
        conversationId: message.conversationId,
        inReplyTo: message.messageId,
        reply,
      });
    }
    return reply;
  }

  // Downloads each inbound image/file resource to a local path (via the
  // injected downloadAttachment) so the router can forward it to Codex. A
  // failed or unconfigured download drops that attachment; the message still
  // routes on its text.
  async resolveInboundAttachments(message) {
    if (!message.attachments?.length || !this.downloadAttachment) {
      return message.attachments ?? [];
    }
    const resolved = [];
    for (const attachment of message.attachments) {
      if (!attachment.feishuKey) {
        resolved.push(attachment);
        continue;
      }
      try {
        const saved = await this.downloadAttachment({
          channel: "feishu",
          messageId: message.messageId,
          conversationId: message.conversationId,
          sender: message.identity,
          attachment,
        });
        if (saved?.path) {
          resolved.push({ kind: attachment.kind, path: saved.path, name: saved.name ?? attachment.name });
        }
      } catch {
        // best-effort: keep going so a failed download never blocks the message
      }
    }
    return resolved;
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
    // Media replies (/img, /file) are not cards — pass the attachment straight
    // through to the runtime, which uploads and sends it as an image/file
    // message. An explicit dedupeKey is required: the default key is built from
    // `text`, which is empty here and would collapse distinct sends.
    if (reply?.media) {
      await this.sendReply({
        channel: "feishu",
        conversationId,
        inReplyTo,
        media: reply.media,
        dedupeKey: dedupeKey ?? `feishu:media:${conversationId}:${reply.media.name}:${Date.now()}`,
      });
      return;
    }
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

// Splits an inbound Feishu message into routable text + attachments based on
// its message_type. Image/file messages carry a resource key (image_key /
// file_key); a `post` (rich text) message — what Feishu sends when an image is
// pasted alongside text — carries both text and embedded image_keys. All keys
// are downloaded to local paths later by resolveInboundAttachments.
function readFeishuPayload(messageType, rawContent) {
  const content = parseFeishuContent(rawContent);
  if (messageType === "image" && content.image_key) {
    return { text: "", attachments: [{ kind: "image", feishuKey: content.image_key, name: content.image_key }] };
  }
  if (messageType === "file" && content.file_key) {
    return {
      text: "",
      attachments: [{ kind: "file", feishuKey: content.file_key, name: content.file_name ?? content.file_key }],
    };
  }
  if (messageType === "post") {
    return readFeishuPost(content);
  }
  return { text: readFeishuText(rawContent), attachments: [] };
}

// Walks a received `post` body (`{ title, content: [[element, ...], ...] }`),
// collecting plain text from `text`/`a` elements and image_keys from `img`
// elements (and file_keys from embedded `media`). The result mirrors what an
// image/file message produces, so the rest of the pipeline is unchanged.
function readFeishuPost(content) {
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
        attachments.push({ kind: "image", feishuKey: element.image_key, name: element.image_key });
      } else if (element?.tag === "media" && element.file_key) {
        attachments.push({ kind: "file", feishuKey: element.file_key, name: element.file_name ?? element.file_key });
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

function readFeishuText(content) {
  if (typeof content !== "string") {
    return content.text ?? "";
  }
  try {
    const parsed = JSON.parse(content);
    // Only a genuine text field is routable. Returning the raw JSON for an
    // unrecognized type would leak image_key/file_key blobs to Codex as text.
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    // Not JSON — treat the whole thing as plain text.
    return content;
  }
}

async function noopSendReply() {
  return { ok: true };
}
