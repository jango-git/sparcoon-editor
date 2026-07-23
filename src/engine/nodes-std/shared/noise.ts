import type { FXExpr } from "../../core/ir/FXExpr";
import { defineNode } from "../../core/nodes/defineNode";
import type { FXGLSLTypeName } from "../../core/socket/FXValueType";

/**
 * Value / curl noise nodes, shared by the render and behavior backends; the aggregate
 * `FX_SHARED_MATH_NODES` lives in `shared/math.ts`. Both sample the tier-aware hash-based `noise`
 * primitive (`core/ir/FXFunctions.Internal.ts`) - baseline always sin-hashes (GLSL ES 1.00 has no
 * bitwise ops to hash with), standard/behavior always integer-hashes; see that file's doc comments.
 */

/** float / vec2 / vec3 - `noise`'s three widths (1D is meaningful for it: a single scalar
 *  domain, e.g. time, still wants a coherent random walk). `curl-noise` excludes float below -
 *  a rotational field is degenerate in 1D (nothing to rotate around). */
const NOISE_POSITIONS: readonly FXGLSLTypeName[] = ["float", "vec2", "vec3"];
/** vec2 / vec3 - `curl-noise`'s widths only. */
const CURL_POSITIONS: readonly FXGLSLTypeName[] = ["vec2", "vec3"];

/** Octave-count menu for the noise FBM sum (compile-time, so the loop unrolls in `build`). */
const NOISE_OCTAVES: readonly string[] = ["1", "2", "3", "4", "5", "6"];

/**
 * Exact op count of a single `noise` call (see `core/ir/FXFunctions.Internal.ts`), by coordinate
 * width - hand-unrolled statement by statement for both tiers; the two land in the same order of
 * magnitude but neither is uniformly cheaper (the standard/integer-hash tier's per-corner cost is
 * lower, but its cell-coordinate combine arithmetic adds back some of that gap - direction even
 * flips by dimension: baseline wins at 1D, standard wins at 3D). The cost model has no per-tier
 * number yet (see the vertex/fragment discussion), so this is the standard-tier figure throughout:
 * 1D = 39 (baseline's sin-hash form is cheaper here, ~29), 2D = 85 (baseline ~81, close), 3D = 184
 * (baseline is the pricier one here, ~225 - three's-the-charm for corner count: 8 corners
 * amplifies fxHash3's per-corner cost past the integer hash's). Used to cost `noise`/`curl-noise`,
 * which scale with octaves.
 */
const NOISE_CALL_COST: Readonly<Record<number, number>> = { 1: 39, 2: 85, 3: 184 };

/** Parses the structural `octaves` enum the same way `build` does (default/clamp to >= 1). */
function parseOctaves(raw: unknown): number {
  return Math.max(1, Number.parseInt(raw as string, 10) || 1);
}

/**
 * Noise: hash-based value noise sampled at `(p + seed) * frequency`, returning a scalar in
 * `[-1, 1]`. `octaves > 1` sums fBm (each octave scales coordinate by `lacunarity`, amplitude by
 * `gain`, normalized by total amplitude); `octaves` is structural, unrolled at compile time. `p`
 * accepts a float (1D - a coherent random walk over a single scalar domain, e.g. time) as well as
 * vec2/vec3.
 */
export const fxNoise = defineNode({
  type: "noise",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NOISE_POSITIONS },
  inputs: {
    p: { type: "T", required: true },
    frequency: { type: "float", value: 1, min: 0, step: 0.01 },
    seed: { type: "float", value: 0, step: 0.01 },
    lacunarity: { type: "float", value: 2, min: 0, step: 0.01 },
    gain: { type: "float", value: 0.5, min: 0, max: 1, step: 0.01 },
  },
  outputs: { out: { type: "float" } },
  params: {
    octaves: {
      kind: "structural",
      type: "enum",
      options: NOISE_OCTAVES,
      default: "1",
    },
  },
  // Each octave is one `noise` call plus a handful of coordinate/amplitude bookkeeping ops.
  cost: ({ params, resolvedT }) => {
    const callCost = NOISE_CALL_COST[resolvedT.components];
    if (callCost === undefined) {
      throw new Error(`noise: no call cost recorded for component count ${resolvedT.components}`);
    }
    return parseOctaves(params.octaves) * (callCost + 5);
  },
  build: ({ inputs, params, resolvedT, fn }) => {
    const octaves = Math.max(1, Number.parseInt(params.octaves, 10) || 1);
    // Splat the scalar seed to the coordinate's width, offset, then scale by frequency.
    const seed = fn.coerceNumeric(inputs["seed"], resolvedT);
    let coordinate = fn.mul(fn.add(inputs["p"], seed), inputs["frequency"]);
    if (octaves <= 1) {
      return { out: fn.call("noise", coordinate) };
    }
    let sum = fn.call("noise", coordinate);
    let amplitude = fn.lit(1);
    let total = fn.lit(1);
    for (let octaveIndex = 1; octaveIndex < octaves; octaveIndex++) {
      coordinate = fn.mul(coordinate, inputs["lacunarity"]);
      amplitude = fn.mul(amplitude, inputs["gain"]);
      sum = fn.add(sum, fn.mul(fn.call("noise", coordinate), amplitude));
      total = fn.add(total, amplitude);
    }
    return { out: fn.div(sum, total) };
  },
});

