import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import type { FXCurveData } from "../../core/nodes/FXParamSpec";
import { DEFAULT_CURVE } from "../../core/nodes/FXParamSpec";

/**
 * Inline curve baking (adaptive Catmull-Rom) and the `ramp` node, shared by both backends. A
 * `curve` param bakes into a piecewise-linear `mix` chain at compile time, so it works in GLSL and JS alike.
 */

/**
 * Hard cap on baked curve knots: adaptive placement stops splitting once it hits this many, so
 * the emitted `mix` chain never exceeds `CURVE_MAX_POINTS - 1` segments - a shader-cost ceiling.
 */
const CURVE_MAX_POINTS = 32;

/**
 * Target error for adaptive knot placement, as a fraction of the curve's output range (so it's
 * invariant to output units); ~`1/256` matches the precision of an 8-bit LUT.
 */
const CURVE_ERROR_FRACTION = 1 / 256;

/** A curve anchor as consumed by the bake: sorted position, output value, and smoothing flag. */
interface FXCurveAnchor {
  readonly position: number;
  readonly value: number;
  readonly smooth: boolean;
}

/**
 * Catmull-Rom slope (dy/dx) at anchor `i`, from the finite difference of its neighbours
 * (one-sided at the ends). A sharp anchor never uses it (its segments are forced linear).
 */
function anchorSlope(anchors: readonly FXCurveAnchor[], i: number): number {
  const current = anchors[i];
  if (current === undefined) {
    throw new Error("anchorSlope: index out of range for anchors array");
  }
  const previousAnchor = anchors[i - 1] ?? current;
  const nextAnchor = anchors[i + 1] ?? current;
  const positionDelta = nextAnchor.position - previousAnchor.position;
  return positionDelta > 1e-6 ? (nextAnchor.value - previousAnchor.value) / positionDelta : 0;
}

/**
 * Samples the smoothed curve at normalized `p`. A segment is a cubic Hermite with Catmull-Rom
 * tangents when *both* endpoints are `smooth`; if either is `sharp` it stays linear (a clean corner).
 */
function sampleCurveAnchors(anchors: readonly FXCurveAnchor[], position: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("sampleCurveAnchors: anchors array must not be empty");
  }
  if (position <= first.position) {
    return first.value;
  }
  if (position >= last.position) {
    return last.value;
  }
  let i = 0;
  while (i < anchors.length - 1) {
    const nextAnchor = anchors[i + 1];
    if (nextAnchor === undefined || nextAnchor.position > position) {
      break;
    }
    i++;
  }
  const segmentStart = anchors[i];
  const segmentEnd = anchors[i + 1];
  if (segmentStart === undefined || segmentEnd === undefined) {
    throw new Error("sampleCurveAnchors: segment index out of range during curve sampling");
  }
  const span = segmentEnd.position - segmentStart.position;
  if (span <= 1e-6) {
    return segmentEnd.value;
  }
  const t = (position - segmentStart.position) / span;
  if (!segmentStart.smooth || !segmentEnd.smooth) {
    return segmentStart.value + (segmentEnd.value - segmentStart.value) * t;
  }
  // Cubic Hermite; tangents scaled by the span so they are in output units, not per-unit-x.
  const tangent0 = anchorSlope(anchors, i) * span;
  const tangent1 = anchorSlope(anchors, i + 1) * span;
  const tSquared = t * t;
  const tCubed = tSquared * t;
  return (
    (2 * tCubed - 3 * tSquared + 1) * segmentStart.value +
    (tCubed - 2 * tSquared + t) * tangent0 +
    (-2 * tCubed + 3 * tSquared) * segmentEnd.value +
    (tCubed - tSquared) * tangent1
  );
}

/** A baked knot: normalized position and the smoothed curve's value there. */
interface FXCurveKnot {
  readonly position: number;
  readonly value: number;
}

/**
 * Chooses where to sample the smoothed curve, adaptively. Every anchor is a mandatory knot (so a
 * `sharp` corner is reproduced exactly), then it greedily splits the segment with the worst
 * linear-reconstruction error at its midpoint until every segment is within `epsilon` or
 * {@link CURVE_MAX_POINTS} is spent - a straight line collapses to a single segment.
 */
