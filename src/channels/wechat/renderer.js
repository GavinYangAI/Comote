import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat } from "../base/approval-format.js";

// WeChat is text-only — no cards, no media. The renderer degrades every
// semantic reply kind to plain text; the final agent reply is chunked into
// chat-sized pieces (chunking moved out of server/state.js; A12 deletes the
// original there and enqueues a single semantic text reply so this owns it).
export function createWeChatRenderer() {
  return {
    async render(reply, { driver }) {
      const text = this._textFor(reply);
      if (!text) return;
      const chunks = chunkForChannel(text);
      for (let i = 0; i < chunks.length; i += 1) {
        const body = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
        await driver.sendText({
          conversationId: reply.conversationId,
          ...(reply.accountId ? { accountId: reply.accountId } : {}),
          ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
          text: body,
        });
      }
    },
    _textFor(reply) {
      switch (reply.kind) {
        case "approval":
          return describeApprovalForChat(reply.approval);
        case "approvalResolved":
          // Resolution surfaces via the next agent reply; no extra wechat
          // message (matches current routeDesktopEvent, which only logs it).
          return "";
        case "media": {
          // Media is feishu-gated; locale-neutral safety net if one slips through.
          const name = reply.fileName ?? reply.path;
          return name ? `📎 ${name}` : "";
        }
        case "status":
        case "picker":
        case "text":
        default:
          return reply.text ?? "";
      }
    },
  };
}

// Splits a long Codex reply into chat-sized chunks. Kept verbatim from
// server/state.js (same size/maxChunks/trim/truncation key/slice loop).
function chunkForChannel(text, size = 1500, maxChunks = 6) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [];
  }
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks);
    kept[maxChunks - 1] += "\n" + t("state.chunk.truncated");
    return kept;
  }
  return chunks;
}
