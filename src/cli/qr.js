// Terminal ASCII/half-block QR for the headless login flow.
//
// Reuses the existing qrcode-generator dependency (no new deps) to render a
// scannable QR straight to a no-browser VPS terminal. Half-block glyphs pack
// two QR rows into one text line so the code fits a normal terminal; a phone
// camera reads dark-on-light, so we render dark modules as foreground.
//
// renderQr() is pure (string in → string out) and synchronous-friendly via a
// lazily-imported generator, so the login command stays unit-testable: tests
// assert that --no-qr omits the art while the URL + user code still print.

import qrcode from "qrcode-generator";

// Build the QR matrix for `text`. Returns a 2D boolean array (true = dark).
function matrixFor(text, { typeNumber = 0, errorCorrection = "M" } = {}) {
  const qr = qrcode(typeNumber, errorCorrection);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < count; r += 1) {
    const row = [];
    for (let c = 0; c < count; c += 1) {
      row.push(qr.isDark(r, c));
    }
    rows.push(row);
  }
  return rows;
}

// Render the matrix with Unicode half-block glyphs. A "quiet zone" border of
// light modules is added (scanners require it). Each output character encodes
// the top and bottom of a 2-row band:
//   top dark + bottom dark  → █   (full)
//   top dark + bottom light → ▀   (upper)
//   top light + bottom dark → ▄   (lower)
//   both light              → " " (space)
function renderHalfBlock(matrix, { quiet = 2 } = {}) {
  const size = matrix.length;
  const padded = [];
  const blank = new Array(size + quiet * 2).fill(false);
  for (let i = 0; i < quiet; i += 1) {
    padded.push(blank.slice());
  }
  for (const row of matrix) {
    padded.push([...new Array(quiet).fill(false), ...row, ...new Array(quiet).fill(false)]);
  }
  for (let i = 0; i < quiet; i += 1) {
    padded.push(blank.slice());
  }

  const lines = [];
  for (let r = 0; r < padded.length; r += 2) {
    const top = padded[r];
    const bottom = padded[r + 1] ?? blank;
    let line = "";
    for (let c = 0; c < top.length; c += 1) {
      const t = top[c];
      const b = bottom[c];
      if (t && b) {
        line += "█"; // █
      } else if (t && !b) {
        line += "▀"; // ▀
      } else if (!t && b) {
        line += "▄"; // ▄
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Public entry: text → terminal QR string. Returns null when text is empty so
// callers can fall back to printing the URL + user code only.
export function renderQr(text, opts = {}) {
  if (!text || typeof text !== "string") {
    return null;
  }
  try {
    const matrix = matrixFor(text, opts);
    return renderHalfBlock(matrix, opts);
  } catch {
    // qrcode-generator throws if the payload exceeds the chosen type's capacity
    // at the auto type number; degrade gracefully — the URL is still printed.
    return null;
  }
}

export const __test__ = { matrixFor, renderHalfBlock };
