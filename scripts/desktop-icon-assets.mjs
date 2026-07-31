import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const projectRoot = process.cwd();
const sourceIconPath = join(projectRoot, ".idea", "icon.png");
const tauriCliPath = join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const defaultOutputDir = join(projectRoot, "src-tauri", "icons");

export async function generateDesktopIcons(outputDir = defaultOutputDir) {
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [tauriCliPath, "icon", sourceIconPath, "--output", outputDir],
    { cwd: projectRoot },
  );
}
