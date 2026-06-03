// Personal WeChat does not render Markdown — Codex replies would otherwise show
// raw `**`, `#`, backticks and link syntax. This is a best-effort cosmetic
// pass that strips the noisiest markers while leaving code-ish text intact.
//
// Deliberately conservative: single underscores are left alone so snake_case
// identifiers (common in Codex output) are not mangled.
export function stripMarkdown(text) {
  let out = String(text ?? "");
  // Fenced code blocks: drop the ``` fence lines, keep the code inside.
  out = out.replace(/```[^\n]*\n?/g, "");
  // Images / links: ![alt](url) and [text](url) -> "text url" (or just url).
  out = out.replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, label, url) =>
    label ? `${label} ${url}` : url,
  );
  // ATX headings: strip the leading #'s, keep the heading text.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Blockquote markers.
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // Bold: **x** or __x__ -> x.
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  // Italic with single asterisks -> x (single underscores left intact).
  out = out.replace(/\*(\S.*?\S|\S)\*/g, "$1");
  // Inline code: `code` -> code.
  out = out.replace(/`([^`]+)`/g, "$1");
  return out;
}
