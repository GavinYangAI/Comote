// Shared line-boundary chunker for text channels (wechat / dingtalk). A fixed
// slice-every-N chunker cuts sentences mid-word, splits emoji surrogate pairs in
// half (both halves render as �) and breaks markdown code fences. This splits at
// line boundaries where possible (mirrors telegram's chunkMessage and feishu's
// renderMarkdown), hard-splitting only a single line longer than the limit — and
// that hard split walks code points so it can never land inside a surrogate pair.
//
// fenceAware (dingtalk, whose payload renders as markdown): track ``` fences and,
// when a chunk boundary falls inside one, close the fence at the end of the chunk
// and reopen it at the start of the next so every chunk is valid markdown.

// Room reserved per chunk while inside a fence for the injected close ("\n```")
// and reopen ("```\n") markers, so a decorated chunk never exceeds the limit.
const FENCE_MARKER_RESERVE = 8;

export function chunkTextByLines(text, limit, { fenceAware = false } = {}) {
  const value = String(text ?? "");
  if (!value) return [];
  if (value.length <= limit) return [value];
  const chunks = [];
  let current = "";
  let fenceOpen = false;
  for (const rawLine of value.split("\n")) {
    const togglesFence = fenceAware && rawLine.trimStart().startsWith("```");
    const effLimit = fenceAware && fenceOpen ? limit - FENCE_MARKER_RESERVE : limit;
    // A single line longer than the limit must still be hard-split (code-point safe).
    const pieces = rawLine.length > effLimit ? splitLongLine(rawLine, effLimit) : [rawLine];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && candidate.length > effLimit) {
        chunks.push(fenceAware && fenceOpen ? `${current}\n\`\`\`` : current);
        current = fenceAware && fenceOpen ? `\`\`\`\n${piece}` : piece;
      } else {
        current = candidate;
      }
    }
    if (togglesFence) fenceOpen = !fenceOpen;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Hard-splits one overlong line at code-point boundaries. for..of iterates code
// points (not UTF-16 units), so an astral character (emoji) is kept whole — the
// piece may end 1 unit short of the limit instead of splitting the pair.
function splitLongLine(line, limit) {
  const pieces = [];
  let piece = "";
  for (const cp of line) {
    if (piece.length + cp.length > limit && piece) {
      pieces.push(piece);
      piece = "";
    }
    piece += cp;
  }
  if (piece) pieces.push(piece);
  return pieces.length > 0 ? pieces : [line];
}
