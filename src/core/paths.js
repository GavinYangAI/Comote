import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function classifyMedia(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
}

// Sanitizes a channel-controlled file name into a single safe path segment for
// the .comote/uploads directory. The result also lands inside the Codex prompt
// as `[attachment: …]`, so it must contain no path separators, control characters, or
// bracket characters that could break the prompt marker.
export function sanitizeUploadName(fileName, fallback = "attachment") {
  // Basename only: drop everything up to and including the last / or \.
  let name = String(fileName).replace(/^.*[/\\]/, "");
  // Defensive: replace any remaining separators (basename regex covers these,
  // but keep the rule explicit so future edits don't reintroduce them).
  name = name.replace(/[/\\]/g, "_");
  // Strip control characters and null bytes — these break fs calls, and
  // newlines in particular allow breaking out of the `[attachment: …]` prompt marker.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, "");
  // Strip bracket characters that could otherwise break the prompt marker.
  name = name.replace(/[[\]]/g, "");
  // Replace commas: the codex-cli passes multiple uploads as a single
  // `--image a,b,c` comma-joined argument, so a comma in a filename would
  // split one upload into two bogus paths.
  name = name.replace(/,/g, "_");
  name = name.trim();
  if (name === "" || name === "." || name === "..") {
    return fallback;
  }
  return name;
}

export function isWithinDir(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedTarget === normalizedRoot) {
    return true;
  }
  return normalizedTarget.startsWith(normalizedRoot + path.sep);
}

// Resolves a user-supplied relative (or absolute) path against the project
// root and returns the absolute path only if it stays inside the root.
// Returns null on any escape — callers MUST treat null as "denied".
export function resolveWithinProject(root, relativeOrAbsolute) {
  const resolved = path.resolve(root, relativeOrAbsolute);
  return isWithinDir(root, resolved) ? resolved : null;
}