/**
 * Curl Noise: a divergence-free vector field from the shared `noise` primitive, so advected
 * particles swirl like smoke without piling up in sinks. 2D: `out = (dpsi/dy, -dpsi/dx)`; 3D:
 * `out = nabla x Psi` over three decorrelated fields. Output magnitude is not normalized - scale
 * it downstream to taste.
 */
export const fxCurlNoise = defineNode({
  type: "curl-noise",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: CURL_POSITIONS },
  inputs: {
    p: { type: "T", required: true },
    frequency: { type: "float", value: 1, min: 0, step: 0.01 },
    seed: { type: "float", value: 0, step: 0.01 },
    epsilon: { type: "float", value: 0.01, min: 1e-4, step: 0.001 },
    lacunarity: { type: "float", value: 2, min: 0, step: 0.01 },
    gain: { type: "float", value: 0.5, min: 0, max: 1, step: 0.01 },
  },
  outputs: { out: { type: "T" } },
  params: {
    octaves: {
      kind: "structural",
      type: "enum",
      options: NOISE_OCTAVES,
      default: "1",
    },
  },
  // Each octave's central-difference derivatives take 4 `noise` calls in 2D, 12 in 3D, plus a
  // handful of bookkeeping ops.
  cost: ({ params, resolvedT }) => {
    const callCost = NOISE_CALL_COST[resolvedT.components];
    if (callCost === undefined) {
      throw new Error(
        `curl-noise: no call cost recorded for component count ${resolvedT.components}`,
      );
    }
    return parseOctaves(params.octaves) * ((resolvedT.components === 2 ? 4 : 12) * callCost + 10);
  },
  build: ({ inputs, params, resolvedT, fn }) => {
    const octaves = Math.max(1, Number.parseInt(params.octaves, 10) || 1);
    const componentCount = resolvedT.components;
    const epsilon = inputs["epsilon"];
    const inverseTwoEpsilon = fn.div(fn.lit(1), fn.mul(fn.lit(2), epsilon));
    const seed = fn.coerceNumeric(inputs["seed"], resolvedT);
    const coordinate0 = fn.mul(fn.add(inputs["p"], seed), inputs["frequency"]);

    // A unit `epsilon` step along coordinate axis `i`, as a vector of the input's width.
    const axis = (i: number): FXExpr =>
      fn.construct(
        resolvedT,
        ...Array.from({ length: componentCount }, (_, componentIndex) =>
          componentIndex === i ? epsilon : fn.lit(0),
        ),
      );
    // Central difference d/daxis of the noise field sampled at `base` (+ optional decorrelation offset).
    const derivativeField = (base: FXExpr, offset: FXExpr | undefined, i: number): FXExpr => {
      const at = offset ? fn.add(base, offset) : base;
      const axisOffset = axis(i);
      return fn.mul(
        fn.sub(fn.call("noise", fn.add(at, axisOffset)), fn.call("noise", fn.sub(at, axisOffset))),
        inverseTwoEpsilon,
      );
    };

    // Fixed, mutually-incommensurate offsets that decorrelate the 3D potential's three channels.
    const offset2 = fn.litVec(31.416, 12.703, 5.906);
    const offset3 = fn.litVec(-43.28, 27.13, -19.87);
    const curlOnce = (coordinate: FXExpr): FXExpr => {
      if (componentCount === 2) {
        // 2D: curl of scalar psi = (dpsi/dy, -dpsi/dx).
        return fn.construct(
          resolvedT,
          derivativeField(coordinate, undefined, 1),
          fn.neg(derivativeField(coordinate, undefined, 0)),
        );
      }
      // 3D: curl of Psi = (psi_1, psi_2, psi_3); psi_1 at coordinate, psi_2 at coordinate+offset2, psi_3 at coordinate+offset3.
      const curlX = fn.sub(
        derivativeField(coordinate, offset3, 1),
        derivativeField(coordinate, offset2, 2),
      );
      const curlY = fn.sub(
        derivativeField(coordinate, undefined, 2),
        derivativeField(coordinate, offset3, 0),
      );
      const curlZ = fn.sub(
        derivativeField(coordinate, offset2, 0),
        derivativeField(coordinate, undefined, 1),
      );
      return fn.construct(resolvedT, curlX, curlY, curlZ);
    };

    if (octaves <= 1) {
      return { out: curlOnce(coordinate0) };
    }
    let coordinate = coordinate0;
    let accumulator = curlOnce(coordinate);
    let amplitude = fn.lit(1);
    let total = fn.lit(1);
    for (let octaveIndex = 1; octaveIndex < octaves; octaveIndex++) {
      coordinate = fn.mul(coordinate, inputs["lacunarity"]);
      amplitude = fn.mul(amplitude, inputs["gain"]);
      accumulator = fn.add(accumulator, fn.mul(curlOnce(coordinate), amplitude));
      total = fn.add(total, amplitude);
    }
    return { out: fn.div(accumulator, total) };
  },
});
