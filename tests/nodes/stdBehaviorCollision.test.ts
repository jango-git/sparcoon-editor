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
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";

// Collision nodes read velocity (through a `read-attribute` node) and position (through
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

/** read-attribute(velocity) -> <collision node> -> store-attribute(velocity). */
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
