import type { FXHelperModule } from "../FXHelperModule.Internal";
import {
  FX_GLSL_BASELINE_NOISE,
  FX_GLSL_STANDARD_NOISE,
  FX_JS_NOISE,
} from "./FXValueNoise.Internal";

/**
 * Octave sum shared by fBm and curl: sum of sample(p_k) * gain^k / sum of gain^k, with
 * p_k = p_(k-1) * lacunarity + shift; 0 for zero octaves. Two GLSL forms: a loop for a runtime
 * octave count, and an unrolled one per fixed count, so no driver has to fold the loop's break.
 */

/** GLSL ES 1.00 needs a constant loop bound; also guards against a runaway runtime value. */
export const FX_FBM_MAX_OCTAVES = 8;

/** Octave counts with an unrolled variant - the noise nodes' structural menu. */
export const FX_FIXED_OCTAVE_COUNTS = [1, 2, 3, 4, 5, 6] as const;
export type FXFixedOctaves = (typeof FX_FIXED_OCTAVE_COUNTS)[number];

/** Keeps octaves from sharing a lattice origin (a visible repeat around p = 0). */
const OCTAVE_SHIFT = "7.31";
const MAX = FX_FBM_MAX_OCTAVES.toString();

/**
 * A GLSL octave-sum function `signature` over `p`, `octaves`, `lacunarity`, `gain`. `accumulate`
 * adds the octave's `sample * amp` to `sum` (of type `sumType`).
 */
export function glslOctaveSum(signature: string, sumType: string, accumulate: string): string {
  return (
    `${signature}{int n=int(clamp(floor(octaves),0.0,${MAX}.0));` +
    `${sumType} sum=${sumType}(0.0);float amp=1.0;float total=0.0;` +
    `for(int o=0;o<${MAX};o++){if(o>=n)break;${accumulate}` +
    `total+=amp;amp*=gain;p=p*lacunarity+${OCTAVE_SHIFT};}` +
    `return total>0.0?sum/total:${sumType}(0.0);}`
  );
}

/**
 * {@link glslOctaveSum} with `octaves` fixed, over `p`, `lacunarity`, `gain`. Each octave is its
 * own block so `accumulate` may declare locals.
 */
export function glslOctaveSumUnrolled(
  signature: string,
  sumType: string,
  accumulate: string,
  octaves: FXFixedOctaves,
): string {
  const step = `amp*=gain;p=p*lacunarity+${OCTAVE_SHIFT};`;
  const blocks = Array.from(
    { length: octaves },
    (_, k) => `${k === 0 ? "" : step}{${accumulate}}total+=amp;`,
  ).join("");
  return `${signature}{${sumType} sum=${sumType}(0.0);float amp=1.0;float total=0.0;${blocks}return sum/total;}`;
}

/**
 * JS octave loop over the coordinate variables `axes`, with octaves/lacunarity/gain in `o`/`l`/`g`.
 * `accumulate` adds the octave's contribution (scaled by `amp`) to the caller's sums; read the
 * result through {@link jsNormalized}.
 */
export function jsOctaveLoop(axes: readonly string[], accumulate: string): string {
  const step = axes.map((axis) => `${axis}=${axis}*l+${OCTAVE_SHIFT};`).join("");
  return (
    `var n=Math.min(Math.max(Math.floor(o),0),${MAX}),amp=1,total=0;` +
    `for(var m=0;m<n;m++){${accumulate}total+=amp;amp*=g;${step}}`
  );
}

/** `sum / total`, or 0 after zero octaves. */
export function jsNormalized(sum: string): string {
  return `(total>0?${sum}/total:0)`;
}

const FBM_TYPES = ["float", "vec2", "vec3"] as const;
const FBM_SAMPLE = "sum+=noise(p)*amp;";

/** Same source on both tiers; only the required `noise` differs. */
const GLSL_FBM_SOURCE = `\n${FBM_TYPES.map((type) =>
  glslOctaveSum(
    `float fxFbm(${type} p,float octaves,float lacunarity,float gain)`,
    "float",
    FBM_SAMPLE,
  ),
).join("\n")}`;

export const FX_GLSL_BASELINE_FBM: FXHelperModule = {
  key: "fbm",
  source: GLSL_FBM_SOURCE,
  requires: [FX_GLSL_BASELINE_NOISE],
};

export const FX_GLSL_STANDARD_FBM: FXHelperModule = {
  key: "fbm",
  source: GLSL_FBM_SOURCE,
  requires: [FX_GLSL_STANDARD_NOISE],
};

/** The registry function of fBm with `octaves` fixed; it takes `(p, lacunarity, gain)`. */
export function fixedFbmName(octaves: FXFixedOctaves): string {
  return `fbmOctaves${octaves.toString()}`;
}

export function fixedFbmGLSLName(octaves: FXFixedOctaves): string {
  return `fxFbmOctaves${octaves.toString()}`;
}

/** The unrolled fBm module over a tier's `noise` module. */
export function glslFixedFbmModule(noise: FXHelperModule, octaves: FXFixedOctaves): FXHelperModule {
  const name = fixedFbmGLSLName(octaves);
  return {
    key: fixedFbmName(octaves),
    source: `\n${FBM_TYPES.map((type) =>
      glslOctaveSumUnrolled(
        `float ${name}(${type} p,float lacunarity,float gain)`,
        "float",
        FBM_SAMPLE,
        octaves,
      ),
    ).join("\n")}`,
    requires: [noise],
  };
}

const JS_AXES = ["x", "y", "z"] as const;

function jsFractal(dimensions: 1 | 2 | 3): string {
  const axes = JS_AXES.slice(0, dimensions);
  return (
    `function fxFractal${dimensions.toString()}(${axes.join(",")},o,l,g){var sum=0;` +
    jsOctaveLoop(axes, `sum+=fxNoise${dimensions.toString()}(${axes.join(",")})*amp;`) +
    `return ${jsNormalized("sum")};}`
  );
}

export const FX_JS_FBM: FXHelperModule = {
  key: "fbm",
  requires: [FX_JS_NOISE],
  source: `\n${([1, 2, 3] as const).map(jsFractal).join("\n")}`,
};
