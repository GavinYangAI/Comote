import { execFile } from "node:child_process";
import { access, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nodeVersion = process.versions.node;
const mode = process.argv[2] ?? "current";
const binariesDir = join(process.cwd(), "src-tauri", "binaries");
const cacheDir = join(process.cwd(), ".comote", "node-runtime-cache");
const MIN_STANDALONE_NODE_BYTES = 10 * 1024 * 1024;

await mkdir(binariesDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

if (mode === "current") {
  await copyFile(process.execPath, join(binariesDir, sidecarName(currentTargetTriple())));
} else if (mode === "aarch64-apple-darwin") {
  await buildMacAarch64Node();
} else if (mode === "x86_64-pc-windows-msvc") {
  await buildWindowsNode();
} else {
  throw new Error(`Unknown sidecar target: ${mode}`);
}

console.log(`Prepared Comote sidecar for ${mode}`);

async function buildMacAarch64Node() {
  if (process.platform !== "darwin") {
    throw new Error("macOS aarch64 sidecar must be built on macOS.");
  }
  const armOutputPath = join(binariesDir, sidecarName("aarch64-apple-darwin"));
  if (await isUsableSidecar(armOutputPath)) {
    return;
  }
  const armNode = await downloadNodeRuntime("darwin", "arm64");
  await rm(armOutputPath, { force: true });
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

async function isUsableSidecar(path) {
  try {
    const info = await stat(path);
    return info.size >= MIN_STANDALONE_NODE_BYTES;
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
