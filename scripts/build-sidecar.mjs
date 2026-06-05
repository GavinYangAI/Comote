import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nodeVersion = process.versions.node;
const mode = process.argv[2] ?? "current";
const binariesDir = join(process.cwd(), "src-tauri", "binaries");
const cacheDir = join(process.cwd(), ".comote", "node-runtime-cache");

// Only run the build when this file is invoked directly (e.g. via npm scripts),
// not when it is imported to unit-test the pure helpers below.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  await mkdir(binariesDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  if (mode === "current") {
    await copyFile(process.execPath, join(binariesDir, sidecarName(currentTargetTriple())));
  } else if (mode === "aarch64-apple-darwin") {
    await buildMacAarch64Node();
  } else if (mode === "universal-apple-darwin") {
    await buildMacUniversalNode();
  } else if (mode === "x86_64-pc-windows-msvc") {
    await buildWindowsNode();
  } else {
    throw new Error(`Unknown sidecar target: ${mode}`);
  }

  console.log(`Prepared Comote sidecar for ${mode}`);
}

async function buildMacUniversalNode() {
  if (process.platform !== "darwin") {
    throw new Error("macOS universal sidecar must be built on macOS.");
  }

  const outputPath = join(binariesDir, sidecarName("universal-apple-darwin"));
  const armOutputPath = join(binariesDir, sidecarName("aarch64-apple-darwin"));
  const x64OutputPath = join(binariesDir, sidecarName("x86_64-apple-darwin"));
  if ((await exists(outputPath)) && (await exists(armOutputPath)) && (await exists(x64OutputPath))) {
    return;
  }

  const armNode = await downloadNodeRuntime("darwin", "arm64");
  const x64Node = await downloadNodeRuntime("darwin", "x64");
  await copyFile(armNode, armOutputPath);
  await copyFile(x64Node, x64OutputPath);
  await execFileAsync("lipo", [
    "-create",
    armNode,
    x64Node,
    "-output",
    outputPath,
  ]);
}

async function buildMacAarch64Node() {
  if (process.platform !== "darwin") {
    throw new Error("macOS aarch64 sidecar must be built on macOS.");
  }
  const armOutputPath = join(binariesDir, sidecarName("aarch64-apple-darwin"));
  if (await exists(armOutputPath)) {
    return;
  }
  const armNode = await downloadNodeRuntime("darwin", "arm64");
  await copyFile(armNode, armOutputPath);
}

async function buildWindowsNode() {
  if (process.platform === "win32") {
    await downloadNodeRuntime("win", "x64");
    await copyFile(
      join(cacheDir, `node-v${nodeVersion}-win-x64`, "node.exe"),
      join(binariesDir, sidecarName("x86_64-pc-windows-msvc")),
    );
    return;
  }

  throw new Error("Windows sidecar must be built on Windows so the NSIS installer can be produced there.");
}

async function downloadNodeRuntime(platform, arch) {
  const extension = platform === "win" ? "zip" : "tar.gz";
  const archiveName = `node-v${nodeVersion}-${platform}-${arch}.${extension}`;
  const archivePath = join(cacheDir, archiveName);
  const extractDir = join(cacheDir, archiveName.replace(`.${extension}`, ""));
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;

  if (!(await exists(archivePath))) {
    await download(url, archivePath);
  }

  await verifyArchiveChecksum(archivePath, archiveName);

  await rm(extractDir, { recursive: true, force: true });
  if (platform === "win") {
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${cacheDir}' -Force`,
    ]);
    return join(extractDir, "node.exe");
  }

  await execFileAsync("tar", ["-xzf", archivePath, "-C", cacheDir]);
  return join(extractDir, "bin", "node");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, outputPath) {
  try {
    await execFileAsync("curl", [
      "-L",
      "--fail",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "-o",
      outputPath,
      url,
    ]);
  } catch (error) {
    throw new Error(`Could not download ${basename(outputPath)} from ${url}: ${error.message}`);
  }
}

// Verifies the downloaded Node archive against the official SHASUMS256.txt.
// Trust is TLS-only: the hashes are fetched over HTTPS from nodejs.org; we do
// not GPG-verify SHASUMS256.txt.sig. That extra signature check is acceptable
// deferred hardening for this build-time fetch.
async function verifyArchiveChecksum(archivePath, archiveName) {
  const shasumsName = `SHASUMS256-v${nodeVersion}.txt`;
  const shasumsPath = join(cacheDir, shasumsName);
  const shasumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;

  if (!(await exists(shasumsPath))) {
    await download(shasumsUrl, shasumsPath);
  }
  const shasumsText = await readFile(shasumsPath, "utf8");

  const archiveBytes = await readFile(archivePath);
  const actualHex = createHash("sha256").update(archiveBytes).digest("hex");

  if (!checksumMatches(actualHex, shasumsText, archiveName)) {
    // Remove the unverified archive so a later run can't reuse it.
    await rm(archivePath, { force: true });
    const expected = expectedSha(shasumsText, archiveName);
    if (!expected) {
      throw new Error(
        `Integrity check failed: no SHASUMS256 entry for ${archiveName} (checked ${shasumsUrl}). Removed ${archiveName}.`,
      );
    }
    throw new Error(
      `Integrity check failed for ${archiveName}: expected ${expected}, got ${actualHex}. Removed ${archiveName}.`,
    );
  }

  console.log(`Verified SHA-256 for ${archiveName}`);
}

/**
 * Find the expected SHA-256 hex digest for an archive in a SHASUMS256.txt body.
 * Each line is `<hex>  <filename>` (two spaces). Returns the lowercased hex
 * digest, or null when the archive has no entry. Pure / no I/O.
 */
export function expectedSha(shasumsText, archiveName) {
  for (const line of shasumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hex, name] = match;
    if (name.trim() === archiveName) {
      return hex.toLowerCase();
    }
  }
  return null;
}

/**
 * Returns true only when `actualHex` matches the SHASUMS256 entry for
 * `archiveName`. A missing entry or a mismatch returns false. Pure / no I/O.
 */
export function checksumMatches(actualHex, shasumsText, archiveName) {
  const expected = expectedSha(shasumsText, archiveName);
  if (!expected) return false;
  return expected === String(actualHex).toLowerCase();
}

function sidecarName(targetTriple) {
  const executableExtension = targetTriple.includes("windows") || targetTriple.includes("msvc") ? ".exe" : "";
  return `comote-node-${targetTriple}${executableExtension}`;
}

function currentTargetTriple() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported development platform: ${process.platform}/${process.arch}`);
}
