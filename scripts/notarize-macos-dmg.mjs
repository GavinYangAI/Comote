// Notarizes and staples the built DMG using an App Store Connect API key.
//
// Submitting the DMG covers the Comote.app inside it in one round-trip; stapling
// the DMG embeds the ticket so Gatekeeper passes offline. No-ops when the API-key
// env is absent, so local builds and forks without secrets still succeed.
//
// Required env (set in CI from secrets):
//   COMOTE_NOTARY_KEY_PATH  — path to the AuthKey_XXXX.p8 file
//   COMOTE_NOTARY_KEY_ID    — the key's Key ID
//   COMOTE_NOTARY_ISSUER_ID — the App Store Connect issuer UUID
//
// Usage: node scripts/notarize-macos-dmg.mjs release/Comote-1.2.3-arm64.dmg
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const dmgPath = process.argv[2];
if (!dmgPath) {
  console.error("Usage: node scripts/notarize-macos-dmg.mjs <path-to-dmg>");
  process.exit(1);
}

const keyPath = process.env.COMOTE_NOTARY_KEY_PATH;
const keyId = process.env.COMOTE_NOTARY_KEY_ID;
const issuerId = process.env.COMOTE_NOTARY_ISSUER_ID;

if (!keyPath || !keyId || !issuerId) {
  console.log("[notarize] notary key env not set — skipping (un-notarized build).");
  process.exit(0);
}

console.log(`[notarize] submitting ${dmgPath} (this can take a few minutes)…`);
await run("xcrun", [
  "notarytool",
  "submit",
  dmgPath,
  "--key",
  keyPath,
  "--key-id",
  keyId,
  "--issuer",
  issuerId,
  "--wait",
]);

console.log("[notarize] stapling ticket…");
await run("xcrun", ["stapler", "staple", dmgPath]);

console.log(`[notarize] done — ${dmgPath} is notarized and stapled.`);

async function run(cmd, args) {
  const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
