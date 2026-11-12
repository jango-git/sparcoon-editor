import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import {
  CAMERA_AXIS_DEGENERACY_THRESHOLD,
  orthogonalTowardTarget,
} from "../../src/engine/nodes-std/render/cameraSupport.Internal";
import { readAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";

// `orthogonalTowardTarget` builds an axis orthogonal to a fixed axis, as close as possible to a
// target direction - the primitive behind `align-to-velocity`'s camera-facing axis and
// `look-at-camera`'s locked-axis branches. Those nodes are render-only (GLSL, not executable
// here), so a test-only shared node wraps the real IR primitive and the behavior (JS) backend
// evaluates it, one particle per sampled direction.
//
// No formula makes the exact-parallel case well-defined (a hairy-ball-theorem-level obstruction,
// see the function's doc comment), so "no discontinuity anywhere" is not asserted. What is
// checked: the result is always finite/unit/orthogonal (even exactly at the singularity), and
// the blended fallback's influence is confined to the narrow band
// `CAMERA_AXIS_DEGENERACY_THRESHOLD` defines - outside it the result equals the plain
// (unblended) construction.

type Vec3 = readonly [number, number, number];
const VEC3 = FX_VALUE_TYPES.vec3;

const orthogonalDef = defineNode({
  type: "test-orthogonal-toward-target",
  domain: "shared",
  category: "math",
  inputs: {
    fixedAxis: { type: "vec3", required: true },
    targetDirection: { type: "vec3", required: true },
  },
  outputs: { out: { type: "vec3" } },
  params: {},
  cost: 0,
  build: ({ inputs, local, fn }) => ({
    out: orthogonalTowardTarget(inputs["fixedAxis"], inputs["targetDirection"], local, fn),
  }),
});

/** Evaluates the primitive for each (fixedAxis, targetDirection) pair in one kernel run. */
function orthogonalTowardTargetAll(pairs: readonly (readonly [Vec3, Vec3])[]): Vec3[] {
  const graph = graphOf(
    {
      fixed: readAttr("fixedAxis", VEC3),
      target: readAttr("targetDirection", VEC3),
      n: orthogonalDef.createInstance("behavior") as unknown as FXBehaviorNode,
    },
    [edge("fixed", "value", "n", "fixedAxis"), edge("target", "value", "n", "targetDirection")],
    [bind("position", "n", "out")],
  );
  const position = runKernel(graph, {
    count: pairs.length,
    state: {
      fixedAxis: pairs.flatMap(([fixedAxis]) => fixedAxis),
      targetDirection: pairs.flatMap(([, targetDirection]) => targetDirection),
    },
  }).position;
  return pairs.map((_, i) => [position[i * 3], position[i * 3 + 1], position[i * 3 + 2]]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const magnitude = Math.sqrt(dot(a, a));
  return [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude];
}

/** `targetDirection` at `degrees` off `fixedAxis`, swept through a plane containing it. */
function targetAt(fixedAxis: Vec3, sidewaysAxis: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(radians), Math.sin(radians)];
  return normalize([
    fixedAxis[0] * c + sidewaysAxis[0] * s,
    fixedAxis[1] * c + sidewaysAxis[1] * s,
    fixedAxis[2] * c + sidewaysAxis[2] * s,
  ]);
}

/** Degree samples of a sweep from `from` to `to` in 0.5-degree steps. */
function sweep(from: number, to: number): number[] {
  const out: number[] = [];
  for (let degrees = from; degrees <= to; degrees += 0.5) {
    out.push(degrees);
  }
  return out;
}

const FIXED_AXES: readonly (readonly [string, Vec3, Vec3])[] = [
  ["world Z", [0, 0, 1], [1, 0, 0]],
  ["world Y", [0, 1, 0], [0, 0, 1]],
  // A non-axis-aligned unit axis, swept through a perpendicular sideways direction.
  ["a non-axis-aligned unit vector", normalize([1, 1, 1]), normalize([1, -1, 0])],
];

function expectFiniteUnit(reference: Vec3): void {
  expect(reference.every(Number.isFinite)).toBe(true);
  expect(Math.sqrt(dot(reference, reference))).toBeCloseTo(1, 5);
}

describe("orthogonalTowardTarget (evaluated on the behavior backend)", () => {
  it.each(FIXED_AXES)(
    "stays unit-length, orthogonal to the fixed axis, and finite through the full 0-180 degree sweep (%s)",
    (_label, fixedAxis, sideways) => {
      const degrees = sweep(0, 180);
      const results = orthogonalTowardTargetAll(
        degrees.map((d) => [fixedAxis, targetAt(fixedAxis, sideways, d)] as const),
      );
      for (const reference of results) {
        expectFiniteUnit(reference);
        expect(dot(reference, fixedAxis)).toBeCloseTo(0, 5);
      }
    },
  );

  it.each(FIXED_AXES)(
    "matches the plain (unblended) construction everywhere outside a narrow band around the singularity (%s)",
    (_label, fixedAxis, sideways) => {
      // asin(threshold) in degrees, times a generous safety margin: past this, confidence has
      // saturated to 1 and the fallback has no influence on either side of both singularities.
      const band = ((Math.asin(CAMERA_AXIS_DEGENERACY_THRESHOLD) * 180) / Math.PI) * 5;
      const targets = sweep(band, 180 - band).map((d) => targetAt(fixedAxis, sideways, d));
      const results = orthogonalTowardTargetAll(targets.map((t) => [fixedAxis, t] as const));
      results.forEach((reference, i) => {
        const unblended = normalize(cross(cross(fixedAxis, targets[i]), fixedAxis));
        expect(dot(reference, unblended)).toBeCloseTo(1, 5);
      });
    },
  );

  it("at the exact singularity (target direction equal to the fixed axis), still returns a finite unit vector", () => {
    const results = orthogonalTowardTargetAll(
      FIXED_AXES.map(([, fixedAxis]) => [fixedAxis, fixedAxis] as const),
    );
    results.forEach((reference, i) => {
      expectFiniteUnit(reference);
      expect(dot(reference, FIXED_AXES[i][1])).toBeCloseTo(0, 5);
    });
  });
});
