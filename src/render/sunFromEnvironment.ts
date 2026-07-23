/**
 * Derives the Sun from an HDRI's brightest upper-hemisphere pixel. Azimuth/elevation inverts
 * three.js's `equirectUv` mapping against {@link placeSun}'s convention (`environment.ts`), so the
 * derived sun stays aligned with where the bright spot renders in `scene.background`.
 */

import type { Rgba } from "../ui/components/color";

export interface DerivedSun {
  /** Whether the upper hemisphere has a clear enough bright spot to treat as a sun. */
  readonly enabled: boolean;
  readonly color: Rgba;
  readonly intensity: number;
  readonly azimuth: number;
  readonly elevation: number;
}

interface EquirectImage {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

// Rec.709 weights - matches three.js's own shader `luminance()`, so "brightest" here agrees with
// what the renderer would call brightest.
const LUMINANCE_R = 0.2126729;
const LUMINANCE_G = 0.7151522;
const LUMINANCE_B = 0.072175;

// HDR luminance at which derived intensity == 1, anchoring the derived scale near the manual
// default (2.2) rather than an arbitrary unit.
const SUN_INTENSITY_REFERENCE_LUMINANCE = 1;
// Matches sunIntensity's existing slider max (previewSettings.ts) - HDR suns can run several
// orders of magnitude brighter than this, so intensity is log-compressed then hard-capped.
const SUN_INTENSITY_MAX = 10;
// Bright/mean luminance ratio below which the upper hemisphere reads as "no clear sun" (e.g. an
// overcast sky) - a real sun disc clears this by orders of magnitude; retune against real assets.
const SUN_CONTRAST_THRESHOLD = 4;
// Guards the max-channel and mean-luminance divisions on an all-black upper hemisphere.
const LUMINANCE_EPSILON = 1e-6;

/** Finds the brightest upper-hemisphere pixel in `image` and derives a Sun from it. */
export function deriveSunFromEquirect(image: EquirectImage): DerivedSun {
  const upperRows = Math.floor(image.height / 2);
  let bestLuminance = -Infinity;
  let bestRow = 0;
  let bestColumn = 0;
  let bestR = 0;
  let bestG = 0;
  let bestB = 0;
  let sumLuminance = 0;
  let sampleCount = 0;

  for (let row = 0; row < upperRows; row++) {
    for (let column = 0; column < image.width; column++) {
      const index = (row * image.width + column) * 4;
      const r = image.data[index] ?? 0;
      const g = image.data[index + 1] ?? 0;
      const b = image.data[index + 2] ?? 0;
      const pixelLuminance = LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b;
      sumLuminance += pixelLuminance;
      sampleCount++;
      if (pixelLuminance > bestLuminance) {
        bestLuminance = pixelLuminance;
        bestRow = row;
        bestColumn = column;
        bestR = r;
        bestG = g;
        bestB = b;
      }
    }
  }

  const meanLuminance = sumLuminance / Math.max(sampleCount, 1);
  const contrast = bestLuminance / Math.max(meanLuminance, LUMINANCE_EPSILON);
  const rowFraction = (bestRow + 0.5) / image.height;
  const columnFraction = (bestColumn + 0.5) / image.width;

  return {
    enabled: contrast >= SUN_CONTRAST_THRESHOLD,
    color: deriveColor(bestR, bestG, bestB),
    intensity: deriveIntensity(bestLuminance),
    elevation: 90 - 180 * rowFraction,
    azimuth: normalizeDegrees(270 - 360 * columnFraction),
  };
}

/** Max-channel normalization preserves hue exactly and keeps every channel within (0, 1]. */
function deriveColor(r: number, g: number, b: number): Rgba {
  const channelMax = Math.max(r, g, b, LUMINANCE_EPSILON);
  return [r / channelMax, g / channelMax, b / channelMax, 1];
}

function deriveIntensity(bestLuminance: number): number {
  const scaled = Math.log2(1 + bestLuminance / SUN_INTENSITY_REFERENCE_LUMINANCE);
  return Math.min(SUN_INTENSITY_MAX, Math.max(0, scaled));
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
