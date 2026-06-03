// src/channels/dingtalk/renderer.js
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat, approvalDetail } from "../base/approval-format.js";
import {
  toParamMap,
  approvalCardData,
  pickerCardData,
  statusCardData,
} from "./cards.js";

// Image ≤1MB / file ≤10MB on DingTalk; degrade to text past the file ceiling.
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

// DingTalk renderer. Interactive kinds (approval/picker) render as a card when a
// template id is configured, else degrade to markdown text (so the channel works
// before templates are set up). `templates` = { approval, status, picker } card ids.
export function createDingTalkRenderer({ templates = {} } = {}) {
  return {
    templates,

    // Used by the runtime/routeDesktopEvent live status card (Part B).
    buildStatusCard(status) {
      const raw = statusCardData(status);
      return toParamMap({ title: raw.title, body: raw.body, steps: raw.steps, done: raw.done });
    },

    pickerTitle(pickKind) {
      return t(pickKind === "project" ? "card.picker.project" : "card.picker.conversation");
    },

    async render(reply, { driver }) {
      switch (reply.kind) {
        case "media":
          return this._renderMedia(reply, driver);
        case "approval":
          return this._renderApproval(reply, driver);
        case "picker":
          return this._renderPicker(reply, driver);
        case "approvalResolved":
          return; // silent: handled by the card callback PUT / next agent reply
        case "status":
        case "text":
        default: {
          const text = reply.text ?? "";
          if (!text) return;
          await driver.sendMarkdown({ receiveId: reply.conversationId, title: "Codex", text });
        }
      }
    },

    async _renderApproval(reply, driver) {
      if (!this.templates.approval) {
        await driver.sendMarkdown({
          receiveId: reply.conversationId,
          title: t("card.approval.title", { code: reply.code }),
          text: describeApprovalForChat(reply.approval),
        });
        return;
      }
      const data = approvalCardData({ shortCode: reply.code, detail: approvalDetail(reply.approval) });
      await driver.createCard({
        cardTemplateId: this.templates.approval,
        outTrackId: `approval:${reply.code}:${randomUUID()}`,
        receiveId: reply.conversationId,
        cardParamMap: toParamMap({
          title: data.title,
          detail: data.detail,
          approveLabel: data.approveLabel,
          rejectLabel: data.rejectLabel,
          approveParams: data.approveParams,
          rejectParams: data.rejectParams,
        }),
      });
    },

    async _renderPicker(reply, driver) {
      if (!this.templates.picker) {
        const lines = (reply.items ?? []).map((it) => `${it.index}. ${it.label}`);
        const text = [reply.text, ...lines, t("dingtalk.picker.replyHint")].filter(Boolean).join("\n");
        await driver.sendMarkdown({ receiveId: reply.conversationId, title: this.pickerTitle(reply.pickKind), text });
        return;
      }
      const data = pickerCardData({
        pickKind: reply.pickKind,
        title: this.pickerTitle(reply.pickKind),
        text: reply.text ?? "",
        items: reply.items ?? [],
        conversationId: reply.conversationId,
      });
      await driver.createCard({
        cardTemplateId: this.templates.picker,
        outTrackId: `picker:${reply.pickKind}:${randomUUID()}`,
        receiveId: reply.conversationId,
        cardParamMap: toParamMap(data),
      });
    },

    async _renderMedia(reply, driver) {
      let size = 0;
      try {
        size = (await stat(reply.path)).size;
      } catch {
        await driver.sendText({ receiveId: reply.conversationId, text: t("dingtalk.media.missing", { path: reply.path }) });
        return;
      }
      if (size > MAX_MEDIA_BYTES) {
        await driver.sendText({
          receiveId: reply.conversationId,
          text: t("dingtalk.media.tooLarge", { name: basename(reply.path), size: Math.round(size / 1024 / 1024), path: reply.path }),
        });
        return;
      }
      if (reply.mediaKind === "image") {
        const mediaId = await driver.uploadMedia(reply.path, "image");
        await driver.sendImage({ receiveId: reply.conversationId, mediaId });
      } else {
        const mediaId = await driver.uploadMedia(reply.path, "file");
        const fileName = reply.fileName ?? basename(reply.path);
        await driver.sendFile({ receiveId: reply.conversationId, mediaId, fileName, fileType: extname(fileName).replace(/^\./, "") || "bin" });
      }
    },
  };
}
