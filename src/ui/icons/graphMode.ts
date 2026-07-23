/**
 * Graph-switch glyphs for the middlebar's Behavior/Render buttons and the graph's input-mode toggle.
 * Behavior is a single-turn spiral arrow (motion/simulation), Render a paint droplet (appearance).
 * `mouse`/`touchpad` back the graph's pan-zoom input-mode toggle. 16x16 line icons.
 */
export const graphModeIcons = {
  // A single-turn spiral spinning outward to an arrowhead - motion / simulation.
  behavior: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 8A1.5 1.5 0 0 1 8 9.5 2.6 2.6 0 0 1 5.4 8 3.6 3.6 0 0 1 8 4.4 4.5 4.5 0 0 1 12.5 8"/>
    <path d="M11.7 7 12.5 8 13.3 7"/>
  </svg>`,

  // A paint droplet with a highlight - material / rendered appearance.
  render: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.4c2.6 3.1 4 5.2 4 7a4 4 0 0 1-8 0c0-1.8 1.4-3.9 4-7Z"/>
    <path d="M6.1 9.6a1.9 1.9 0 0 0 1.7 1.8"/>
  </svg>`,

  // A mouse with a scroll seam - wheel-driven zoom, drag-to-pan.
  mouse: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="4.5" y="2.5" width="7" height="11" rx="3.5"/>
    <path d="M8 4.5v2.5"/>
  </svg>`,

  // A trackpad with a click seam - two-finger scroll to pan, pinch to zoom.
  touchpad: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="9"/>
    <path d="M8 9v3.5"/>
  </svg>`,
};
