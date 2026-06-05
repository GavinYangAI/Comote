// Code-signs the built Comote.app for Developer ID distribution + notarization.
//
// Runs between `tauri build` and `create-mac-dmg.mjs`. If COMOTE_SIGNING_IDENTITY
// is unset (local dev, forks without secrets) it no-ops, so unsigned builds still
// work. Signing is inside-out: every nested Mach-O (the Node sidecar, plus any
// future native addon) is signed first with hardened runtime + JIT entitlements,
// then the bundle root is sealed last. `--deep` is deliberately avoided — it
// re-signs nested binaries WITHOUT our entitlements, which would break the Node
// sidecar under hardened runtime.
import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const identity = process.env.COMOTE_SIGNING_IDENTITY;
if (!identity) {
  console.log("[sign] COMOTE_SIGNING_IDENTITY not set — skipping (unsigned build).");
  process.exit(0);
}

const appPath = join(
  process.cwd(),
  "src-tauri",
  "target",
  "aarch64-apple-darwin",
  "release",
  "bundle",
  "macos",
  "Comote.app",
);
const entitlements = join(process.cwd(), "src-tauri", "entitlements.plist");

const machOFiles = [];
await collectMachO(appPath);
// Deepest paths first so children are sealed before their parents.
machOFiles.sort((a, b) => b.split("/").length - a.split("/").length);

for (const file of machOFiles) {
  await codesign(file);
}
// Seal the bundle root last.
await codesign(appPath);

await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
console.log(`[sign] Signed and verified ${appPath}`);

async function codesign(target) {
  await execFileAsync("codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--sign",
    identity,
    target,
  ]);
  console.log(`[sign] signed ${target.replace(process.cwd() + "/", "")}`);
}

async function collectMachO(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectMachO(full);
    } else if (entry.isFile() && (await isMachO(full))) {
      machOFiles.push(full);
    }
  }
}

async function isMachO(file) {
  // An executable bit OR a Mach-O magic number. We check magic so we also catch
  // non-+x dylibs/.node addons, then confirm it is a regular runnable file.
  const fh = await open(file, "r");
  try {
    const { buffer } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    const magic = buffer.readUInt32BE(0);
    // 0xFEEDFACE/F = Mach-O 32/64 (BE), byte-swapped = LE; 0xCAFEBABE = fat.
    const machO =
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca;
    if (!machO) return false;
    // Skip the bundle dir itself; we only want regular files here.
    return (await stat(file)).isFile();
  } finally {
    await fh.close();
  }
}
