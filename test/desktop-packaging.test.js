import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop packaging targets the requested Tauri installer artifacts", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.match(packageJson.scripts["dist:mac"], /--bundles app/);
  assert.match(packageJson.scripts["dist:mac"], /--target aarch64-apple-darwin/);
  assert.match(packageJson.scripts["dist:mac"], /create-mac-dmg\.mjs/);
  assert.match(packageJson.scripts["dist:win"], /--bundles nsis/);
  assert.match(packageJson.scripts["dist:win"], /--target x86_64-pc-windows-msvc/);
  assert.match(packageJson.scripts["dist:win"], /collect-tauri-artifacts\.mjs win/);
  assert.equal(tauriConfig.productName, "Comote");
  // Keep package.json and tauri.conf.json in lockstep so installer filenames
  // and the embedded Tauri version don't drift apart.
  assert.equal(tauriConfig.version, packageJson.version);
  assert.equal(tauriConfig.identifier, "dev.comote.desktop");
  assert.equal(tauriConfig.app.withGlobalTauri, true);
  assert.deepEqual(tauriConfig.bundle.targets, ["app", "dmg", "nsis"]);
  assert.equal(tauriConfig.bundle.fileAssociations, undefined);
  assert.equal(tauriConfig.bundle.externalBin[0], "binaries/comote-node");
});

test("mac sidecar builder refreshes stale Homebrew node shims", async () => {
  const sidecarScript = await readFile("scripts/build-sidecar.mjs", "utf8");

  assert.match(sidecarScript, /isUsableSidecar/);
  assert.match(sidecarScript, /MIN_STANDALONE_NODE_BYTES/);
  assert.match(sidecarScript, /rm\(armOutputPath,\s*\{\s*force:\s*true\s*\}\)/);
  assert.doesNotMatch(sidecarScript, /if\s*\(\s*await exists\(armOutputPath\)\s*\)\s*\{\s*return;\s*\}/);
});

test("desktop error pages can use data urls without crashing Tauri", async () => {
  const cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
  const mainRs = await readFile("src-tauri/src/main.rs", "utf8");

  assert.match(mainRs, /data_url\(&(?:sidecar_failed_html|version_mismatch_html)/);
  assert.match(cargoToml, /features\s*=\s*\[[^\]]*"webview-data-url"/s);
});

test("desktop startup falls back when sidecar spawns but never listens", async () => {
  const mainRs = await readFile("src-tauri/src/main.rs", "utf8");

  assert.match(mainRs, /fn start_comote_sidecar_ready/);
  assert.match(mainRs, /start_manual_comote_node_from_app/);
  assert.match(mainRs, /bundled comote-node started but did not listen/);
});
