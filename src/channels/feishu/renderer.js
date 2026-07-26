import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { t } from "../../core/i18n/index.js";
import { textCard, statusCard, approvalCard, pickerCard } from "./cards.js";
import { approvalDetail } from "../base/approval-format.js";

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
    buildApprovalCard({ code, approval, autoApproved = false }) {
      return approvalCard({
        shortCode: code,
        detail: approvalDetail(approval),
        autoApproved,
      });
    },
    pickerTitle(pickKind) {
      return t(pickKind === "project" ? "card.picker.project" : "card.picker.conversation");
    },
    async render(reply, { driver, runtime = null }) {
      if (reply.kind === "media") {
        return this._renderMedia(reply, driver);
      }
      if (reply.kind === "approvalResolved") {
        return runtime?.resolveApprovalMessage?.({
          code: reply.code,
          decision: reply.decision,
          approval: reply.approval,
        });
      }
      const card = this._cardFor(reply);
      const result = await driver.sendCard({ receiveId: reply.conversationId, receiveIdType: "chat_id", card });
      if (reply.kind === "approval" && result?.messageId) {
        runtime?.rememberApprovalMessage?.(reply.code, {
          messageId: result.messageId,
          conversationId: reply.conversationId,
          approval: reply.approval,
        });
      }
      return result;
    },
    _cardFor(reply) {
      switch (reply.kind) {
        case "status":
          return statusCard(reply);
        case "approval":
          return approvalCard({
            shortCode: reply.code,
            detail: approvalDetail(reply.approval),
            autoApproved: reply.autoApproved,
          });
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
