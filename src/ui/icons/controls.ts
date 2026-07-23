/**
 * Transport + toggle-button glyphs. The transport trio uses "dense" filled triangles with a struck
 * vertical bar for the frame-step buttons and a plain triangle / two bars for play / pause.
 * `restartOnRebuild` and `toggleCheck` back the icon toggle buttons. 16x16 line icons, `stroke`/
 * `fill` both `currentColor` so the glyph inherits its button's color.
 */
export const controlIcons = {
  // Step back a frame: a vertical bar on the left, one triangle pointing left into it.
  stepBack: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4.5 4v8"/>
    <path d="M12 4 6.5 8 12 12Z" fill="currentColor" stroke="none"/>
  </svg>`,

  // Step forward a frame: one triangle pointing right, a vertical bar on the right.
  stepForward: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4 9.5 8 4 12Z" fill="currentColor" stroke="none"/>
    <path d="M11.5 4v8"/>
  </svg>`,

  // Play: a single triangle.
  play: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 3.5 12.5 8 5 12.5Z" fill="currentColor" stroke="none"/>
  </svg>`,

  // Pause: two vertical bars.
  pause: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 3.5v9M10 3.5v9"/>
  </svg>`,

  // Restart on rebuild: a refresh arrow looping around a particle at the centre.
  restartOnRebuild: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3"/>
    <path d="M12.8 3.2v2.6h-2.6"/>
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/>
  </svg>`,

  // Generic on/off toggle: a checkmark (lit when the button is active).
  toggleCheck: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>
  </svg>`,

  // Snap lock: a padlock - the gizmo's per-mode snap toggles read as "lock to increment".
  lock: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="6.4" rx="1"/>
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>
    <circle cx="8" cy="10" r="0.9" fill="currentColor" stroke="none"/>
  </svg>`,
};
