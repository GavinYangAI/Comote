// Channel-neutral semantic outbound messages. The router/desktop layer produces
// these; each channel's renderer turns them into native form (cards, inline
// keyboards, plain text) or degrades by capability.
export const REPLY_KINDS = ["text", "status", "approval", "approvalResolved", "picker", "media"];

export function isReplyKind(kind) {
  return REPLY_KINDS.includes(kind);
}

// Maps a commandRouter.handleMessageAsync() result into a semantic reply object
// addressed to a conversation, or null if there is nothing user-facing to send.
export function routerReplyToSemantic(reply, target) {
  if (!reply) {
    return null;
  }
  const base = {
    channel: target.channel,
    conversationId: target.conversationId,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.inReplyTo ? { inReplyTo: target.inReplyTo } : {}),
  };
  if (reply.picker) {
    return { ...base, kind: "picker", pickKind: reply.picker.pickKind, items: reply.picker.items, text: reply.text ?? "" };
  }
  if (reply.kind === "ignored" || reply.kind === "denied") {
    return reply.text ? { ...base, kind: "text", text: reply.text } : null;
  }
  if (typeof reply.text === "string" && reply.text.length > 0) {
    return { ...base, kind: "text", text: reply.text };
  }
  return null;
}
