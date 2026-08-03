import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat } from "../base/approval-format.js";
import { chunkTextByLines } from "../base/chunk.js";

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
          // Per-chunk dedupeKey so the driver's deterministic idempotency key
          // engages while keeping each chunk distinct (chunks 2..N must not be
          // dropped as dupes of chunk 1). Omitted when the reply has none —
          // the driver then falls back to a random key.
          ...(reply.dedupeKey ? { dedupeKey: `${reply.dedupeKey}:${i}` } : {}),
          text: body,
        });
      }
    },
    _textFor(reply) {
      switch (reply.kind) {
        case "approval":
          return describeApprovalForChat(reply.approval, { autoApproved: reply.autoApproved });
        case "approvalResolved":
          // Resolution surfaces via the next agent reply; no extra wechat
          // message (matches current routeDesktopEvent, which only logs it).
          return "";
        case "media": {
          // WeChat can't send attachments; instead of a bare name the user can't
          // act on, surface the host path so they can open the file locally.
          const name = reply.fileName ?? reply.path;
          return name ? t("file.delivery.localPath", { name, path: reply.path }) : "";
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

// Splits a long Codex reply into chat-sized chunks. Same size/maxChunks/trim/
// truncation semantics as the original slice-every-1500 loop, but the split now
// prefers line boundaries and never cuts an emoji surrogate pair in half
// (shared chunkTextByLines — see base/chunk.js).
function chunkForChannel(text, size = 1500, maxChunks = 6) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [];
  }
  const chunks = chunkTextByLines(value, size);
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks);
    kept[maxChunks - 1] += "\n" + t("state.chunk.truncated");
    return kept;
  }
  return chunks;
}
