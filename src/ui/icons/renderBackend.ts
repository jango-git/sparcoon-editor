/**
 * Render-backend glyphs for the preview viewport's Baseline/Standard switch (a stacked-layers
 * motif: one plane for the single legacy tier, two for the fuller modern one). 16x16 line icons.
 */
export const renderBackendIcons = {
  // A single flat diamond plane - one tier, nothing layered underneath.
  baseline: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 3.5 13 8 8 12.5 3 8Z"/>
  </svg>`,

  // A diamond plane over a second, open layer beneath it - a fuller, two-tier stack.
  standard: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.6 12.3 5.6 8 8.6 3.7 5.6Z"/>
    <path d="M3.7 9.4 8 12.4 12.3 9.4"/>
  </svg>`,
};
