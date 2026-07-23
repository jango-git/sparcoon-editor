/**
 * Timeline row-action glyphs: the emitter's add-burst / add-play events, the transform rows'
 * add-key, the outline's visibility toggle, the fake-track toggle, and the inspector's infinite-play
 * toggle. Each reads for its purpose - a spark for an instantaneous burst, a nozzle spraying for a
 * sustained play emission, a keyframe diamond with a plus for inserting a key, an open/slashed eye
 * for show/hide, a broadcast signal for "driven live, not baked", a lemniscate for "runs forever".
 * 16x16 line icons, `stroke`/`fill` `currentColor`.
 */
export const timelineIcons = {
  // Burst: a spark radiating from a centre - a one-shot puff of particles.
  burst: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>
    <path d="M8 1.8v2.2M8 12v2.2M1.8 8h2.2M12 8h2.2M3.6 3.6l1.5 1.5M10.9 10.9l1.5 1.5M12.4 3.6l-1.5 1.5M5.1 10.9l-1.5 1.5"/>
  </svg>`,

  // Play: a nozzle throwing a spray - a sustained emission over the play duration.
  play: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3.5 4 9 8 3.5 12Z" fill="currentColor" stroke="none"/>
    <circle cx="11.6" cy="5.4" r="0.9" fill="currentColor" stroke="none"/>
    <circle cx="12.7" cy="8.3" r="0.9" fill="currentColor" stroke="none"/>
    <circle cx="11.2" cy="11" r="0.9" fill="currentColor" stroke="none"/>
  </svg>`,

  // Add key: a keyframe diamond (matching the lane markers) with a plus.
  addKey: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.4 13.6 8 8 13.6 2.4 8Z"/>
    <path d="M8 5.6v4.8M5.6 8h4.8"/>
  </svg>`,

  // Visible: an open eye - the outline row is shown in the preview.
  visible: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M1.5 8S4 3.6 8 3.6 14.5 8 14.5 8 12 12.4 8 12.4 1.5 8 1.5 8Z"/>
    <circle cx="8" cy="8" r="1.7"/>
  </svg>`,

  // Hidden: the same eye, open arcs broken by a diagonal slash - the row is hidden from the preview.
  hidden: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M1.8 8S4.3 3.6 8 3.6c1.1 0 2.1.3 3 .8M14.2 8s-1.5 2.6-4.2 3.9M9.6 9.6a1.8 1.8 0 0 1-2.6-2.5"/>
    <path d="M2 2l12 12"/>
  </svg>`,

  // Live: a broadcast signal from a point - a channel/param is driven externally, not from baked keys.
  live: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>
    <path d="M5.6 5.6a3.4 3.4 0 0 0 0 4.8M10.4 5.6a3.4 3.4 0 0 1 0 4.8"/>
    <path d="M3.4 3.4a6.8 6.8 0 0 0 0 9.2M12.6 3.4a6.8 6.8 0 0 1 0 9.2"/>
  </svg>`,

  // Infinite: a lemniscate - the play event's "runs forever" toggle, matching the infinite marker's
  // own gradient.
  infinite: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11.54 5.64C14.5 5.64 14.5 10.28 11.54 10.28 8.59 10.28 7.41 5.64 4.15 5.64 1.5 5.64 1.5 10.28 4.15 10.28 7.41 10.28 8.59 5.64 11.54 5.64Z"/>
  </svg>`,
};
