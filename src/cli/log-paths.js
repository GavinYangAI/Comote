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
import { join } from "node:path";

export const DESKTOP_APP_ID = "dev.comote.desktop";

// Returns [{ label, path }] for the current (or injected) platform. Empty on
// platforms with no desktop build (Linux is npm/headless only).
export function desktopLogPaths({ platform = process.platform, env = process.env, home = homedir } = {}) {
  if (platform === "darwin") {
    const dir = join(home(), "Library", "Application Support", DESKTOP_APP_ID);
    return [{ label: "launch log", path: join(dir, "comote-launch.log") }];
  }
  if (platform === "win32") {
    const base = env.APPDATA || join(home(), "AppData", "Roaming");
    const dir = join(base, DESKTOP_APP_ID);
    return [
      { label: "launch log", path: join(dir, "comote-launch.log") },
      { label: "sidecar stdout", path: join(dir, "comote-node.stdout.log") },
      { label: "sidecar stderr", path: join(dir, "comote-node.stderr.log") },
    ];
  }
  return [];
}
