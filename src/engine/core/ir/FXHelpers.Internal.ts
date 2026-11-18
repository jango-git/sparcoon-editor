import type { FXGLSLRenderTier } from "sparcoon/editor";
import * as sparcoonHelpers from "sparcoon/helpers";
import { FX_GLSL_HELPER_REQUIRES, type FXGLSLHelperName } from "sparcoon/helpers";

/**
 * The helpers compiled code calls, by their names in `sparcoon/helpers`: an exported effect imports
 * them by those names, and the preview runs the same functions and links the same sources.
 */

export type { FXGLSLHelperName };

/** A CPU function of `sparcoon/helpers`. */
export type FXJSHelper = (...args: never[]) => number;

/** The name of a CPU function of `sparcoon/helpers`. */
export type FXJSHelperName = {
  [K in keyof typeof sparcoonHelpers]: (typeof sparcoonHelpers)[K] extends FXJSHelper ? K : never;
}[keyof typeof sparcoonHelpers];

/**
 * Adds `name` to `into` after the helpers it calls on `tier`. Insertion order is link order, so a
 * set built this way keeps every helper behind the ones it calls.
 * @throws When `tier` does not link `name`.
 */
export function collectGLSLHelper(
  into: Set<FXGLSLHelperName>,
  tier: FXGLSLRenderTier,
  name: FXGLSLHelperName,
): void {
  const requires = FX_GLSL_HELPER_REQUIRES[tier][name];
  if (requires === undefined) {
    throw new Error(`sparcoon helpers: the ${tier} tier does not link ${name}`);
  }
  for (const required of requires) {
    collectGLSLHelper(into, tier, required);
  }
  into.add(name);
}

/** The GLSL source of helper `name`. */
export function glslHelperSource(name: FXGLSLHelperName): string {
  return sparcoonHelpers[name];
}

/** The function of helper `name`. */
export function jsHelper(name: FXJSHelperName): FXJSHelper {
  return sparcoonHelpers[name];
}
