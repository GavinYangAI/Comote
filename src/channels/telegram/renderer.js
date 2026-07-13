// src/channels/telegram/renderer.js
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat } from "../base/approval-format.js";
import { approvalKeyboard, pickerKeyboard, cancelKeyboard, filesKeyboard, statusText, chunkMessage } from "./cards.js";

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
      return { text: statusText(status), replyMarkup };
    },

    async render(reply, { driver }) {
      switch (reply.kind) {
        case "media":
          return this._renderMedia(reply, driver);
        case "approval":
          return driver.sendMessage({
            chatId: reply.conversationId,
            text: describeApprovalForChat(reply.approval),
            replyMarkup: approvalKeyboard(reply.code),
          });
        case "picker":
          return this._renderPicker(reply, driver);
        case "approvalResolved":
          return; // silent: handled by the callback_query
        case "status":
        case "text":
        default: {
          const text = reply.text ?? "";
          if (!text) return;
          // Telegram hard-caps messages at 4096 chars and rejects longer ones
          // with a 400 — after the outbound queue's retries that reply would be
          // dropped for good. Chunk like _sendChunked does, with room reserved
          // for the "(i/n)\n" prefix.
          const chunks = chunkMessage(text, 4096 - 16);
          for (let i = 0; i < chunks.length; i += 1) {
            const body = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
            await driver.sendMessage({ chatId: reply.conversationId, text: body });
          }
        }
      }
    },

    async _renderPicker(reply, driver) {
      const items = reply.items ?? [];
      if (items.length === 0) {
        const text = [reply.text, t("telegram.picker.replyHint")].filter(Boolean).join("\n");
        await driver.sendMessage({ chatId: reply.conversationId, text });
        return;
      }
      await driver.sendMessage({
        chatId: reply.conversationId,
        text: reply.text || t(reply.pickKind === "project" ? "card.picker.project" : "card.picker.conversation"),
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
