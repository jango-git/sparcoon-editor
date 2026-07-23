import { describe, expect, it } from "vitest";
import { CAMERA_AXIS_DEGENERACY_THRESHOLD } from "../../src/engine/nodes-std/render/cameraSupport.Internal";

// `orthogonalTowardTarget` (cameraSupport.Internal.ts) builds an axis orthogonal to a fixed axis,
// as close as possible to a target direction - the primitive behind `align-to-velocity`'s
// camera-facing axis and `look-at-camera`'s locked-axis branches. It compiles to GLSL, which this
// repo cannot execute (no browser/WebGL - see CLAUDE.md), so this is a plain-number
// reimplementation of the same formula, tested directly - the same idea as `resolveAlignAxes`'s
// own pure-TS extraction in stdRenderMatrix.test.ts. It cannot catch a transcription bug in the
// real `fn.*` builder calls, which the structural "reads modelMatrix/cameraPosition" tests in
// stdRenderMatrix/stdRenderTransform cover.
//
// No formula makes the exact-parallel case well-defined (see the function's own doc comment - a
// hairy-ball-theorem-level obstruction, not an implementation gap), so "no discontinuity anywhere"
// is not a provable property and this file does not assert it. What IS provable, and what these
// tests check: the function is always finite/unit/orthogonal (even exactly at the singularity),
// and its blended fallback's influence is confined to the narrow band
// `CAMERA_AXIS_DEGENERACY_THRESHOLD` defines - outside that band it is indistinguishable from the
// plain (unblended) construction, however large the fallback-driven swing inside that band is for
// a given fixed axis/approach direction.

type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const magnitude = length(a);
  return magnitude === 0 ? [0, 0, 0] : [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude];
}
function mixVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
function stableHelperAxis(fixedAxis: Vec3): Vec3 {
  return Math.abs(fixedAxis[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
}
function orthogonalTowardTarget(fixedAxis: Vec3, targetDirection: Vec3): Vec3 {
  const directCross = cross(fixedAxis, targetDirection);
  const confidence = smoothstep(0, CAMERA_AXIS_DEGENERACY_THRESHOLD, length(directCross));
  const fallbackCross = cross(fixedAxis, stableHelperAxis(fixedAxis));
  const blended = mixVec(fallbackCross, directCross, confidence);
  return normalize(cross(blended, fixedAxis));
}

/** `targetDirection` at `degrees` off `fixedAxis`, swept through an arbitrary plane containing it. */
function targetAt(fixedAxis: Vec3, sidewaysAxis: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  return normalize([
    fixedAxis[0] * Math.cos(radians) + sidewaysAxis[0] * Math.sin(radians),
    fixedAxis[1] * Math.cos(radians) + sidewaysAxis[1] * Math.sin(radians),
    fixedAxis[2] * Math.cos(radians) + sidewaysAxis[2] * Math.sin(radians),
  ]);
}

const FIXED_AXES: ReadonlyMap<string, { readonly fixedAxis: Vec3; readonly sideways: Vec3 }> =
  new Map([
    ["world Z", { fixedAxis: [0, 0, 1], sideways: [1, 0, 0] }],
    ["world Y", { fixedAxis: [0, 1, 0], sideways: [0, 0, 1] }],
    ["a non-axis-aligned unit vector", { fixedAxis: normalize([1, 1, 1]), sideways: [1, -1, 0] }],
  ]);

describe("orthogonalTowardTarget (plain-number reimplementation)", () => {
  it.each([...FIXED_AXES.entries()])(
    "stays unit-length, orthogonal to the fixed axis, and finite through the full 0-180 degree sweep (%s)",
    (_label, { fixedAxis, sideways }) => {
      for (let degrees = 0; degrees <= 180; degrees += 0.5) {
        const reference = orthogonalTowardTarget(fixedAxis, targetAt(fixedAxis, sideways, degrees));
        for (const component of reference) {
          expect(Number.isFinite(component)).toBe(true);
        }
        expect(length(reference)).toBeCloseTo(1, 5);
        expect(dot(reference, fixedAxis)).toBeCloseTo(0, 5);
      }
    },
  );

  it.each([...FIXED_AXES.entries()])(
    "matches the plain (unblended) construction everywhere outside a narrow band around the singularity (%s)",
    (_label, { fixedAxis, sideways }) => {
      // asin(threshold) in degrees, times a generous safety margin: past this, confidence has
      // saturated to 1 and the fallback should have zero remaining influence on either side of
      // both singularities (0 and 180 degrees).
      const bandDegrees = ((Math.asin(CAMERA_AXIS_DEGENERACY_THRESHOLD) * 180) / Math.PI) * 5;
      for (let degrees = bandDegrees; degrees <= 180 - bandDegrees; degrees += 0.5) {
        const targetDirection = targetAt(fixedAxis, sideways, degrees);
        const reference = orthogonalTowardTarget(fixedAxis, targetDirection);
        const unblended = normalize(cross(cross(fixedAxis, targetDirection), fixedAxis));
        expect(dot(reference, unblended)).toBeCloseTo(1, 6);
      }
    },
  );

  it("at the exact singularity (target direction equal to the fixed axis), still returns a finite unit vector", () => {
    for (const { fixedAxis } of FIXED_AXES.values()) {
      const reference = orthogonalTowardTarget(fixedAxis, fixedAxis);
      for (const component of reference) {
        expect(Number.isFinite(component)).toBe(true);
      }
      expect(length(reference)).toBeCloseTo(1, 5);
    }
  });

  it("away from the singularity, matches the direct (non-blended) Gram-Schmidt-equivalent construction", () => {
    // At 90 degrees off the fixed axis, confidence is 1 (fully past the threshold) - the
    // fallback should have zero influence, so this should equal a plain cross-then-cross with no
    // blending at all: normalize(cross(cross(fixedAxis, targetDirection), fixedAxis)).
    const fixedAxis: Vec3 = [0, 0, 1];
    const targetDirection: Vec3 = [1, 0, 0];
    const reference = orthogonalTowardTarget(fixedAxis, targetDirection);
    const unblended = normalize(cross(cross(fixedAxis, targetDirection), fixedAxis));
    expect(dot(reference, unblended)).toBeCloseTo(1, 5);
  });
});
