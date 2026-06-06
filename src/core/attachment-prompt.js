import { t } from "./i18n/index.js";

// Builds the prompt fragment for one already-downloaded inbound attachment.
// Images keep a bare path reference because their pixels are forwarded to Codex
// separately as a multimodal `localImage`/`--image` input; every other file
// type is something Codex must open itself, so we hand it an explicit read
// instruction pointing at the path already saved inside the project.
export function attachmentPromptLine({ relativePath, kind }) {
  if (kind === "image") {
    return `[attachment: ${relativePath}]`;
  }
  return t("attachment.read.instruction", { path: relativePath });
}
