import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// Collision nodes read velocity (through a `custom-attribute` node) and position (through
// their PARTICLE_POSITION default) and write a corrected velocity back to the `velocity`
// attribute. So a collision test seeds the position + velocity buffers and asserts on the
// post-update `velocity` attribute (stride 3).
const VEC3 = FX_VALUE_TYPES.vec3;
const X = 0;
const Y = 1;
const reg = behaviorRegistry();

/** custom-attribute(velocity) -> <collision node> -> store-attribute(velocity). */
function collisionGraph(
  type: string,
  params: Readonly<Record<string, unknown>>,
): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      rv: readAttr("velocity", VEC3),
      c: reg.create(type, params),
      sv: storeAttr("velocity", VEC3),
    },
    [edge("rv", "value", "c", "velocity"), edge("c", "velocity", "sv", "value")],
    [bind(attributeSlot("velocity"), "sv", "value")],
  );
}

/** Runs one update step over a single seeded particle; returns its post-step velocity. */
function runOneStep(
  graph: FXGraph<FXBehaviorNode>,
  position: readonly number[],
  velocity: readonly number[],
): Float32Array {
  return runKernel(graph, { state: { position, velocity } }).velocity;
}

// Each shape is probed from its +Y face: `contact` sits inside the contact band (radius 0.05),
// `clear` is well outside it.
const SHAPES = [
  {
    type: "plane-collision",
    shape: { point: [0, 0, 0], normal: [0, 1, 0] },
    contact: [0, 0, 0],
    clear: [0, 1, 0],
  },
  {
    type: "sphere-collision",
    shape: { center: [0, 0, 0], sphereRadius: 1 },
    contact: [0, 1, 0],
    clear: [0, 2, 0],
  },
  {
    type: "box-collision",
    shape: { center: [0, 0, 0], halfExtents: [1, 1, 1] },
    contact: [0, 1.02, 0],
    clear: [0, 3, 0],
  },
] as const;

describe.each(SHAPES)("$type numerics", ({ type, shape, contact, clear }) => {
  const collider = (restitution: number, friction: number): FXGraph<FXBehaviorNode> =>
    collisionGraph(type, { ...shape, radius: 0.05, restitution, friction });

  it("reflects the normal velocity by restitution when in contact and approaching", () => {
    const v = runOneStep(collider(0.5, 0), contact, [0, -2, 0]);
    // vn = -2, response_y = -restitution*vn = -0.5*(-2) = +1 (bounces up at half speed).
    expect(v[Y]).toBeCloseTo(1, 6);
    expect(v[X]).toBeCloseTo(0, 6);
  });

  it("damps the tangential velocity by friction", () => {
    const v = runOneStep(collider(0, 0.25), contact, [4, -2, 0]);
    // tangential = [4,0,0] -> *(1-0.25)=3; normal reflected *0 -> 0.
    expect(v[X]).toBeCloseTo(3, 6);
    expect(v[Y]).toBeCloseTo(0, 6);
  });

  it("passes velocity through unchanged when the particle is clear of the surface", () => {
    expect(runOneStep(collider(1, 0), clear, [0, -2, 0])[Y]).toBeCloseTo(-2, 6);
  });

  it("ignores a particle already separating from the surface (no jitter)", () => {
    // Inside the contact band but moving away (vn > 0): left alone.
    expect(runOneStep(collider(1, 0), contact, [0, 2, 0])[Y]).toBeCloseTo(2, 6);
  });
});

