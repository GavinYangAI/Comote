import { stat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { classifyFile } from "./paths.js";
import { t } from "./i18n/index.js";

// Inline ceiling for text files. Past either bound the text is truncated and
// (for delivery) the full file is appended as an attachment.
export const MAX_INLINE_LINES = 300;
export const MAX_INLINE_BYTES = 12 * 1024;

// Given a project-fenced absolute path, produce the reply fragments to enqueue.
// Fragments carry NO channel/conversationId — the caller addresses them. Reply
// kinds are the existing "text" and "media" (no new kind).
export async function buildFileDeliveries({ path, fileName }) {
  const name = fileName ?? basename(path);
  try {
    await stat(path);
  } catch {
    return [{ kind: "text", text: t("file.delivery.missing", { path }) }];
  }

  const kind = classifyFile(path);

  if (kind === "text") {
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return [{ kind: "text", text: t("file.delivery.readError", { path }) }];
    }
    const { text, truncated } = truncateText(content);
    const inline = renderInline(name, text, truncated);
    const replies = [{ kind: "text", text: inline }];
    if (truncated) {
      // Give the user the complete file too; channels without media degrade it.
      replies.push({ kind: "media", mediaKind: "file", path, fileName: name });
    }
    return replies;
  }

  return [{ kind: "media", mediaKind: kind === "image" ? "image" : "file", path, fileName: name }];
}

function truncateText(content) {
  let text = content;
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > MAX_INLINE_LINES) {
    text = lines.slice(0, MAX_INLINE_LINES).join("\n");
    truncated = true;
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_INLINE_BYTES) {
    text = buf.subarray(0, MAX_INLINE_BYTES).toString("utf8");
    truncated = true;
  }
  return { text, truncated };
}

function renderInline(name, text, truncated) {
  // Neutralize backtick fences in content so they don't break our code block.
  const safe = text.replace(/```/g, "ʼʼʼ");
  const footer = truncated ? `\n${t("file.delivery.truncated")}` : "";
  return `📄 ${name}\n\`\`\`\n${safe}\n\`\`\`${footer}`;
}
