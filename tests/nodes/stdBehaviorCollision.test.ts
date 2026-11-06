import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { FX_BEHAVIOR_COLLISION_NODES } from "../../src/engine/nodes-std/behavior/collision";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleUpdateKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";

// Collision nodes read velocity (through a `custom-attribute` node) and position (through
// their PARTICLE_POSITION default) and write a corrected velocity back to the `velocity`
// attribute. So a collision test seeds the position + velocity buffers and asserts on the
// post-update `velocity` attribute (stride 3).
const VEC3 = FX_VALUE_TYPES.vec3;
const X = 0;
const Y = 1;

const velocityTargets = buildParticleBehaviorTargets([{ name: "velocity", type: VEC3 }]);

function freshBuffers(): Record<string, Float32Array> {
  return {
    position: new Float32Array(3),
    lifecycle: new Float32Array(2),
    velocity: new Float32Array(3),
  };
}

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

/** custom-attribute(velocity) -> <collision node> -> store-attribute(velocity). */
function collisionGraph(
  r: FXNodeRegistry<FXBehaviorNode>,
  type: string,
  params: Readonly<Record<string, unknown>>,
): FXGraph<FXBehaviorNode> {
  const c = r.create(type, params);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["rv", readAttr("velocity", VEC3)],
      ["c", c],
      ["sv", storeAttr("velocity", VEC3)],
    ]),
    connections: [edge("rv", "value", "c", "velocity"), edge("c", "velocity", "sv", "value")],
    outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
  });
  return graph;
}

/** Compiles the graph and runs one update step over a single seeded particle. */
function runOneStep(
  graph: FXGraph<FXBehaviorNode>,
  position: readonly number[],
  velocity: readonly number[],
): Float32Array {
  const compiled = compileBehavior(graph, velocityTargets);
  const update = buildParticleUpdateKernel(compiled);
  const buffers = freshBuffers();
  buffers.position.set(position);
  buffers.velocity.set(velocity);
  update(buffers, 1, 0.016, compiled.update.bindings);
  return buffers.velocity;
}

