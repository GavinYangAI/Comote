import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Persists an inbound IM attachment to a stable, git-ignored local directory and
// records a manifest entry capturing its provenance.
//
// Layout (date is UTC so it is stable across deploy timezones):
//   <attachmentsDir>/<channel>/<yyyy-mm-dd>/<messageId>/<filename>
//   <attachmentsDir>/<channel>/<yyyy-mm-dd>/<messageId>/manifest.json
//
// The manifest is what a future cache manager reads to enforce its OWN
// retention policy (planned: TTL ~180 days OR ~512MB cap, backend-configurable)
// — deliberately independent of any Codex/Claude session lifecycle.
export async function saveInboundAttachment({
  attachmentsDir,
  channel,
  messageId,
  conversationId = null,
  sender = null,
  attachment,
  buffer,
  contentType = null,
  now = new Date(),
}) {
  const date = now.toISOString().slice(0, 10);
  const dir = join(
    attachmentsDir,
    sanitizeSegment(channel) || "unknown",
    date,
    sanitizeSegment(messageId) || randomUUID(),
  );
  await mkdir(dir, { recursive: true });

  const fileName = attachmentFileName(attachment, contentType);
  const localPath = resolve(join(dir, fileName));
  await writeFile(localPath, buffer);

  const entry = {
    channel,
    conversationId,
    messageId,
    sender: sender ? { stableId: sender.stableId ?? null, displayName: sender.displayName ?? null } : null,
    kind: attachment.kind,
    name: attachment.name ?? fileName,
    mime: contentType,
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    localPath,
    // Original IM media key (Feishu image_key/file_key) so the source is traceable.
    mediaKey: attachment.feishuKey ?? attachment.mediaKey ?? null,
    savedAt: now.toISOString(),
  };
  await appendManifest(dir, entry);

  return { path: localPath, name: entry.name, manifest: entry };
}

// Image messages carry no real filename (the name is the image_key), so derive
// an extension from the content-type. Files keep their original name.
function attachmentFileName(attachment, contentType) {
  if (attachment.kind === "image") {
    const base = sanitizeSegment(attachment.name) || "image";
    return `${base}${imageExtFromContentType(contentType)}`;
  }
  return sanitizeSegment(attachment.name) || `${randomUUID()}${extname(attachment.name ?? "")}`;
}

async function appendManifest(dir, entry) {
  const manifestPath = join(dir, "manifest.json");
  let entries = [];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = [];
  }
  entries.push(entry);
  await writeFile(manifestPath, JSON.stringify(entries, null, 2));
}

// Keeps path segments filesystem-safe: only word chars, dot, dash; no leading
// dots (so a crafted name can't escape the directory or create a dotfile).
function sanitizeSegment(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

export function imageExtFromContentType(contentType) {
  const key = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[key] ?? ".png";
}
