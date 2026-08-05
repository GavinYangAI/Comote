import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const mode = process.argv[2];
const releaseDir = join(process.cwd(), "release");
const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
await mkdir(releaseDir, { recursive: true });

if (mode === "mac") {
  const source = await findArtifact(join(process.cwd(), "src-tauri", "target"), ".dmg");
  await copyFile(source, join(releaseDir, `Comote-${pkg.version}-universal.dmg`));
} else if (mode === "win") {
  const source = await findArtifact(join(process.cwd(), "src-tauri", "target"), ".exe");
  await copyFile(source, join(releaseDir, `Comote-Setup-${pkg.version}-x64.exe`));
} else if (mode === "linux") {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const appImage = await findArtifact(join(process.cwd(), "src-tauri", "target"), ".AppImage");
  const deb = await findArtifact(join(process.cwd(), "src-tauri", "target"), ".deb");
  await copyFile(appImage, join(releaseDir, `Comote-${pkg.version}-${arch}.AppImage`));
  await copyFile(deb, join(releaseDir, `Comote-${pkg.version}-${arch}.deb`));
} else {
  throw new Error("Usage: node scripts/collect-tauri-artifacts.mjs <mac|win|linux>");
}

console.log(`Collected ${mode} installer in ${releaseDir}`);

async function findArtifact(root, extension) {
  const matches = [];
  await walk(root, matches, extension);
  const installerMatches = matches
    .filter((path) => path.includes(`${separator()}bundle${separator()}`))
    .sort((a, b) => b.length - a.length);
  if (installerMatches.length === 0) {
    throw new Error(`No Tauri ${extension} artifact found under ${root}`);
  }
  return installerMatches[0];
}

async function walk(dir, matches, extension) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, matches, extension);
    } else if (entry.isFile() && entry.name.endsWith(extension) && (await stat(path)).size > 0) {
      matches.push(path);
    }
  }
}

function separator() {
  return process.platform === "win32" ? "\\" : "/";
}
