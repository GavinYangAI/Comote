// Output discipline for the `comote` client CLI.
//
// Headless-first: color is TTY-gated and suppressed by --plain / --no-color /
// NO_COLOR; --json emits a raw JSON.stringify passthrough; OSC-8 hyperlinks
// degrade to plain URLs off a TTY. Renderers here are pure string builders so
// command modules stay testable (they call render.* and assert the text).

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
};

// Resolve whether color/decoration is allowed for this invocation. Honors, in
// order: explicit --plain / --no-color flags, the NO_COLOR env convention, and
// finally the stream's TTY-ness. Exported so command modules and tests share
// one rule.
export function colorEnabled({ flags = {}, env = process.env, stream = process.stdout } = {}) {
  if (flags.plain === true) {
    return false;
  }
  if (flags.color === false) {
    return false;
  }
  if (env && typeof env.NO_COLOR === "string") {
    return false;
  }
  return Boolean(stream && stream.isTTY);
}

// Build a small renderer bound to the parsed flags + environment. The returned
// object exposes color-aware helpers plus table/keyval formatters and osc8.
export function createRenderer({ flags = {}, env = process.env, stream = process.stdout } = {}) {
  const useColor = colorEnabled({ flags, env, stream });
  const json = flags.json === true;

  function paint(code, text) {
    if (!useColor) {
      return text;
    }
    return `${code}${text}${ANSI.reset}`;
  }

  return {
    useColor,
    json,
    bold: (t) => paint(ANSI.bold, t),
    dim: (t) => paint(ANSI.dim, t),
    red: (t) => paint(ANSI.red, t),
    green: (t) => paint(ANSI.green, t),
    yellow: (t) => paint(ANSI.yellow, t),
    cyan: (t) => paint(ANSI.cyan, t),
    // Tone a channel/runtime state string by its semantics.
    state: (s) => paintState(s, paint),
    table: (rows, opts) => table(rows, opts),
    keyval: (pairs, opts) => keyval(pairs, opts),
    osc8: (url, label) => osc8(url, label, useColor && Boolean(stream && stream.isTTY)),
    // Raw JSON passthrough — pretty 2-space so a human piping --json still reads.
    jsonText: (value) => JSON.stringify(value, null, 2),
  };
}

function paintState(s, paint) {
  const value = String(s ?? "");
  if (value === "running" || value === "confirmed" || value === "ok") {
    return paint(ANSI.green, value);
  }
  if (value === "configured" || value === "scanned" || value === "pending") {
    return paint(ANSI.cyan, value);
  }
  if (value === "not_configured" || value === "reserved" || value === "offline") {
    return paint(ANSI.yellow, value);
  }
  if (value === "failed" || value === "expired" || value === "error") {
    return paint(ANSI.red, value);
  }
  return value;
}

// A fixed-width column table. `rows` is an array of arrays of cell strings; the
// optional `head` is a header row. Column widths are computed from the visible
// (ANSI-stripped) length so colored cells don't skew alignment.
export function table(rows, { head = null, gap = 2 } = {}) {
  const all = head ? [head, ...rows] : rows;
  if (all.length === 0) {
    return "";
  }
  const cols = Math.max(...all.map((r) => r.length));
  const widths = new Array(cols).fill(0);
  for (const row of all) {
    for (let c = 0; c < cols; c += 1) {
      const w = visibleLength(row[c] ?? "");
      if (w > widths[c]) {
        widths[c] = w;
      }
    }
  }
  const pad = " ".repeat(gap);
  const lines = [];
  for (let r = 0; r < all.length; r += 1) {
    const row = all[r];
    const cells = [];
    for (let c = 0; c < cols; c += 1) {
      const cell = String(row[c] ?? "");
      // Last column is not padded (trailing whitespace is noise).
      const isLast = c === cols - 1;
      cells.push(isLast ? cell : cell + " ".repeat(widths[c] - visibleLength(cell)));
    }
    lines.push(cells.join(pad));
  }
  return lines.join("\n");
}

// A two-column "Label: value" block, label-padded for scannability.
export function keyval(pairs, { gap = 1 } = {}) {
  const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  if (entries.length === 0) {
    return "";
  }
  const width = Math.max(...entries.map(([k]) => visibleLength(String(k))));
  const pad = " ".repeat(gap);
  return entries
    .map(([k, v]) => `${String(k).padEnd(width)}${pad}${v == null ? "" : String(v)}`)
    .join("\n");
}

// Emit an OSC-8 terminal hyperlink when the stream is an interactive TTY;
// otherwise fall back to "label (url)" or the bare url (OpenClaw rule).
export function osc8(url, label, isTty) {
  const text = label ?? url;
  if (!isTty) {
    return label && label !== url ? `${label} (${url})` : url;
  }
  return `]8;;${url}${text}]8;;`;
}

// Visible length: strip ANSI escapes + OSC-8 control sequences before counting.
function visibleLength(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/\][^]*/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "").length;
}

export const __test__ = { table, keyval, osc8, visibleLength, paintState };