function adaptiveCurveKnots(
  anchors: readonly FXCurveAnchor[],
  epsilon: number,
  maxPoints: number,
): FXCurveKnot[] {
  const sampleAt = (position: number): number => sampleCurveAnchors(anchors, position);
  // Mandatory knots: domain endpoints + every anchor position (clamped into [0, 1]), deduped.
  const positions = new Set<number>([0, 1]);
  for (const anchor of anchors) {
    positions.add(Math.min(1, Math.max(0, anchor.position)));
  }
  const knots: FXCurveKnot[] = [...positions]
    .sort((a, b) => a - b)
    .map((position) => ({ position, value: sampleAt(position) }));

  while (knots.length < maxPoints) {
    let worstError = epsilon;
    let worstIndex = -1;
    let worstMid = 0;
    let worstValue = 0;
    for (let i = 0; i < knots.length - 1; i++) {
      const segmentStart = knots[i];
      const segmentEnd = knots[i + 1];
      if (segmentStart === undefined || segmentEnd === undefined) {
        continue;
      }
      const mid = 0.5 * (segmentStart.position + segmentEnd.position);
      // Segment too narrow to split further without a degenerate (zero-span) sub-segment.
      if (mid <= segmentStart.position || mid >= segmentEnd.position) {
        continue;
      }
      const trueValue = sampleAt(mid);
      const error = Math.abs(trueValue - 0.5 * (segmentStart.value + segmentEnd.value));
      if (error > worstError) {
        worstError = error;
        worstIndex = i;
        worstMid = mid;
        worstValue = trueValue;
      }
    }
    if (worstIndex < 0) {
      break; // every segment within epsilon (or unsplittable)
    }
    knots.splice(worstIndex + 1, 0, { position: worstMid, value: worstValue });
  }
  return knots;
}

function curveAnchors(curve: FXCurveData): FXCurveAnchor[] {
  return curve.points
    .map((point) => ({
      position: point.position,
      value: point.value,
      smooth: point.interpolation !== "sharp",
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * The knots an editable scalar curve bakes to, adaptively placed (see {@link adaptiveCurveKnots})
 * - shared by {@link evalCurve} and {@link fxRamp}'s cost, so the cost estimate reflects the
 * exact segment count `build` will emit, not a stand-in.
 */
function bakedCurveKnots(curve: FXCurveData): FXCurveKnot[] {
  const anchors = curveAnchors(curve);
  if (anchors.length === 0) {
    return [];
  }
  // Scale the error tolerance by the output range so it is invariant to the curve's units; a flat
  // curve (range ~0) then never subdivides.
  const values = anchors.map((anchor) => anchor.value);
  const range = Math.max(...values) - Math.min(...values);
  const epsilon = Math.max(range, 1e-6) * CURVE_ERROR_FRACTION;
  return adaptiveCurveKnots(anchors, epsilon, CURVE_MAX_POINTS);
}

/**
 * Bakes an editable scalar curve into an IR expression: pre-sampled in JS at adaptively placed
 * knots, then emitted as a piecewise-linear `mix` chain over those literals (the float twin of
 * the gradient evaluator in `shared/color.ts`) - no LUT, no texture.
 */
function evalCurve(curve: FXCurveData, t: FXExpr, fn: FXExprBuilderApi): FXExpr {
  const knots = bakedCurveKnots(curve);
  const firstKnot = knots[0];
  // Guarded above (coerce keeps points finite), but stay defensive: an empty curve is flat 0.
  if (firstKnot === undefined) {
    return fn.lit(0);
  }
  let value: FXExpr = fn.lit(firstKnot.value);
  for (let i = 0; i < knots.length - 1; i++) {
    const segmentStart = knots[i];
    const segmentEnd = knots[i + 1];
    if (segmentStart === undefined || segmentEnd === undefined) {
      continue;
    }
    const span = segmentEnd.position - segmentStart.position;
    const inverseSpan = span > 1e-9 ? 1 / span : 0;
    const localT = fn.call(
      "clamp",
      fn.mul(fn.sub(t, fn.lit(segmentStart.position)), fn.lit(inverseSpan)),
      fn.lit(0),
      fn.lit(1),
    );
    value = fn.call("mix", value, fn.lit(segmentEnd.value), localT);
  }
  return value;
}

/**
 * Curve: remaps a scalar `t` through an editable curve whose anchors are individually `smooth`
 * (Catmull-Rom) or `sharp` (linear corner). Bakes inline, unlike the behavior-only `value`/`curve` LUT.
 */
export const fxRamp = defineNode({
  type: "ramp",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  inputs: { t: { type: "float", value: 0, min: 0, max: 1, step: 0.01 } },
  outputs: { out: { type: "float" } },
  params: {
    curve: { kind: "structural", type: "curve", default: DEFAULT_CURVE },
  },
  // Each baked segment is a localT clamp (sub+mul+clamp(2) = 4) + a scalar mix (sub+mul+add = 3),
  // so 7 per segment. Runs the same adaptive placement `build` does, so the segment count is
  // exact, not a stand-in.
  cost: ({ params }) => {
    const knotCount = bakedCurveKnots(params.curve as FXCurveData).length;
    return Math.max(1, knotCount - 1) * 7;
  },
  build: ({ inputs, params, fn, local }) => ({
    out: local("curveValue", evalCurve(params.curve, inputs["t"], fn)),
  }),
});
