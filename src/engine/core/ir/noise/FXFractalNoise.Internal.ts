import type { FXGLSLHelperName } from "../FXHelpers.Internal";

/** Octave counts with an unrolled fBm and curl - the noise nodes' structural menu. */
export const FX_FIXED_OCTAVE_COUNTS = [1, 2, 3, 4, 5, 6] as const;
export type FXFixedOctaves = (typeof FX_FIXED_OCTAVE_COUNTS)[number];

/** The registry function of fBm with `octaves` fixed; it takes `(p, lacunarity, gain)`. */
export function fixedFbmName(octaves: FXFixedOctaves): string {
  return `fbmOctaves${octaves.toString()}`;
}

export function fixedFbmGLSLName(octaves: FXFixedOctaves): string {
  return `fxFbmOctaves${octaves.toString()}`;
}

export function fixedFbmHelper(octaves: FXFixedOctaves): FXGLSLHelperName {
  return `FX_GLSL_FBM_OCTAVES_${octaves}`;
}
