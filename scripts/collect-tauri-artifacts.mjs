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
} else {
  throw new Error("Usage: node scripts/collect-tauri-artifacts.mjs <mac|win>");
}

console.log(`Collected ${mode} installer in ${releaseDir}`);

async function findArtifact(root, extension) {
  const matches = [];
  await walk(root, matches, extension);
  const installerMatches = matches
    .filter((path) => path.includes(`${separator()}bundle${separator()}`));
  if (installerMatches.length === 0) {
    throw new Error(`No Tauri ${extension} artifact found under ${root}`);
  }
  const versionMatches = installerMatches.filter((path) => path.includes(pkg.version));
  return newest(versionMatches.length > 0 ? versionMatches : installerMatches);
}

async function newest(paths) {
  let selected = paths[0];
  let selectedMtime = (await stat(selected)).mtimeMs;
  for (const path of paths.slice(1)) {
    const mtime = (await stat(path)).mtimeMs;
    if (mtime > selectedMtime) {
      selected = path;
      selectedMtime = mtime;
    }
  }
  return selected;
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
