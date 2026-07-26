// src/channels/dingtalk/renderer.js
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { t } from "../../core/i18n/index.js";
import { describeApprovalForChat, approvalDetail } from "../base/approval-format.js";
import { chunkTextByLines } from "../base/chunk.js";
import {
  toParamMap,
  approvalCardData,
  pickerCardData,
  statusCardData,
} from "./cards.js";

// DingTalk's upload API caps images at ~1MB but allows larger generic files, so
// each media kind needs its own ceiling (mirrors telegram's per-kind limits). A
// 1-10MB image must degrade to the tooLarge notice instead of failing at the API.
export const MAX_IMAGE_BYTES = 1 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Back-compat alias for the previous single ceiling (the file limit).
export const MAX_MEDIA_BYTES = MAX_FILE_BYTES;

// DingTalk's markdown payload has a length limit; a long reply that exceeds it
// fails permanently after retries. Chunk long text into chat-sized pieces before
// sendMarkdown (mirrors WeChat's chunkForChannel).
const MARKDOWN_CHUNK_SIZE = 1500;
const MARKDOWN_MAX_CHUNKS = 6;

// DingTalk renderer. Interactive kinds (approval/picker) render as a card when a
// template id is configured, else degrade to markdown text (so the channel works
// before templates are set up). `templates` = { approval, status, picker } card ids.
export function createDingTalkRenderer({ templates = {} } = {}) {
  return {
    templates,

    // Used by the runtime/routeDesktopEvent live status card (Part B). Forwards the
    // cancel affordance too: cancelParams is null on a done card (→ "" via toParamMap),
    // so the template's cancel button only carries working params while in-flight.
    buildStatusCard(status) {
      const raw = statusCardData(status);
      return toParamMap({
        title: raw.title,
        body: raw.body,
        steps: raw.steps,
        done: raw.done,
        cancelLabel: raw.cancelLabel,
        cancelParams: raw.cancelParams,
        approvalVisible: false,
        detail: "",
        approveLabel: "",
        sessionLabel: "",
        rejectLabel: "",
        approveParams: null,
        sessionParams: null,
        rejectParams: null,
      });
    },

    buildApprovalCard({ code, approval, autoApproved = false }) {
      const data = approvalCardData({ shortCode: code, detail: approvalDetail(approval) });
      const approvalText = describeApprovalForChat(approval, { autoApproved });
      return toParamMap({
        title: data.title,
        body: approvalText,
        steps: autoApproved ? t("state.approval.autoApproved") : "",
        done: false,
        cancelLabel: "",
        cancelParams: null,
        approvalVisible: !autoApproved,
        detail: approvalText,
        approveLabel: autoApproved ? "" : data.approveLabel,
        sessionLabel: autoApproved ? "" : data.sessionLabel,
        rejectLabel: autoApproved ? "" : data.rejectLabel,
        approveParams: autoApproved ? null : data.approveParams,
        sessionParams: autoApproved ? null : data.sessionParams,
        rejectParams: autoApproved ? null : data.rejectParams,
      });
    },

    pickerTitle(pickKind) {
      return t(pickKind === "project" ? "card.picker.project" : "card.picker.conversation");
    },

    async render(reply, { driver, runtime = null }) {
      switch (reply.kind) {
        case "media":
          return this._renderMedia(reply, driver);
        case "approval":
          return this._renderApproval(reply, driver, runtime);
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
          // Long replies exceed DingTalk's markdown payload limit and fail
          // permanently after retries; chunk before sending so each piece fits.
          const chunks = chunkForChannel(text);
          for (let i = 0; i < chunks.length; i += 1) {
            const body = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunks[i]}` : chunks[i];
            await driver.sendMarkdown({ receiveId: reply.conversationId, title: "Codex", text: body });
          }
        }
      }
    },

    async _renderApproval(reply, driver, runtime = null) {
      if (reply.autoApproved || !this.templates.approval) {
        await driver.sendMarkdown({
          receiveId: reply.conversationId,
          title: t("card.approval.title", { code: reply.code }),
          text: describeApprovalForChat(reply.approval, { autoApproved: reply.autoApproved }),
        });
        return;
      }
      const data = approvalCardData({ shortCode: reply.code, detail: approvalDetail(reply.approval) });
      const outTrackId = `approval:${reply.code}:${randomUUID()}`;
      const result = await driver.createCard({
        cardTemplateId: this.templates.approval,
        outTrackId,
        receiveId: reply.conversationId,
        cardParamMap: toParamMap({
          title: data.title,
          detail: data.detail,
          approveLabel: data.approveLabel,
          sessionLabel: data.sessionLabel,
          rejectLabel: data.rejectLabel,
          approveParams: data.approveParams,
          sessionParams: data.sessionParams,
          rejectParams: data.rejectParams,
        }),
      });
      runtime?.rememberApprovalMessage?.(reply.code, {
        outTrackId: result?.outTrackId ?? outTrackId,
        conversationId: reply.conversationId,
        approval: reply.approval,
      });
      return result;
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
      const isImage = reply.mediaKind === "image";
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (size > limit) {
        await driver.sendText({
          receiveId: reply.conversationId,
          text: t("dingtalk.media.tooLarge", { name: basename(reply.path), size: Math.round(size / 1024 / 1024), path: reply.path }),
        });
        return;
      }
      if (isImage) {
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

// Splits a long reply into chat-sized chunks (mirrors WeChat's chunkForChannel):
// past MARKDOWN_MAX_CHUNKS the tail is truncated with a "see full transcript
// locally" notice so the message still fits DingTalk's markdown payload limit.
// DingTalk renders the payload as markdown, so the split is fence-aware: a break
// inside a ``` code block closes the fence on the current chunk and reopens it on
// the next, keeping every chunk valid markdown (shared chunkTextByLines).
function chunkForChannel(text, size = MARKDOWN_CHUNK_SIZE, maxChunks = MARKDOWN_MAX_CHUNKS) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [];
  }
  const chunks = chunkTextByLines(value, size, { fenceAware: true });
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks);
    kept[maxChunks - 1] += "\n" + t("state.chunk.truncated");
    return kept;
  }
  return chunks;
}
