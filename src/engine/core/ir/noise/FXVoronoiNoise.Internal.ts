import type { FXGLSLHelperName } from "../FXHelpers.Internal";

/**
 * Voronoi noise: `(F1, F2, cellId)` - nearest and second-nearest distance, and a [0, 1) value of
 * F1's cell. `fast` searches the 2^N cells around `p`, `full` the 3^N (the sources and their
 * accuracy: `sparcoon/helpers`).
 */

export const FX_VORONOI_QUALITIES = ["fast", "full"] as const;
export const FX_VORONOI_METRICS = ["euclidean", "manhattan", "chebyshev"] as const;

export type FXVoronoiQuality = (typeof FX_VORONOI_QUALITIES)[number];
export type FXVoronoiMetric = (typeof FX_VORONOI_METRICS)[number];

export interface FXVoronoiVariant {
  readonly quality: FXVoronoiQuality;
  readonly metric: FXVoronoiMetric;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The registry function name of a variant, e.g. `voronoiFastEuclidean`. */
export function voronoiFunctionName(variant: FXVoronoiVariant): string {
  return `voronoi${capitalize(variant.quality)}${capitalize(variant.metric)}`;
}

/** The JS twin's integer codes for a variant - its trailing arguments before the component. */
export function voronoiJSCodes(variant: FXVoronoiVariant): readonly [number, number] {
  return [
    FX_VORONOI_QUALITIES.indexOf(variant.quality),
    FX_VORONOI_METRICS.indexOf(variant.metric),
  ];
}

/** The GLSL function a variant prints as. */
export function voronoiGLSLName(variant: FXVoronoiVariant): string {
  return `fx${capitalize(voronoiFunctionName(variant))}`;
}

/** Approximate op counts of one call, by quality and coordinate width (standard tier). */
export const FX_VORONOI_CALL_COST: Readonly<
  Record<FXVoronoiQuality, Readonly<Record<number, number>>>
> = {
  fast: { 2: 132, 3: 314 },
  full: { 2: 272, 3: 1000 },
};

/** Each quality and metric as the helpers' constant names spell it. */
const HELPER_WORDS = {
  fast: "FAST",
  full: "FULL",
  euclidean: "EUCLIDEAN",
  manhattan: "MANHATTAN",
  chebyshev: "CHEBYSHEV",
} as const;

/** The helper of a variant on `tier`, e.g. `FX_GLSL_STANDARD_VORONOI_FAST_EUCLIDEAN`. */
export function voronoiHelper(
  variant: FXVoronoiVariant,
  tier: "BASELINE" | "STANDARD",
): FXGLSLHelperName {
  return `FX_GLSL_${tier}_VORONOI_${HELPER_WORDS[variant.quality]}_${HELPER_WORDS[variant.metric]}`;
}
