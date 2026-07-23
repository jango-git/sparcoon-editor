/**
 * Middlebar action-button glyphs: undo, redo and the content screen. 16x16 line icons,
 * `stroke="currentColor"`, 1.5 stroke, round caps/joins. `content` is the monitor glyph for the
 * content screen (textures/HDRIs/meshes + export).
 */
export const actionIcons = {
  undo: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 7h6.5a3 3 0 0 1 0 6H6"/>
    <path d="M6.5 4 3.5 7l3 3"/>
  </svg>`,

  redo: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 7H5.5a3 3 0 0 0 0 6H10"/>
    <path d="M9.5 4l3 3-3 3"/>
  </svg>`,

  // A monitor: the content screen (textures/HDRIs/meshes + export), opened from the middlebar.
  content: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="8" rx="1.5"/>
    <path d="M6 13.5h4M8 11v2.5"/>
  </svg>`,

  // A waste bin: the generic destructive-delete glyph, behind the countdown-confirm remove control.
  trash: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 4.5h10"/>
    <path d="M6.2 4.5V3.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1V4.5"/>
    <path d="M4.4 4.5l.55 8a1 1 0 0 0 1 .93h4.1a1 1 0 0 0 1-.93l.55-8"/>
    <path d="M6.7 6.8v3.9M9.3 6.8v3.9"/>
  </svg>`,
};
