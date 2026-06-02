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
  // denied/ignored are never delivered: the existing adapters suppress the
  // repeat "not authorized" denial so an unconfirmed user isn't spammed. Welcome
  // and notice results (first-contact) use kind "notice"/"error" and DO carry
  // text, so they fall through to the text branch below and are sent.
  if (reply.kind === "denied" || reply.kind === "ignored") {
    return null;
  }
  if (typeof reply.text === "string" && reply.text.length > 0) {
    return { ...base, kind: "text", text: reply.text };
  }
  return null;
}
