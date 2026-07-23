/**
 * Small inline-UI glyphs for the number-field chevrons, the dropdown caret, the close/delete "x"
 * and the add "+". Sized in `em` (`width`/`height` "1em") so each keeps inheriting its button's
 * existing `font-size`, and `stroke`/`fill` are `currentColor`. The triangles are filled;
 * close/plus are stroked to sit with the other line icons. 16x16 viewBox.
 */
export const glyphIcons = {
  // Decrement chevron: left-pointing triangle.
  chevronLeft: `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M10.5 4 5 8l5.5 4Z"/>
  </svg>`,

  // Increment chevron: right-pointing triangle.
  chevronRight: `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M5.5 4 11 8l-5.5 4Z"/>
  </svg>`,

  // Dropdown caret: small down-pointing triangle.
  caretDown: `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M4 6.5 8 10.5l4-4Z"/>
  </svg>`,

  // Close / delete: an "x" made of two crossing strokes.
  close: `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/>
  </svg>`,

  // Add: a plus sign.
  plus: `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9"/>
  </svg>`,
};
