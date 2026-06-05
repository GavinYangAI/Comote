import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// state.json carries raw channel secrets (appSecret, botToken, wechat.token,
// encryptKey) in cleartext, so the file and its directory are created with
// owner-only permissions to protect multi-user machines, Time Machine, and
// cloud-synced backups.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class JsonFileStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    // Serializes writes so only one writeFile/rename runs at a time. Concurrent
    // fire-and-forget saves would otherwise collide on the shared tmp path
    // (rename ENOENT, torn writes). The chain also coalesces: while a write is
    // in flight, additional save() calls share the single pending slot and the
    // latest snapshot wins, cutting write amplification.
    this._writeChain = Promise.resolve();
    this._pending = null;
    this._writeCounter = 0;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  save(state) {
    // Coalesce: if a save is already queued behind the in-flight write, just
    // replace its snapshot with the newest one and reuse its promise instead of
    // stacking another write.
    if (this._pending) {
      this._pending.state = state;
      return this._pending.promise;
    }

    const pending = { state };
    pending.promise = this._writeChain.then(() => {
      // Clear the pending slot before writing so any save() arriving during the
      // write opens a fresh coalescing window (its own pending slot).
      this._pending = null;
      return this._write(pending.state);
    });
    this._pending = pending;
    // Keep the chain alive even if a write rejects, so later saves still run.
    this._writeChain = pending.promise.catch(() => {});
    return pending.promise;
  }

  async _write(state) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIR_MODE });
    // Unique tmp name per write (pid + counter) so even out-of-process or
    // pathological overlap can never clobber another write's tmp file.
    const tmpPath = `${this.filePath}.${process.pid}.${this._writeCounter++}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
      await rename(tmpPath, this.filePath);
    } catch (error) {
      // A failed write/rename must not leave an orphaned tmp behind.
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    // rename preserves the destination inode's prior mode when the target file
    // already exists, so re-assert owner-only perms on the final path.
    await chmod(this.filePath, FILE_MODE);
  }
}