describe("standard behavior collision - registration & numerics", () => {
  it("registers every collision definition and describes serializably", () => {
    const r = registry();
    for (const def of FX_BEHAVIOR_COLLISION_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("compiles every collision definition on the standard (GLSL) tier too", () => {
    for (const def of FX_BEHAVIOR_COLLISION_NODES) {
      const compiled = compileBehaviorStandard(
        collisionGraph(registry(), def.type, {}),
        velocityTargets,
      );
      expect(compiled.update.body.join("\n"), def.type).toContain("velocity");
    }
  });

  it("reflects the normal velocity by restitution when penetrating and approaching", () => {
    // Ground plane y=0, normal +Y. Particle at the surface moving straight down at 2.
    const graph = collisionGraph(registry(), "plane-collision", {
      point: [0, 0, 0],
      normal: [0, 1, 0],
      radius: 0.05,
      restitution: 0.5,
      friction: 0,
    });
    const v = runOneStep(graph, [0, 0, 0], [0, -2, 0]);
    // vn = -2, response_y = -restitution*vn = -0.5*(-2) = +1 (bounces up at half speed).
    expect(v[Y]).toBeCloseTo(1, 6);
    expect(v[X]).toBeCloseTo(0, 6);
  });

  it("damps the tangential velocity by friction", () => {
    const graph = collisionGraph(registry(), "plane-collision", {
      point: [0, 0, 0],
      normal: [0, 1, 0],
      radius: 0.05,
      restitution: 0,
      friction: 0.25,
    });
    const v = runOneStep(graph, [0, 0, 0], [4, -2, 0]);
    // tangential = [4,0,0] -> *(1-0.25)=3; normal reflected *0 -> 0.
    expect(v[X]).toBeCloseTo(3, 6);
    expect(v[Y]).toBeCloseTo(0, 6);
  });

  it("passes velocity through unchanged when the particle is outside the plane", () => {
    const graph = collisionGraph(registry(), "plane-collision", {
      point: [0, 0, 0],
      normal: [0, 1, 0],
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Well above the plane (sd = 1 >> radius): no contact, velocity untouched.
    const v = runOneStep(graph, [0, 1, 0], [0, -2, 0]);
    expect(v[Y]).toBeCloseTo(-2, 6);
  });

  it("ignores a particle already separating from the plane (no jitter)", () => {
    const graph = collisionGraph(registry(), "plane-collision", {
      point: [0, 0, 0],
      normal: [0, 1, 0],
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Inside the contact band but moving *away* (vn > 0): leave it be.
    const v = runOneStep(graph, [0, 0, 0], [0, 2, 0]);
    expect(v[Y]).toBeCloseTo(2, 6);
  });
});

describe("standard behavior collision - sphere-collision numerics", () => {
  it("reflects the normal velocity by restitution when penetrating and approaching", () => {
    // Unit sphere at the origin. Particle just inside the contact band on top, moving down at 2.
    const graph = collisionGraph(registry(), "sphere-collision", {
      center: [0, 0, 0],
      sphereRadius: 1,
      radius: 0.05,
      restitution: 0.5,
      friction: 0,
    });
    const v = runOneStep(graph, [0, 1, 0], [0, -2, 0]);
    // vn = -2, response_y = -restitution*vn = -0.5*(-2) = +1 (bounces up at half speed).
    expect(v[Y]).toBeCloseTo(1, 6);
    expect(v[X]).toBeCloseTo(0, 6);
  });

  it("damps the tangential velocity by friction", () => {
    const graph = collisionGraph(registry(), "sphere-collision", {
      center: [0, 0, 0],
      sphereRadius: 1,
      radius: 0.05,
      restitution: 0,
      friction: 0.25,
    });
    const v = runOneStep(graph, [0, 1, 0], [4, -2, 0]);
    // tangential = [4,0,0] -> *(1-0.25)=3; normal reflected *0 -> 0.
    expect(v[X]).toBeCloseTo(3, 6);
    expect(v[Y]).toBeCloseTo(0, 6);
  });

  it("passes velocity through unchanged when the particle is outside the sphere", () => {
    const graph = collisionGraph(registry(), "sphere-collision", {
      center: [0, 0, 0],
      sphereRadius: 1,
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Well clear of the surface (sd = 1 >> radius): no contact, velocity untouched.
    const v = runOneStep(graph, [0, 2, 0], [0, -2, 0]);
    expect(v[Y]).toBeCloseTo(-2, 6);
  });

  it("ignores a particle already separating from the sphere (no jitter)", () => {
    const graph = collisionGraph(registry(), "sphere-collision", {
      center: [0, 0, 0],
      sphereRadius: 1,
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Inside the contact band but moving *away* (vn > 0): leave it be.
    const v = runOneStep(graph, [0, 1, 0], [0, 2, 0]);
    expect(v[Y]).toBeCloseTo(2, 6);
  });
});

describe("standard behavior collision - box-collision numerics", () => {
  it("reflects the normal velocity by restitution when penetrating and approaching", () => {
    // Box of half-extents 1 at the origin. Particle just outside the top face, moving down at 2.
    const graph = collisionGraph(registry(), "box-collision", {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      radius: 0.05,
      restitution: 0.5,
      friction: 0,
    });
    const v = runOneStep(graph, [0, 1.02, 0], [0, -2, 0]);
    // vn = -2, response_y = -restitution*vn = -0.5*(-2) = +1 (bounces up at half speed).
    expect(v[Y]).toBeCloseTo(1, 6);
    expect(v[X]).toBeCloseTo(0, 6);
  });

  it("damps the tangential velocity by friction", () => {
    const graph = collisionGraph(registry(), "box-collision", {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      radius: 0.05,
      restitution: 0,
      friction: 0.25,
    });
    const v = runOneStep(graph, [0, 1.02, 0], [4, -2, 0]);
    // tangential = [4,0,0] -> *(1-0.25)=3; normal reflected *0 -> 0.
    expect(v[X]).toBeCloseTo(3, 6);
    expect(v[Y]).toBeCloseTo(0, 6);
  });

  it("passes velocity through unchanged when the particle is outside the box", () => {
    const graph = collisionGraph(registry(), "box-collision", {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Well clear of the top face (distance = 2 >> radius): no contact, velocity untouched.
    const v = runOneStep(graph, [0, 3, 0], [0, -2, 0]);
    expect(v[Y]).toBeCloseTo(-2, 6);
  });

  it("ignores a particle already separating from the box (no jitter)", () => {
    const graph = collisionGraph(registry(), "box-collision", {
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      radius: 0.05,
      restitution: 1,
      friction: 0,
    });
    // Inside the contact band but moving *away* (vn > 0): leave it be.
    const v = runOneStep(graph, [0, 1.02, 0], [0, 2, 0]);
    expect(v[Y]).toBeCloseTo(2, 6);
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
    return collisionGraph(registry(), "cone-collision", { ...frustum, ...physics, ...over });
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
