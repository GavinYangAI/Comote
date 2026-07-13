// `comote update` — check for a newer release and print HOW to upgrade.
//
// Deliberately check-and-print only: it never downloads or runs the upgrade.
// Works without the daemon (it talks to the GitHub releases API directly via
// VersionChecker), so it is usable exactly when an update is most needed — when
// the installed daemon won't start.
//
// The suggested upgrade path follows the INSTALL SOURCE, not the OS
// (detectInstallSource in src/core/version-check.js): an npm install gets
// `npm install -g comote@latest` on every platform; a desktop-App install gets
// the platform's download link.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectInstallSource, NPM_UPDATE_COMMAND, VersionChecker } from "../../core/version-check.js";
import { createRenderer } from "../render.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function run({
  parsed,
  env,
  write,
  // Injectable for tests: never hit the real GitHub API from the test suite.
  fetchImpl = globalThis.fetch,
  installSource = null,
  currentVersion = null,
}) {
  const r = createRenderer({ flags: parsed.flags, env });
  const current = currentVersion ?? readPackageVersion();
  const source = installSource ?? detectInstallSource({ env });

  const checker = new VersionChecker({
    currentVersion: current,
    fetchImpl,
    installSource: source,
  });
  const result = await checker.checkNow({ force: true });

  if (r.json) {
    write(`${r.jsonText(result)}\n`);
    return result.error ? 1 : 0;
  }

  write(`Current version   ${current}\n`);
  if (result.error) {
    write(`${r.red(`Update check failed: ${result.error}`)}\n`);
    return 1;
  }
  write(`Latest release    ${result.latest ?? "unknown (no published release found)"}\n`);
  write(`Install source    ${source === "npm" ? "npm (global)" : "desktop App"}\n`);
  write("\n");

  if (!result.hasUpdate) {
    write(`${r.green("You are up to date.")}\n`);
    return 0;
  }

  write(`${r.yellow(`Update available: ${current} → ${result.latest}`)}\n`);
  if (source === "npm") {
    write("Upgrade with:\n");
    write(`  ${result.updateCommand ?? NPM_UPDATE_COMMAND}\n`);
    write("then restart the daemon (e.g. `systemctl restart comote` under systemd).\n");
  } else {
    const link = result.downloadUrl ?? result.releaseUrl ?? "https://github.com/GavinYangAI/comote/releases";
    write("Download the new desktop build:\n");
    write(`  ${link}\n`);
  }
  if (result.releaseUrl) {
    write(`Release notes: ${result.releaseUrl}\n`);
  }
  return 0;
}
