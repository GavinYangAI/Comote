import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonFileStore {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  async load() {
    try {
      return JSON.parse(stripUtf8Bom(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmpPath, this.filePath);
  }
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
