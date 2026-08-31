import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve, win32 } from "node:path";

import { classifyMedia, isWithinDir } from "./paths.js";

// Markdown image syntax is not portable to Feishu cards: Feishu interprets
// `![alt](target)` as a card image and requires target to be an uploaded
// image_key. Codex replies instead contain local filesystem paths. Keep the
// parser deliberately narrow (single-line inline images) and turn every match
// into plain text so no raw image element ever reaches a card renderer.
const MARKDOWN_IMAGE_RE = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\r\n)]*))\s*\)/g;

export function neutralizeMarkdownImages(text) {
  return String(text ?? "").replace(MARKDOWN_IMAGE_RE, (_match, alt, angleTarget, bareTarget) => {
    const target = cleanTarget(angleTarget ?? bareTarget ?? "");
    return `🖼️ ${imageLabel(alt, target)}`;
  });
}

// Extracts existing, project-internal local images for attachment delivery.
// Anything remote, missing, non-image, or outside projectRoot stays plain text
// only. This project fence is intentional: an agent response must never turn an
// arbitrary local path into an automatic upload to a chat service.
export function planLocalMarkdownImages(text, { projectRoot } = {}) {
  const images = [];
  const seen = new Set();
  const value = String(text ?? "");
  const sanitized = value.replace(MARKDOWN_IMAGE_RE, (_match, alt, angleTarget, bareTarget) => {
    const target = cleanTarget(angleTarget ?? bareTarget ?? "");
    const localPath = resolveSafeLocalImage(target, projectRoot);
    if (localPath && !seen.has(localPath)) {
      seen.add(localPath);
      images.push(localPath);
    }
    const suffix = localPath ? "（图片将单独发送）" : "（本地图片未自动发送）";
    return `🖼️ ${imageLabel(alt, target)}${suffix}`;
  });
  return { text: sanitized.trim(), images };
}

function resolveSafeLocalImage(target, projectRoot) {
  if (!target || !projectRoot || isRemoteTarget(target)) {
    return null;
  }
  const normalizedTarget = target.replace(/^file:\/\//i, "");
  const candidate = isAbsolute(normalizedTarget) || win32.isAbsolute(normalizedTarget)
    ? resolve(normalizedTarget)
    : resolve(projectRoot, normalizedTarget);
  if (!isWithinDir(projectRoot, candidate)) {
    return null;
  }
  if (classifyMedia(candidate) !== "image" || !existsSync(candidate)) {
    return null;
  }
  return candidate;
}

function cleanTarget(rawTarget) {
  let target = String(rawTarget ?? "").trim();
  // Strip an optional Markdown title: ![alt](path.png "title"). Local paths
  // containing spaces remain intact because the suffix must be quoted.
  target = target.replace(/\s+["'][^"']*["']\s*$/, "").trim();
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function imageLabel(alt, target) {
  return String(alt ?? "").trim() || basename(target) || "图片";
}

function isRemoteTarget(target) {
  return /^(?:https?:|data:|blob:)/i.test(target);
}
