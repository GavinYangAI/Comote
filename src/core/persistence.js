import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// state.json carries raw channel secrets (appSecret, botToken, wechat.token,
// encryptKey) in cleartext, so the file and its directory are created with
// owner-only permissions to protect multi-user machines, Time Machine, and
// cloud-synced backups.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class JsonFileStore {
  constructor({ filePath, logger = console, minWriteIntervalMs = 1000, now = Date.now } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    // Throttle: state.json is rewritten in full (hundreds of KB) and a streaming
    // Codex turn calls save() on nearly every event. Writing on each one dirties
    // GBs/hour — macOS flags comote-node as an excessive-disk-write process. So
    // coalesce: the first save when idle writes promptly (leading edge), but
    // saves arriving within minWriteIntervalMs collapse into ONE trailing write
    // carrying the newest snapshot. _writeChain still serializes the physical
    // writes so concurrent writes never collide on the shared tmp path.
    this.minWriteIntervalMs = minWriteIntervalMs;
    this._now = now;
    this._writeChain = Promise.resolve();
    this._writeCounter = 0;
    this._latest = null; // newest snapshot awaiting a write
    this._hasPending = false;
    this._timer = null;
    this._flushPromise = null; // shared by every save() coalesced into the next write
    this._resolveFlush = null;
    this._rejectFlush = null;
    this._lastWriteAt = 0;
    this._lastSerialized = null; // last bytes written, to skip no-op rewrites
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
    // Record the newest snapshot; whoever's write fires next will carry it.
    this._latest = state;
    this._hasPending = true;
    if (!this._flushPromise) {
      this._flushPromise = new Promise((resolve, reject) => {
        this._resolveFlush = resolve;
        this._rejectFlush = reject;
      });
    }
    if (!this._timer) {
      // Leading edge when idle (wait 0); otherwise wait out the remainder of the
      // throttle window so a burst collapses into a single trailing write.
      const wait = Math.max(0, this.minWriteIntervalMs - (this._now() - this._lastWriteAt));
      // Not unref'd: an awaited save() must still resolve when the throttle timer
      // is the only pending handle (unit tests). The daemon keeps the loop alive
      // via its HTTP server, and graceful shutdown calls flush(), so a ref'd
      // timer never delays exit.
      this._timer = setTimeout(() => this._drain(), wait);
    }
    return this._flushPromise;
  }

  // Force any pending snapshot to disk now and wait for all writes to settle.
  // Called on graceful shutdown so the trailing throttled write is never lost.
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this._drain();
    }
    await this._writeChain;
  }

  // Commit the pending snapshot: detach the current coalescing window, then chain
  // the physical write so it stays serialized behind any in-flight write.
  _drain() {
    this._timer = null;
    if (!this._hasPending) {
      return;
    }
    const state = this._latest;
    const resolve = this._resolveFlush;
    const reject = this._rejectFlush;
    this._hasPending = false;
    this._latest = null;
    this._flushPromise = null;
    this._resolveFlush = null;
    this._rejectFlush = null;
    this._lastWriteAt = this._now();
    // Resolve/reject the shared flush promise from the write outcome, but always
    // leave _writeChain resolved so a failed write never stalls later saves.
    this._writeChain = this._writeChain
      .then(() => this._write(state))
      .then(resolve, (error) => {
        this.logger.error?.(`[persistence] write to ${this.filePath} failed: ${error.message}`);
        reject(error);
      });
  }

  async _write(state) {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    // Skip a physical write when the bytes are identical to the last successful
    // write. Persist is called on nearly every event but most carry no change to
    // the serialized snapshot (e.g. progress that doesn't alter persisted state),
    // so this elides the dominant share of redundant 200KB+ rewrites.
    if (serialized === this._lastSerialized) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIR_MODE });
    // Unique tmp name per write (pid + counter) so even out-of-process or
    // pathological overlap can never clobber another write's tmp file.
    const tmpPath = `${this.filePath}.${process.pid}.${this._writeCounter++}.tmp`;
    try {
      await writeFile(tmpPath, serialized, { mode: FILE_MODE });
      await rename(tmpPath, this.filePath);
    } catch (error) {
      // A failed write/rename must not leave an orphaned tmp behind.
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    // rename preserves the destination inode's prior mode when the target file
    // already exists, so re-assert owner-only perms on the final path.
    await chmod(this.filePath, FILE_MODE);
    this._lastSerialized = serialized;
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
