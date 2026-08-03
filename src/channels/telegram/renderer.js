// src/channels/telegram/renderer.js
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat } from "../base/approval-format.js";
import { approvalKeyboard, pickerKeyboard, cancelKeyboard, filesKeyboard, statusHtml, statusText, chunkMessage, markdownToTelegramHtml } from "./cards.js";

// Telegram: photos ≤10MB via sendPhoto, documents ≤50MB via sendDocument; degrade
// past the ceiling. Telegram natively supports inline keyboards, so approval/picker
// always render as buttons (no template gating like dingtalk) — the message body
// still carries the text so the info survives even if buttons are ignored.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function createTelegramRenderer() {
  return {
    // Used by routeDesktopEvent live status card via the runtime.
    buildStatusCard(status) {
      const cancellable = status.threadId && !status.done;
      let replyMarkup = cancellable ? cancelKeyboard(status.threadId) : null;
      if (status.done && status.threadId && status.files?.length) {
        replyMarkup = filesKeyboard(status.threadId, status.files);
      }
      return {
        text: statusHtml(status),
        plainText: statusText(status),
        parseMode: "HTML",
        replyMarkup,
      };
    },

    buildApprovalCard({ code, approval, autoApproved = false }) {
      return {
        text: describeApprovalForChat(approval, { autoApproved }),
        replyMarkup: autoApproved ? null : approvalKeyboard(code),
      };
    },

    async render(reply, { driver, runtime = null }) {
      switch (reply.kind) {
        case "media":
          return this._renderMedia(reply, driver);
        case "approval": {
          const text = describeApprovalForChat(reply.approval, { autoApproved: reply.autoApproved });
          const result = await driver.sendMessage({
            chatId: reply.conversationId,
            text,
            ...(reply.autoApproved ? {} : { replyMarkup: approvalKeyboard(reply.code) }),
          });
          if (result?.message_id != null) {
            runtime?.rememberApprovalMessage?.(reply.code, {
              messageId: result.message_id,
              conversationId: reply.conversationId,
              approval: reply.approval,
              text,
            });
          }
          return result;
        }
        case "picker":
          return this._renderPicker(reply, driver);
        case "approvalResolved":
          return runtime?.resolveApprovalMessage?.({
            code: reply.code,
            decision: reply.decision,
            approval: reply.approval,
          });
        case "status":
        case "text":
        default: {
          const text = reply.text ?? "";
          if (!text) return;
          // Telegram hard-caps messages at 4096 chars and rejects longer ones
          // with a 400 — after the outbound queue's retries that reply would be
          // dropped for good. Chunk like _sendChunked does, with room reserved
          // for the "(i/n)\n" prefix. Each chunk is sent as parse_mode=HTML
          // (Codex markdown coarsely converted: **bold** / `code` / ```pre```);
          // if Telegram rejects the entities, the SAME chunk is resent as plain
          // text — formatting must never cost a message.
          const chunks = chunkMessage(text, 4096 - 16);
          for (let i = 0; i < chunks.length; i += 1) {
            const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
            await this._sendFormatted(driver, reply.conversationId, prefix, chunks[i]);
          }
        }
      }
    },

    // Sends one chunk as HTML, degrading to the raw plain text when Telegram
    // rejects the entity markup (400 "can't parse entities"). Any other error
    // (network, chat not found, …) propagates so the outbound queue retries.
    async _sendFormatted(driver, chatId, prefix, rawChunk) {
      const html = markdownToTelegramHtml(rawChunk);
      try {
        await driver.sendMessage({ chatId, text: `${prefix}${html}`, parseMode: "HTML" });
      } catch (error) {
        const parseRejected = error?.code === 400 && /can't parse entities/i.test(error?.message ?? "");
        if (!parseRejected) throw error;
        await driver.sendMessage({ chatId, text: `${prefix}${rawChunk}` });
      }
    },

    async _renderPicker(reply, driver) {
      const items = reply.items ?? [];
      if (items.length === 0) {
        const text = [reply.text, t("telegram.picker.replyHint")].filter(Boolean).join("\n");
        await driver.sendMessage({ chatId: reply.conversationId, text });
        return;
      }
      const titleKey = reply.pickKind === "project"
        ? "card.picker.project"
        : reply.pickKind === "model"
          ? "card.picker.model"
          : reply.pickKind === "reasoning"
            ? "card.picker.reasoning"
            : "card.picker.conversation";
      await driver.sendMessage({
        chatId: reply.conversationId,
        text: reply.text || t(titleKey),
        replyMarkup: pickerKeyboard(reply.pickKind, items),
      });
    },

    async _renderMedia(reply, driver) {
      let size = 0;
      try {
        size = (await stat(reply.path)).size;
      } catch {
        await driver.sendMessage({ chatId: reply.conversationId, text: t("telegram.media.missing", { path: reply.path }) });
        return;
      }
      const isImage = reply.mediaKind === "image";
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (size > limit) {
        await driver.sendMessage({
          chatId: reply.conversationId,
          text: t("telegram.media.tooLarge", { name: basename(reply.path), size: Math.round(size / 1024 / 1024), path: reply.path }),
        });
        return;
      }
      if (isImage) {
        await driver.sendPhoto({ chatId: reply.conversationId, path: reply.path });
      } else {
        await driver.sendDocument({ chatId: reply.conversationId, path: reply.path, fileName: reply.fileName ?? basename(reply.path) });
      }
    },
  };
}
