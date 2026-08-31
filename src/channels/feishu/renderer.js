import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { t } from "../../core/i18n/index.js";
import { textCard, statusCard, approvalCard, approvalResolvedCard, pickerCard } from "./cards.js";
import { approvalDetail } from "../base/approval-format.js";
import { globalManagerBindCard } from "./global-manager-cards.js";

// Mirror of the runtime's media size guard (FeishuRuntimeService.MAX_MEDIA_BYTES);
// kept in sync so the renderer falls back to text on the same boundary.
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// Feishu renderer: turns a channel-neutral semantic reply into a Feishu
// interactive card (or a media upload+send). Every non-media kind goes out as a
// card via driver.sendCard — matching the pre-migration behavior where command
// and agent text replies were always delivered as cards.
export function createFeishuRenderer() {
  return {
    buildStatusCard(status) {
      return statusCard(status);
    },
    pickerTitle(pickKind) {
      return t(pickKind === "project" ? "card.picker.project" : "card.picker.conversation");
    },
    async render(reply, { driver, runtime }) {
      if (reply.kind === "globalManagerCard") {
        try {
          if (!runtime?.globalManager?.canDeliverQueuedCard?.(reply)) {
            throw new Error("global manager binding is not ready for this queued card");
          }
          let result = null;
          if (reply.messageId) {
            try {
              await driver.updateCard({ messageId: reply.messageId, card: reply.card });
              result = { messageId: reply.messageId };
            } catch {
              result = await driver.sendCard({
                receiveId: reply.conversationId,
                receiveIdType: reply.receiveIdType ?? "open_id",
                card: reply.card,
              });
            }
          } else {
            result = await driver.sendCard({
              receiveId: reply.conversationId,
              receiveIdType: reply.receiveIdType ?? "open_id",
              card: reply.card,
            });
          }
          runtime?.globalManager?.handleQueuedCardDelivered?.(reply, result);
          return result;
        } catch (error) {
          runtime?.globalManager?.handleQueuedCardFailure?.(reply, error);
          throw error;
        }
      }
      if (reply.kind === "managerBind") {
        await driver.sendCard({
          receiveId: reply.conversationId,
          receiveIdType: "chat_id",
          card: globalManagerBindCard(),
        });
        return;
      }
      if (reply.kind === "media") {
        return this._renderMedia(reply, driver);
      }
      const card = this._cardFor(reply);
      await driver.sendCard({ receiveId: reply.conversationId, receiveIdType: "chat_id", card });
    },
    _cardFor(reply) {
      switch (reply.kind) {
        case "status":
          return statusCard(reply);
        case "approval":
          return approvalCard({ shortCode: reply.code, detail: approvalDetail(reply.approval) });
        case "approvalResolved":
          return approvalResolvedCard({ code: reply.code, decision: reply.decision });
        case "picker":
          return pickerCard({
            kind: reply.pickKind,
            title: this.pickerTitle(reply.pickKind),
            items: reply.items,
            text: reply.text ?? "",
          });
        case "text":
        default:
          return textCard(reply.text ?? "");
      }
    },
    // Reproduces FeishuRuntimeService._deliverMedia: stat the file, send a
    // localized text fallback when it's missing or oversize, otherwise upload
    // and send as image/file.
    async _renderMedia(reply, driver) {
      let size = 0;
      try {
        size = (await stat(reply.path)).size;
      } catch {
        await driver.sendText({
          receiveId: reply.conversationId,
          receiveIdType: "chat_id",
          text: t("feishu.media.missing", { path: reply.path }),
        });
        return;
      }
      if (size > MAX_MEDIA_BYTES) {
        await driver.sendText({
          receiveId: reply.conversationId,
          receiveIdType: "chat_id",
          text: t("feishu.media.tooLarge", {
            name: basename(reply.path),
            size: Math.round(size / 1024 / 1024),
            path: reply.path,
          }),
        });
        return;
      }
      if (reply.mediaKind === "image") {
        const imageKey = await driver.uploadImage(reply.path);
        await driver.sendImage({ receiveId: reply.conversationId, receiveIdType: "chat_id", imageKey });
      } else {
        const fileKey = await driver.uploadFile(reply.path, reply.fileName ?? basename(reply.path));
        await driver.sendFile({ receiveId: reply.conversationId, receiveIdType: "chat_id", fileKey });
      }
    },
  };
}
