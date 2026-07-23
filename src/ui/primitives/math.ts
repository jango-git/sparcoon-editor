/**
 * Shared scalar helpers. `clamp` / `clamp01` were re-declared in numberControl, colorPicker,
 * colorRamp, curveEditor, graphViewport, nodeView, panelLayout and timelinePanel; they route
 * here instead.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Linear interpolation; `fraction` outside [0, 1] extrapolates (callers clamp when they must). */
export function lerp(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}
