// Well-known desktop-App log locations, per platform.
//
// The Tauri shell writes its launch log — and, on Windows, the sidecar's
// redirected stdout/stderr — into the app-data directory for the
// `dev.comote.desktop` identifier (src-tauri/src/main.rs). These files exist
// ONLY when Comote runs as the desktop App: an npm/CLI daemon logs to its
// in-memory ring buffer (`comote logs`) and to stdout instead. The path
// templates are hardcoded here so `comote doctor` / `comote logs --file` can
// point at them without shelling out to the App.

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DESKTOP_APP_ID = "dev.comote.desktop";

// Returns [{ label, path }] for the current (or injected) platform. Empty on
// platforms with no desktop build (Linux is npm/headless only).
// Joins use the TARGET platform's separator (posix for darwin, win32 for
// Windows), not the host's — an injected platform must render correct paths
// on any host (the Windows CI runs the darwin-injected tests too).
export function desktopLogPaths({ platform = process.platform, env = process.env, home = homedir } = {}) {
  if (platform === "darwin") {
    const dir = posix.join(home(), "Library", "Application Support", DESKTOP_APP_ID);
    return [{ label: "launch log", path: posix.join(dir, "comote-launch.log") }];
  }
  if (platform === "win32") {
    const base = env.APPDATA || win32.join(home(), "AppData", "Roaming");
    const dir = win32.join(base, DESKTOP_APP_ID);
    return [
      { label: "launch log", path: win32.join(dir, "comote-launch.log") },
      { label: "sidecar stdout", path: win32.join(dir, "comote-node.stdout.log") },
      { label: "sidecar stderr", path: win32.join(dir, "comote-node.stderr.log") },
    ];
  }
  return [];
}
