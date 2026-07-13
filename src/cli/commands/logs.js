// `comote logs [--limit N] [--offset N]` — tail the daemon's in-memory log.
// `comote logs --file [--lines N]`      — tail the desktop-App log FILES.
//
// Default mode: GET /api/logs returns the daemon's in-memory event ring buffer
// as { entries, total, hasMore }. entries are NEWEST-FIRST, each shaped
// { id, at (ISO), level, message, detail? } (src/core/event-log.js). The route
// honors ?limit & ?offset server-side, so we pass them through verbatim.
//
// --file mode: reads the tail (default 200 lines, --lines N) of the desktop
// App's launch log files (see src/cli/log-paths.js) straight from disk — no
// daemon needed, which is the whole point: these files are where the evidence
// lands when the daemon/sidecar failed to start. The files exist only when the
// desktop App has run; a friendly pointer is printed when they don't.
//
// Default render is one compact line per entry: timestamp · level · message,
// plus a short one-line detail summary when a detail object/string is present.
// --json passes the raw { entries, total, hasMore } object through; --plain
// drops color (handled by the renderer).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { desktopLogPaths } from "../log-paths.js";
import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

const DEFAULT_FILE_TAIL_LINES = 200;

// Parse a --limit / --offset flag into a non-negative integer, or throw a
// UsageError so a typo'd `--limit foo` is a clean exit 2 rather than NaN noise.
function parseCount(raw, name) {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return n;
}

// Last N non-empty-tail lines of a text blob (the trailing newline does not
// count as an extra empty line).
function tailLines(text, n) {
  const lines = String(text).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - n));
}

// --file mode. Injectable platform/home/fs so tests never depend on the host's
// real desktop-App logs.
async function runFileMode({
  write,
  r,
  lines,
  env = {},
  platform = process.platform,
  home,
  exists = existsSync,
  readFileImpl = readFile,
}) {
  const candidates = desktopLogPaths({ platform, env, ...(home ? { home } : {}) });
  if (candidates.length === 0) {
    write(`No desktop-App log files on this platform (${platform}) — the desktop App does not ship for it.\n`);
    write(`Use \`comote logs\` for the daemon's in-memory event log.\n`);
    return 0;
  }
  const existing = candidates.filter((c) => exists(c.path));
  if (existing.length === 0) {
    write("No desktop-App log files found. Expected locations:\n");
    for (const c of candidates) {
      write(`  ${c.path} (${c.label})\n`);
    }
    write("These files are only written when Comote runs as the desktop App.\n");
    write(`Use \`comote logs\` for the daemon's in-memory event log.\n`);
    return 0;
  }
  for (const c of existing) {
    const raw = await readFileImpl(c.path, "utf8");
    const tail = tailLines(raw, lines);
    write(`${r.dim(`== ${c.path} — last ${tail.length} line(s) ==`)}\n`);
    write(tail.length > 0 ? `${tail.join("\n")}\n` : `${r.dim("(empty)")}\n`);
  }
  return 0;
}

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });

  if (parsed.flags.file) {
    const lines = parseCount(parsed.flags.lines, "lines") ?? DEFAULT_FILE_TAIL_LINES;
    return runFileMode({ write, r, lines, env });
  }

  const limit = parseCount(parsed.flags.limit, "limit");
  const offset = parseCount(parsed.flags.offset, "offset");

  const query = new URLSearchParams();
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  if (offset !== undefined) {
    query.set("offset", String(offset));
  }
  const qs = query.toString();
  const payload = await client.get(`/api/logs${qs ? `?${qs}` : ""}`);

  if (r.json) {
    write(`${r.jsonText(payload)}\n`);
    return 0;
  }

  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) {
    write(`${r.dim("(no log entries)")}\n`);
    return 0;
  }

  const lines = entries.map((e) => formatEntry(e, r));
  write(`${lines.join("\n")}\n`);
  return 0;
}

// One compact line: "<time> · <level> · <message>" with an optional trailing
// "— <detail summary>". The timestamp is shown as HH:MM:SS (local) when the
// `at` field parses; otherwise the raw value is kept.
function formatEntry(entry, r) {
  const time = formatTime(entry?.at);
  const level = formatLevel(entry?.level, r);
  const message = String(entry?.message ?? "");
  let line = `${r.dim(time)} ${level} ${message}`;
  const detail = summarizeDetail(entry?.detail);
  if (detail) {
    line += ` ${r.dim(`— ${detail}`)}`;
  }
  return line;
}

function formatTime(at) {
  if (typeof at !== "string" || !at) {
    return "—";
  }
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) {
    return at;
  }
  return d.toISOString().slice(11, 19);
}

function formatLevel(level, r) {
  const value = String(level ?? "info").toLowerCase();
  const label = value.toUpperCase().padEnd(5);
  if (value === "error") {
    return r.red(label);
  }
  if (value === "warn") {
    return r.yellow(label);
  }
  return r.dim(label);
}

// Collapse a detail payload into a short single-line summary. Strings pass
// through (truncated); objects render as compact key=value pairs. Long output
// is clipped so one event stays on one line.
function summarizeDetail(detail) {
  if (detail == null) {
    return "";
  }
  let text;
  if (typeof detail === "string") {
    text = detail;
  } else if (typeof detail === "object") {
    const parts = Object.entries(detail).map(([k, v]) => `${k}=${formatDetailValue(v)}`);
    text = parts.join(" ");
  } else {
    text = String(detail);
  }
  text = text.replace(/\s+/g, " ").trim();
  return clip(text, 100);
}

function formatDetailValue(value) {
  if (value == null) {
    return "—";
  }
  if (typeof value === "object") {
    return clip(JSON.stringify(value), 40);
  }
  return clip(String(value), 40);
}

function clip(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

export const __test__ = {
  runFileMode,
  tailLines,
  DEFAULT_FILE_TAIL_LINES,
};
