// Terminal-style display width, and the test for "too wide to render in a
// cell". Pure port of desktop `apps/desktop/src/lib/grid/edit.ts`
// (ADR-0082 decisions 3-5); unit-tested in tests/display-width.test.ts.
//
// Desktop's copy gates two things — the read-only value viewer and the
// inline editor. Web has no inline editing yet (rung 6), so only the viewer
// is wired here. The threshold is named for the viewer rather than for the
// editor's CSS width, because the editor is what will have to justify
// sharing it when it arrives.

/**
 * How many display columns a grid cell can be trusted to have shown in full.
 *
 * Past this, the value has been truncated on screen and the viewer is the
 * only way to read it. Matches desktop's `INLINE_EDITOR_COLUMNS` so that a
 * value opens its viewer at the same point on both clients.
 */
export const VIEWER_COLUMN_THRESHOLD = 40;

/**
 * Display width of `text`, in terminal columns.
 *
 * Counts by code point rather than UTF-16 unit, and gives full-width
 * characters — CJK, kana, Hangul, and emoji — the two columns they actually
 * occupy. Both halves matter: an emoji is two UTF-16 units wide and one
 * character on screen, so counting units would score it double, and
 * Japanese prose is twice as wide as its `.length` suggests, which is
 * exactly the case a length test gets wrong.
 */
export function displayWidth(text: string): number {
  let width = 0;
  // for…of iterates code points, so a surrogate pair arrives as one `ch`.
  for (const ch of text) {
    width += isFullWidth(ch.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

/** Full-width code-point ranges: CJK and kana blocks, Hangul, CJK
 *  compatibility forms, full-width Latin, and the emoji planes. */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, Hangul compat, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B and beyond
  );
}

/**
 * Whether `text` is worth opening in the viewer.
 *
 * Two reasons, and the second is not about comfort:
 *
 * - It is wider than a cell can show, so what is on screen is an ellipsis
 *   and the rest is unreadable.
 * - It contains a newline. A cell renders on one line whatever the value
 *   holds, so a multi-line value looks like a single-line one that happens
 *   to have odd spacing — the shape of the data is invisible until it is
 *   opened. Desktop tests `\n` only; a lone CR is not something a database
 *   round-trips often enough to guess at, and CRLF is caught by its LF.
 */
export function needsViewer(text: string): boolean {
  return text.includes("\n") || displayWidth(text) > VIEWER_COLUMN_THRESHOLD;
}
