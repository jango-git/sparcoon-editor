import type { FXExpr } from "../../core/ir/FXExpr";
import { defineNode } from "../../core/nodes/defineNode";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { FX_NOISE_CALL_COST, FX_NOISED_CALL_COST } from "../../core/ir/noise/FXValueNoise.Internal";
import {
  FX_VORONOI_CALL_COST,
  FX_VORONOI_METRICS,
  FX_VORONOI_QUALITIES,
  voronoiFunctionName,
  type FXVoronoiMetric,
  type FXVoronoiQuality,
} from "../../core/ir/noise/FXVoronoiNoise.Internal";
import {
  FX_FIXED_OCTAVE_COUNTS,
  fixedFbmName,
  type FXFixedOctaves,
} from "../../core/ir/noise/FXFractalNoise.Internal";
import { fixedCurlName } from "../../core/ir/noise/FXCurlNoise.Internal";
import {
  FX_SEED_HASH_CALL_COST,
  seedHashFunctionName,
} from "../../core/ir/noise/FXSeedHash.Internal";
import type { FXSeedHashComponents } from "../../core/ir/noise/FXNoiseHash.Internal";
import { FX_VALUE_TYPES, NUMERIC_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Noise nodes, shared by the render and behavior backends; the aggregate `FX_SHARED_MATH_NODES`
 * lives in `shared/math.ts`. Each node only shapes its inputs and calls one registry function
 * (`core/ir/noise/FXNoiseFunctions.Internal.ts`), which owns the per-tier implementations.
 */

/** float / vec2 / vec3 - `noise`'s widths (1D: a coherent random walk over e.g. time). */
const NOISE_POSITIONS: readonly FXGLSLTypeName[] = ["float", "vec2", "vec3"];
/** vec2 / vec3 - a flow field or a cell pattern is degenerate in 1D. */
const PLANAR_POSITIONS: readonly FXGLSLTypeName[] = ["vec2", "vec3"];

/** Octave-count menu: each count compiles to its own unrolled helper. */
const NOISE_OCTAVES: readonly string[] = FX_FIXED_OCTAVE_COUNTS.map(String);

/** Per-octave loop bookkeeping of the fractal helpers. */
const OCTAVE_OVERHEAD = 5;

function costOf(table: Readonly<Record<number, number>>, components: number, node: string): number {
  const cost = table[components];
  if (cost === undefined) {
    throw new Error(`${node}: no call cost recorded for component count ${components.toString()}`);
  }
  return cost;
}

/** Parses the structural `octaves` enum; anything off the menu falls back to 1. */
function parseOctaves(raw: unknown): FXFixedOctaves {
  return FX_FIXED_OCTAVE_COUNTS.find((count) => String(count) === String(raw)) ?? 1;
}

/** `(p + seed) * frequency`, the seed splatted to the coordinate's width. */
function noiseCoordinate(
  inputs: Readonly<Record<string, FXExpr>>,
  resolvedT: FXValueType,
  fn: FXExprBuilderApi,
): FXExpr {
  const seed = fn.coerceNumeric(inputs["seed"] as FXExpr, resolvedT);
  return fn.mul(fn.add(inputs["p"] as FXExpr, seed), inputs["frequency"] as FXExpr);
}

const FRACTAL_INPUTS = {
  frequency: { type: "float", value: 1, min: 0, step: 0.01 },
  seed: { type: "float", value: 0, step: 0.01 },
  lacunarity: { type: "float", value: 2, min: 0, step: 0.01 },
  gain: { type: "float", value: 0.5, min: 0, max: 1, step: 0.01 },
} as const;

const OCTAVES_PARAM = {
  octaves: { kind: "structural", type: "enum", options: NOISE_OCTAVES, default: "1" },
} as const;

/**
 * Noise: value noise sampled at `(p + seed) * frequency`, a scalar in `[-1, 1]`. `octaves > 1`
 * sums normalized fBm (coordinate scaled by `lacunarity`, amplitude by `gain` per octave).
 */
export const fxNoise = defineNode({
  type: "noise",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NOISE_POSITIONS },
  inputs: { p: { type: "T", required: true }, ...FRACTAL_INPUTS },
  outputs: { out: { type: "float" } },
  params: OCTAVES_PARAM,
  cost: ({ params, resolvedT }) => {
    const call = costOf(FX_NOISE_CALL_COST, resolvedT.components, "noise");
    const octaves = parseOctaves(params.octaves);
    return octaves === 1 ? call : octaves * (call + OCTAVE_OVERHEAD);
  },
  build: ({ inputs, params, resolvedT, fn }) => {
    const octaves = parseOctaves(params.octaves);
    const coordinate = noiseCoordinate(inputs, resolvedT, fn);
    if (octaves === 1) {
      return { out: fn.call("noise", coordinate) };
    }
    return {
      out: fn.call(fixedFbmName(octaves), coordinate, inputs["lacunarity"], inputs["gain"]),
    };
  },
});

/**
 * Curl Noise: a divergence-free vector field from analytic noise gradients, so advected
 * particles swirl like smoke without piling up in sinks. Output magnitude is not normalized -
 * scale it downstream to taste.
 */
