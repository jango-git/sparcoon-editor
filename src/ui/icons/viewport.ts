/**
 * Viewport overlay glyphs: the top-right studio controls (Lighting / Scene) and the bottom-right
 * add-object "+". 16x16 line icons, `stroke="currentColor"`.
 */
export const viewportIcons = {
  // Lighting tab (Sun / Hemisphere / active-environment controls): a sun with rays.
  sun: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3"/>
    <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/>
  </svg>`,

  // Scene reference gizmos: a three-axis tripod from a common origin.
  scene: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 13.2V5.6M8 13.2 2.9 10.3M8 13.2l5.1-2.9"/>
    <circle cx="8" cy="13.2" r="1" fill="currentColor" stroke="none"/>
  </svg>`,

  // Gizmo (transform tool): a four-way move manipulator - arrows out of a common centre. Kept
  // visually distinct from the Scene tripod so the two tabs do not share a glyph.
  gizmo: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.4v11.2M2.4 8h11.2"/>
    <path d="M6.4 4 8 2.4 9.6 4M6.4 12 8 13.6 9.6 12M4 6.4 2.4 8 4 9.6M12 6.4 13.6 8 12 9.6"/>
  </svg>`,

  // Transform space - Global: a wireframe globe (equator + one meridian).
  spaceGlobal: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.4"/>
    <path d="M2.6 8h10.8"/>
    <ellipse cx="8" cy="8" rx="2.7" ry="5.4"/>
  </svg>`,

  // Transform space - Local: an object cube carrying its own little axis tripod.
  spaceLocal: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.4 13.4 5.4V10.6L8 13.6 2.6 10.6V5.4Z"/>
    <path d="M2.6 5.4 8 8.4l5.4-3M8 8.4v5.2"/>
  </svg>`,

  // Add object.
  add: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9"/>
  </svg>`,

  // Item (transform) tab: a boxed object with a placement handle - the N-panel's Item tab.
  item: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="6" y="6" width="7" height="7"/>
    <path d="M3 3h2M3 3v2M3 8.5V3h5.5"/>
  </svg>`,

  // Emitter: a source at the lower-left throwing a spray of particles up and to the right.
  emitter: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="3.4" cy="12.6" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="7.6" cy="8.4" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="11.4" cy="4.6" r="1" fill="currentColor" stroke="none"/>
    <circle cx="12.4" cy="9.4" r="0.85" fill="currentColor" stroke="none"/>
    <circle cx="8.2" cy="12.4" r="0.75" fill="currentColor" stroke="none"/>
  </svg>`,

  // VFX group: an isometric cube (the whole effect scene), echoing its empty-cube viewport gizmo.
  group: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.2 13.5 5.2 13.5 10.8 8 13.8 2.5 10.8 2.5 5.2Z"/>
    <path d="M2.5 5.2 8 8.2 13.5 5.2M8 8.2V13.8"/>
  </svg>`,

  // VFX mesh: a plain square crossed by a diagonal edge (a quad's two triangles).
  mesh: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="10" height="10"/>
    <path d="M3 13 13 3"/>
  </svg>`,
};
