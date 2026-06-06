import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// state.json carries raw channel secrets (appSecret, botToken, wechat.token,
// encryptKey) in cleartext, so the file and its directory are created with
// owner-only permissions to protect multi-user machines, Time Machine, and
// cloud-synced backups.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class JsonFileStore {
  constructor({ filePath, logger = console } = {}) {
    this.filePath = filePath;
    this.logger = logger;
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
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      // A corrupt state.json must NOT brick startup. Older builds wrote through a
      // shared tmp path with no write serialization, so concurrent saves could
      // tear into "<complete snapshot><leftover tail of a longer snapshot>";
      // power loss, disk faults, or tampering can corrupt it too. Quarantine the
      // raw bytes (the file carries cleartext channel secrets — keep them for
      // manual recovery and forensics), salvage the most recent complete
      // snapshot when the corruption is a trailing-garbage tear, and otherwise
      // boot from empty state instead of crash-looping the sidecar.
      const recovered = recoverJsonPrefix(raw, error);
      await this._quarantine(error);
      if (recovered) {
        this.logger.warn?.(
          `[persistence] ${this.filePath} was corrupt; recovered the leading snapshot and quarantined the original`,
        );
        return recovered;
      }
      this.logger.error?.(
        `[persistence] ${this.filePath} was corrupt and unrecoverable; starting from empty state (original quarantined): ${error.message}`,
      );
      return {};
    }
  }

  // Move the corrupt file aside (atomic rename, preserves exact bytes + mode) so
  // the live path is free for the next clean save and the loop is broken.
  async _quarantine(cause) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${this.filePath}.corrupt-${stamp}.${process.pid}`;
    try {
      await rename(this.filePath, quarantinePath);
    } catch (error) {
      this.logger.warn?.(
        `[persistence] failed to quarantine corrupt ${this.filePath} (${cause.message}): ${error.message}`,
      );
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

// Best-effort salvage of a torn write of the form "<complete value><trailing
// garbage>". V8 reports such corruption as "...after JSON at position N", where
// the [0, N) prefix is itself a complete, valid document — exactly one of the
// concurrently-written snapshots. Recover that snapshot when the prefix parses
// to a plain object; otherwise return null so the caller boots from empty.
function recoverJsonPrefix(raw, error) {
  const match = /position (\d+)/.exec(error?.message ?? "");
  if (!match) {
    return null;
  }
  const end = Number(match[1]);
  if (!Number.isInteger(end) || end <= 0 || end > raw.length) {
    return null;
  }
  try {
    const value = JSON.parse(raw.slice(0, end));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
    // The prefix was not a clean standalone document either — give up.
  }
  return null;
}
