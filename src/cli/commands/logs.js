// `comote logs [--limit N] [--offset N]`.
//
// GET /api/logs returns the daemon's in-memory event ring buffer as
// { entries, total, hasMore }. entries are NEWEST-FIRST, each shaped
// { id, at (ISO), level, message, detail? } (src/core/event-log.js). The route
// honors ?limit & ?offset server-side, so we pass them through verbatim.
//
// Default render is one compact line per entry: timestamp · level · message,
// plus a short one-line detail summary when a detail object/string is present.
// --json passes the raw { entries, total, hasMore } object through; --plain
// drops color (handled by the renderer).

import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

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

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });

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
