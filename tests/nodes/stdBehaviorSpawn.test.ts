import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { FX_BEHAVIOR_SPAWN_NODES } from "../../src/engine/nodes-std/behavior/spawn";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import type { FXAttributeRequest } from "../../src/engine/core/socket/FXAttribute";
import { attributeSlot, storeAttr } from "../helpers/attr";

// Only position (stride 3) and lifecycle (stride 2, `[age, lifetime]`) are core buffers.
// velocity/scale/seed are user attributes written through a `store-attribute` node
// (SPAWN phase) bound to `attr:<name>`; the kernel then writes their own named buffers.
// Spawn randomness is inline `Math.random()` (nondeterministic), so per-channel draws
// are asserted by RANGE/shape, not by an exact seeded value.
const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

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

/** Compiles a spawn graph against core + the requested attribute buffers and returns a runner. */
function spawnKernelOf(
  nodes: Map<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  out: readonly FXOutputBinding[],
  requests: readonly FXAttributeRequest[] = [],
): (buffers: Record<string, Float32Array>) => void {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({ nodes, connections, outputBindings: out });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets(requests));
  const spawn = buildParticleSpawnKernel(compiled);
  return (buffers: Record<string, Float32Array>): void =>
    spawn(buffers, 0, 1, compiled.spawn.bindings);
}

/** Core-only buffers (position vec3 + lifecycle vec3), one particle. */
function coreBuffers(extra: Readonly<Record<string, number>> = {}): Record<string, Float32Array> {
  const buffers: Record<string, Float32Array> = {
    position: new Float32Array(3),
    lifecycle: new Float32Array(3),
  };
  for (const [name, stride] of Object.entries(extra)) {
    buffers[name] = new Float32Array(stride);
  }
  return buffers;
}