describe("standard behavior collision - cone-collision numerics", () => {
  const Z = 2;
  // Truncated cone about +Y: base radius 1 at y=0, top radius 0.5 at y=1. Its slanted side runs
  // from (r, h) = (1, 0) to (0.5, 1), so its outward normal in the (r, h) plane is (2, 1)/sqrt(5).
  const frustum = {
    center: [0, 0, 0],
    axis: [0, 1, 0],
    height: 1,
    bottomRadius: 1,
    topRadius: 0.5,
  };
  const physics = { radius: 0.05, restitution: 0.5, friction: 0 };

  function cone(over: Readonly<Record<string, unknown>> = {}): FXGraph<FXBehaviorNode> {
    return collisionGraph("cone-collision", { ...frustum, ...physics, ...over });
  }

  it("reflects off the slanted side along its outward normal", () => {
    // At h = 0.5 the side is at r = 0.75; the particle sits just outside it, moving toward the axis.
    // n = (2, 1)/sqrt(5); vn = -4/sqrt(5); vN = n*vn = (-1.6, -0.8); vT = v - vN = (-0.4, 0.8);
    // response = vT - 0.5*vN = (0.4, 1.2).
    const v = runOneStep(cone(), [0.76, 0.5, 0], [-2, 0, 0]);
    expect(v[X]).toBeCloseTo(0.4, 5);
    expect(v[Y]).toBeCloseTo(1.2, 5);
    expect(v[Z]).toBeCloseTo(0, 5);
  });

  it("reflects off the bottom and top caps along the axis", () => {
    const fromBelow = runOneStep(cone(), [0.3, -0.02, 0], [0, 2, 0]);
    expect(fromBelow[Y]).toBeCloseTo(-1, 5);
    const fromAbove = runOneStep(cone(), [0.2, 1.02, 0], [0, -2, 0]);
    expect(fromAbove[Y]).toBeCloseTo(1, 5);
  });

  it("works in any direction the radial offset points", () => {
    // The side hit from the first test, turned 90 degrees about the axis (radial = +Z).
    const v = runOneStep(cone(), [0, 0.5, 0.76], [0, 0, -2]);
    expect(v[Z]).toBeCloseTo(0.4, 5);
    expect(v[Y]).toBeCloseTo(1.2, 5);
    expect(v[X]).toBeCloseTo(0, 5);
  });

  it("is a plain cone at topRadius 0: a particle falling onto the apex bounces straight up", () => {
    // Exactly on the axis: the radial direction is undefined there and must not poison the result.
    const v = runOneStep(cone({ topRadius: 0 }), [0, 1.02, 0], [0, -2, 0]);
    expect(v[Y]).toBeCloseTo(1, 5);
    expect(v[X]).toBeCloseTo(0, 5);
    expect(v[Z]).toBeCloseTo(0, 5);
  });

  it("pushes a particle inside the solid out through the nearest surface", () => {
    // Inside, near the side (r = 0.7 < 0.75): moving deeper is reflected outward like a hit...
    const deeper = runOneStep(cone(), [0.7, 0.5, 0], [-2, 0, 0]);
    expect(deeper[X]).toBeCloseTo(0.4, 5);
    expect(deeper[Y]).toBeCloseTo(1.2, 5);
    // ...while already moving out it is left alone.
    const leaving = runOneStep(cone(), [0.7, 0.5, 0], [2, 0, 0]);
    expect(leaving[X]).toBeCloseTo(2, 5);
    expect(leaving[Y]).toBeCloseTo(0, 5);
  });

  it("passes velocity through unchanged away from the cone or when separating", () => {
    const far = runOneStep(cone(), [3, 0.5, 0], [-2, 0, 0]);
    expect(far[X]).toBeCloseTo(-2, 5);
    const separating = runOneStep(cone(), [0.76, 0.5, 0], [2, 0, 0]);
    expect(separating[X]).toBeCloseTo(2, 5);
    // Above the top cap but out past its rim, beyond the contact band of every edge.
    const pastRim = runOneStep(cone(), [0.8, 1.1, 0], [0, -2, 0]);
    expect(pastRim[Y]).toBeCloseTo(-2, 5);
  });

  it("follows an arbitrary axis and center", () => {
    // Laid along +X from x = 2: the top cap faces +X at x = 3.
    const v = runOneStep(cone({ center: [2, 0, 0], axis: [1, 0, 0] }), [3.02, 0.2, 0], [-2, 0, 0]);
    expect(v[X]).toBeCloseTo(1, 5);
    expect(v[Y]).toBeCloseTo(0, 5);
  });

  it("falls back to +Y for a zero-length axis", () => {
    const v = runOneStep(cone({ axis: [0, 0, 0] }), [0.2, 1.02, 0], [0, -2, 0]);
    expect(v[Y]).toBeCloseTo(1, 5);
  });

  it("pushes a particle on the axis of a thin cylinder out sideways, finitely", () => {
    // topRadius == bottomRadius: a cylinder of radius 0.1, height 4. Halfway up, on the axis, the
    // side is the nearest surface, in no particular radial direction - the node falls back to one
    // perpendicular to the axis (+Z for a +Y axis). Moving along -Z is moving into that side.
    const v = runOneStep(
      cone({ bottomRadius: 0.1, topRadius: 0.1, height: 4 }),
      [0, 2, 0],
      [0, 0, -2],
    );
    expect(v[Z]).toBeCloseTo(1, 5);
    expect(v[X]).toBeCloseTo(0, 5);
    expect(v[Y]).toBeCloseTo(0, 5);
  });

  it("stays finite for degenerate dimensions", () => {
    // (A negative dimension can only arrive through a wire - inline values are range-checked - and
    // is clamped to 0 by the node, i.e. it lands on these same cases.)
    for (const over of [
      { height: 0 },
      { bottomRadius: 0, topRadius: 0 },
      { height: 0, bottomRadius: 0, topRadius: 0 },
    ]) {
      const v = runOneStep(cone(over), [0.1, 0.01, 0], [0, -2, 0]);
      expect([...v].every((component) => Number.isFinite(component))).toBe(true);
    }
  });
});
