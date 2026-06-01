import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function classifyMedia(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
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
