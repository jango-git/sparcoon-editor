/**
 * Sizes of the graph's text that come out the same in every browser. The text is set in JetBrains
 * Mono, whose every glyph advances 0.6 em; browsers differ only in how they round that advance
 * (Chromium on Linux to whole pixels, Firefox not at all). Sizing by the larger of the two gives
 * room every browser's text fits in.
 */

/** JetBrains Mono's advance: 600 of its 1000 units per em. */
const MONO_ADVANCE_EM = 0.6;

/** The widest a glyph set in `fontSize` px is drawn in any browser. */
export function monoAdvance(fontSize: number): number {
  return Math.max(fontSize * MONO_ADVANCE_EM, Math.round(fontSize * MONO_ADVANCE_EM));
}

/**
 * How many lines `text` takes wrapped at `perLine` characters, as `white-space: pre-wrap` with
 * `overflow-wrap: anywhere` wraps it: at spaces, and inside a word only when the word alone is
 * longer than a line.
 */
export function wrappedLineCount(text: string, perLine: number): number {
  const capacity = Math.max(1, perLine);
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += 1;
    let used = 0;
    for (const word of line.split(" ")) {
      let length = [...word].length;
      const needed = used === 0 ? length : used + 1 + length;
      if (needed <= capacity) {
        used = needed;
        continue;
      }
      if (used > 0) {
        lines += 1;
      }
      while (length > capacity) {
        lines += 1;
        length -= capacity;
      }
      used = length;
    }
  }
  return lines;
}
