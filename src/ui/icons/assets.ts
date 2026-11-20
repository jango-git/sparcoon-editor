/**
 * Content-sheet glyphs: the upload control, the per-row download action, and the three column/kind
 * marks (image, HDRI, mesh) used as row previews where no pixel thumbnail exists. 16x16 line icons,
 * `stroke="currentColor"`, 1.5 stroke, round caps/joins - matching {@link actionIcons}.
 */
export const assetIcons = {
  upload: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 10V3M5.2 5.5 8 2.7l2.8 2.8"/>
    <path d="M3 10.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5"/>
  </svg>`,

  download: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.7v7M5.2 7 8 9.8 10.8 7"/>
    <path d="M3 10.5v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5"/>
  </svg>`,

  image: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.5"/>
    <circle cx="5.6" cy="6.4" r="1.2"/>
    <path d="M2.6 11.5 6 8.2l2.4 2 2.2-2 2.8 3"/>
  </svg>`,

  hdri: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 11a6 6 0 0 1 12 0"/>
    <path d="M8 3.5V2M3.4 5.4 2.4 4.4M12.6 5.4l1-1M2 11h12"/>
  </svg>`,

  mesh: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2 13.5 5v6L8 14 2.5 11V5z"/>
    <path d="M2.5 5 8 8l5.5-3M8 8v6"/>
  </svg>`,

  volume: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="5" width="6" height="6" rx="1.5"/>
    <rect x="2" y="2" width="12" height="12" rx="3.5" stroke-dasharray="2.4 2.2"/>
  </svg>`,

  bakeVolume: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 5 11 6.6v3.3L8 11.5 5 9.9V6.6z"/>
    <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" stroke-dasharray="2.4 2.2"/>
  </svg>`,

  blank: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="10" height="10" rx="1.5" stroke-dasharray="2.4 2.2"/>
  </svg>`,
};