export const fxCurlNoise = defineNode({
  type: "curl-noise",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: PLANAR_POSITIONS },
  inputs: { p: { type: "T", required: true }, ...FRACTAL_INPUTS },
  outputs: { out: { type: "T" } },
  params: OCTAVES_PARAM,
  // 2D: one gradient sample per octave; 3D: one per potential channel (3).
  cost: ({ params, resolvedT }) => {
    const components = resolvedT.components;
    const samples = components === 2 ? 1 : 3;
    const perOctave =
      samples * costOf(FX_NOISED_CALL_COST, components, "curl-noise") + 3 * components;
    return parseOctaves(params.octaves) * (perOctave + OCTAVE_OVERHEAD);
  },
  build: ({ inputs, params, resolvedT, fn }) => ({
    out: fn.call(
      fixedCurlName(parseOctaves(params.octaves)),
      noiseCoordinate(inputs, resolvedT, fn),
      inputs["lacunarity"],
      inputs["gain"],
    ),
  }),
});

function parseChoice<T extends string>(raw: unknown, options: readonly T[], fallback: T): T {
  return options.find((option) => option === raw) ?? fallback;
}

/**
 * Voronoi: cellular noise at `(p + seed) * frequency`. `f1`/`f2` are the distances to the
 * nearest/second-nearest feature point, `edge = f2 - f1` (0 on cell borders), `cell` a [0, 1)
 * value per cell. `jitter` scatters the points (0 = regular grid). `fast` keeps `f1`/`cell`
 * reliable but `f2`/`edge` approximate; use `full` for clean edges.
 */
export const fxVoronoi = defineNode({
  type: "voronoi",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: PLANAR_POSITIONS },
  inputs: {
    p: { type: "T", required: true },
    frequency: FRACTAL_INPUTS.frequency,
    seed: FRACTAL_INPUTS.seed,
    jitter: { type: "float", value: 0.8, min: 0, max: 1, step: 0.01 },
  },
  outputs: {
    f1: { type: "float" },
    f2: { type: "float" },
    edge: { type: "float" },
    cell: { type: "float" },
  },
  params: {
    quality: { kind: "structural", type: "enum", options: FX_VORONOI_QUALITIES, default: "fast" },
    metric: { kind: "structural", type: "enum", options: FX_VORONOI_METRICS, default: "euclidean" },
  },
  // + coordinate (seed add, frequency mul) and the edge subtraction.
  cost: ({ params, resolvedT }) => {
    const quality = parseChoice(params.quality, FX_VORONOI_QUALITIES, "fast");
    return (
      costOf(FX_VORONOI_CALL_COST[quality], resolvedT.components, "voronoi") +
      2 * resolvedT.components +
      1
    );
  },
  build: ({ inputs, params, resolvedT, fn, local }) => {
    const quality: FXVoronoiQuality = parseChoice(params.quality, FX_VORONOI_QUALITIES, "fast");
    const metric: FXVoronoiMetric = parseChoice(params.metric, FX_VORONOI_METRICS, "euclidean");
    const cells = local(
      "voronoi",
      fn.call(
        voronoiFunctionName({ quality, metric }),
        noiseCoordinate(inputs, resolvedT, fn),
        inputs["jitter"],
      ),
    );
    const f1 = fn.swizzle(cells, "x");
    const f2 = fn.swizzle(cells, "y");
    return { f1, f2, edge: fn.sub(f2, f1), cell: fn.swizzle(cells, "z") };
  },
});

/** Result type and `[min, max)` range of the random-value nodes (`hash`, behavior `random`). */
export const RANDOM_RANGE = {
  inputs: {
    min: { type: "T", value: 0 },
    max: { type: "T", value: 1 },
  },
  params: {
    type: { kind: "structural", type: "valueType", options: NUMERIC_VALUE_TYPES, default: "float" },
  },
} as const;

/**
 * Hash: a stable random in `[min, max)` per `seed` (default: the particle id), each component
 * independent. Equal seeds give equal values; a different `salt` gives another, unrelated draw.
 */
export const fxHash = defineNode({
  type: "hash",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC_VALUE_TYPES },
  inputs: {
    seed: { type: "vec3", default: { targetInput: "PARTICLE_ID" } },
    salt: { type: "float", value: 0, step: 1 },
    ...RANDOM_RANGE.inputs,
  },
  outputs: { out: { type: "T" } },
  params: RANDOM_RANGE.params,
  // + the range mix.
  cost: ({ resolvedT }) =>
    FX_SEED_HASH_CALL_COST[resolvedT.components as FXSeedHashComponents] + 3 * resolvedT.components,
  build: ({ inputs, resolvedT, fn }) => {
    const components = resolvedT.components as FXSeedHashComponents;
    // A float id reaches here as is: the target-input default skips the socket's coercion.
    const seed = fn.coerceNumeric(inputs["seed"], FX_VALUE_TYPES.vec3);
    const unit = fn.call(seedHashFunctionName(components), seed, inputs["salt"]);
    return { out: fn.call("mix", inputs["min"], inputs["max"], unit) };
  },
});
