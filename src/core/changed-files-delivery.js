import { buildFileDeliveries } from "./file-delivery.js";
import { t } from "./i18n/index.js";

// Splits a turn's changed files into three buckets for the completion handler:
//   inlineReplies     — text replies to enqueue right away (small text files,
//                        or a single "too many" notice)
//   buttonFiles       — files to render as clickable buttons on the status card
//                        (channels with capabilities.fileButtons)
//   attachmentReplies — media/text replies to enqueue (channels without buttons,
//                        e.g. dingtalk: the "rest" is auto-sent as attachments)
// `files` is buildChangedFiles output: [{ path, name }]. Reads files via
// buildFileDeliveries to tell small-inline-able text from larger/binary.
export async function planChangedFileDelivery(files, { maxButtons = 3, supportsButtons = false } = {}) {
  const inlineReplies = [];
  const buttonFiles = [];
  const attachmentReplies = [];
  if (!Array.isArray(files) || files.length === 0) {
    return { inlineReplies, buttonFiles, attachmentReplies };
  }

  if (files.length > maxButtons) {
    if (supportsButtons) {
      return { inlineReplies, buttonFiles: [...files], attachmentReplies };
    }
    const names = files.map((f) => f.name).join(", ");
    inlineReplies.push({ kind: "text", text: t("changedFiles.tooMany", { count: files.length, names }) });
    return { inlineReplies, buttonFiles, attachmentReplies };
  }

  for (const f of files) {
    const deliveries = await buildFileDeliveries({ path: f.path, fileName: f.name });
    const isSmallTextInline = deliveries.length === 1 && deliveries[0].kind === "text";
    if (isSmallTextInline) {
      inlineReplies.push(deliveries[0]);
    } else if (supportsButtons) {
      buttonFiles.push(f);
    } else {
      attachmentReplies.push(...deliveries);
    }
  }
  return { inlineReplies, buttonFiles, attachmentReplies };
}