describe("standard behavior spawn - registration & numerics", () => {
  it("registers every spawn definition and describes serializably", () => {
    const r = registry();
    for (const def of FX_BEHAVIOR_SPAWN_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("lifetime + a zero-size box write birth state (range midpoint is constant here)", () => {
    const r = registry();
    const kernel = spawnKernelOf(
      new Map([
        ["life", r.create("lifetime", { min: 2, max: 2 })],
        ["point", r.create("spawn-box", { size: [0, 0, 0], center: [1, 2, 3] })],
      ]),
      [],
      [bind("lifetime", "life", "value"), bind("position", "point", "position")],
    );
    const buffers = coreBuffers();
    kernel(buffers);
    expect(buffers.lifecycle[1]).toBe(2); // lifetime
    expect(buffers.position[0]).toBe(1);
    expect(buffers.position[1]).toBe(2);
    expect(buffers.position[2]).toBe(3);
  });

  it("resets an absent editable-input override to its default on a resident instance (L5)", () => {
    // The reset contract is node-agnostic; exercised here via `lifetime`'s editable input.
    const r = registry();
    const life = r.create("lifetime", { min: 3, max: 3 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["l", life]]),
      connections: [],
      outputBindings: [bind("lifetime", "l", "value")],
    });

    const c1 = compileBehavior(graph, buildParticleBehaviorTargets());
    const first = coreBuffers();
    buildParticleSpawnKernel(c1)(first, 0, 1, c1.spawn.bindings);
    expect(first.lifecycle[1]).toBe(3);

    // A snapshot omitting `min`/`max` (a "reset to default" serialized as key removal) resets
    // the resident instance to spec default min=max=1 (midpoint 1), not the last [3,3]. The
    // values are inline literals now, so they take effect on the next (re)compile.
    life.applyParams?.({});
    const c2 = compileBehavior(graph, buildParticleBehaviorTargets());
    const second = coreBuffers();
    buildParticleSpawnKernel(c2)(second, 0, 1, c2.spawn.bindings);
    expect(second.lifecycle[1]).toBe(1);
  });

  it("initial-velocity scales direction by the sampled speed", () => {
    const r = registry();
    const kernel = spawnKernelOf(
      new Map([
        ["v", r.create("initial-velocity", { direction: [0, 2, 0], speed: [1, 1] })],
        ["store", storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN)],
      ]),
      [edge("v", "velocity", "store", "value")],
      [bind(attributeSlot("velocity"), "store", "value")],
      [{ name: "velocity", type: VEC3 }],
    );
    const buffers = coreBuffers({ velocity: 3 });
    kernel(buffers);
    expect(buffers.velocity[1]).toBe(2);
  });

  it("spawn-sphere surfaceOnly is structural (moves the cacheKey)", () => {
    const r = registry();
    const volume = r.create("spawn-sphere", { surfaceOnly: false });
    const surface = r.create("spawn-sphere", { surfaceOnly: true });
    expect(volume.cacheKey?.()).not.toBe(surface.cacheKey?.());
  });

  /** Draws `count` spawn positions from a single position-emitting shape node. */
  function positionsOf(
    type: string,
    params: Readonly<Record<string, unknown>>,
    count = 400,
  ): [number, number, number][] {
    const r = registry();
    const kernel = spawnKernelOf(
      new Map([["shape", r.create(type, params)]]),
      [],
      [bind("position", "shape", "position")],
    );
    const out: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const buffers = coreBuffers();
      kernel(buffers);
      out.push([buffers.position[0], buffers.position[1], buffers.position[2]]);
    }
    return out;
  }

  it("spawn-box surface only places points on a face of the box", () => {
    for (const [x, y, z] of positionsOf("spawn-box", { size: [2, 2, 2], surfaceOnly: true })) {
      // Every point is inside the box and pinned to at least one face (|coord| ~ 1).
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(1 + 1e-6);
      const onAFace = [x, y, z].some((c) => Math.abs(Math.abs(c) - 1) < 1e-6);
      expect(onAFace).toBe(true);
    }
  });

  it("spawn-cylinder keeps points within radius and half-length about the Y axis", () => {
    for (const [x, y, z] of positionsOf("spawn-cylinder", { radius: 2, length: 4, axis: "y" })) {
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(2 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(2 + 1e-6); // half of length 4
    }
  });

  it("spawn-cylinder surface only pins points to the wall radius", () => {
    for (const [x, , z] of positionsOf("spawn-cylinder", {
      radius: 2,
      length: 4,
      surfaceOnly: true,
    })) {
      expect(Math.hypot(x, z)).toBeCloseTo(2, 5);
    }
  });

  it("spawn-cone tapers radius to zero at the apex height", () => {
    for (const [x, y, z] of positionsOf("spawn-cone", { radius: 2, height: 4, axis: "y" })) {
      const t = y / 4; // 0 at base, 1 at apex
      expect(t).toBeGreaterThanOrEqual(-1e-6);
      expect(t).toBeLessThanOrEqual(1 + 1e-6);
      // Radius at height t may not exceed the linearly-tapered edge radius.
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(2 * (1 - t) + 1e-4);
    }
  });

  it("spawn-torus stays within the tube of the ring", () => {
    for (const [x, y, z] of positionsOf("spawn-torus", { major: 3, minor: 0.5, axis: "y" })) {
      // Distance from the ring circle (radius=major in the XZ plane) is within the tube.
      const ringDist = Math.hypot(Math.hypot(x, z) - 3, y);
      expect(ringDist).toBeLessThanOrEqual(0.5 + 1e-5);
    }
  });

  it("spawn-disc scatters over an annulus in the plane perpendicular to the axis", () => {
    for (const [x, y, z] of positionsOf("spawn-disc", {
      innerRadius: 1,
      outerRadius: 2,
      axis: "y",
    })) {
      expect(Math.abs(y)).toBeLessThan(1e-6); // flat in the XZ plane
      const rad = Math.hypot(x, z);
      expect(rad).toBeGreaterThanOrEqual(1 - 1e-5);
      expect(rad).toBeLessThanOrEqual(2 + 1e-5);
    }
  });

  it("shape axis param reorients the sweep (cylinder about X keeps X as the length axis)", () => {
    for (const [x, y, z] of positionsOf("spawn-cylinder", { radius: 1, length: 4, axis: "x" })) {
      expect(Math.hypot(y, z)).toBeLessThanOrEqual(1 + 1e-6); // radial plane is YZ
      expect(Math.abs(x)).toBeLessThanOrEqual(2 + 1e-6); // length along X
    }
  });

  it("lifetime draws stay within its configured range", () => {
    // Randoms are inline Math.random() now, so a `[min, max]` draw is asserted by range
    // rather than a specific seeded value.
    const r = registry();
    const kernel = spawnKernelOf(
      new Map([["life", r.create("lifetime", { min: 0, max: 1 })]]),
      [],
      [bind("lifetime", "life", "value")],
    );
    for (let i = 0; i < 200; i++) {
      const buffers = coreBuffers();
      kernel(buffers);
      const life = buffers.lifecycle[1];
      expect(life).toBeGreaterThanOrEqual(0);
      expect(life).toBeLessThan(1);
    }
  });

  it("random draws a fresh per-particle value in [0, 1)", () => {
    const r = registry();
    const kernel = spawnKernelOf(
      new Map([
        ["rng", r.create("random", undefined)],
        ["store", storeAttr("seed", FLOAT, FXBehaviorPhase.SPAWN)],
      ]),
      [edge("rng", "out", "store", "value")],
      [bind(attributeSlot("seed"), "store", "value")],
      [{ name: "seed", type: FLOAT }],
    );
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const buffers = coreBuffers({ seed: 1 });
      kernel(buffers);
      expect(buffers.seed[0]).toBeGreaterThanOrEqual(0);
      expect(buffers.seed[0]).toBeLessThan(1);
      seen.add(buffers.seed[0]);
    }
    // Inline Math.random() -> a fresh draw each call (not a constant, not a seeded channel).
    expect(seen.size).toBeGreaterThan(1);
  });
});
