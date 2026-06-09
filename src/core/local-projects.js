import fsDefault from "node:fs";
import os from "node:os";

// Discovers candidate projects by scanning one level under a root directory.
// This is the fallback project source for headless/Linux installs where there
// is no Codex Desktop to enumerate workspaces — without it, `/projects` over IM
// is a dead end on a fresh box (empty list, nothing to /open).
//
// Root resolution: COMOTE_PROJECT_ROOT env wins, else the user's home dir.
// Every immediate subdirectory counts as a project; dotfile directories
// (.cache, .git, .config, …) are skipped as noise. Any read error (missing
// root, permissions) yields an empty list rather than throwing — discovery
// must never take the daemon down.
export function scanLocalProjects({
  root,
  fs = fsDefault,
  env = process.env,
  homedir = os.homedir,
} = {}) {
  const scanRoot = root ?? env.COMOTE_PROJECT_ROOT ?? homedir();
  if (!scanRoot) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const base = scanRoot.replace(/\/+$/, "");
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      path: `${base}/${name}`,
      source: "local-scan",
      status: "available",
    }));
}
