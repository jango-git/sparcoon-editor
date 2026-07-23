import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { FX_BEHAVIOR_FORCE_NODES } from "../../src/engine/nodes-std/behavior/forces";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileBehavior,
  previewBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";

// Velocity, scale, rotation, torque are now ordinary user attributes: a force node
// reads velocity through a `read-attribute` node and its result is persisted through a
// `store-attribute` node bound to `attr:velocity`; motion is an explicit
// `integrate-motion` node. So a force test asserts on the `velocity` attribute buffer
// (stride 3) - not a builtin offset - and, where it verified motion, wires the velocity
// into `integrate-motion` and asserts on the core `position` buffer.
const VEC3 = FX_VALUE_TYPES.vec3;
const OFF_Y = 1; // y within a stride-3 vec3 buffer (position or velocity)

/** Targets extended with the `velocity` vec3 attribute the graphs below write. */
const velocityTargets = buildParticleBehaviorTargets([{ name: "velocity", type: VEC3 }]);

/** Fresh per-particle state buffers (one particle) for the velocity-attribute targets. */
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

/**
 * read-attribute(velocity) -> gravity -> drag -> { store-attribute(velocity),
 * integrate-motion -> position }. The velocity attribute accumulates the force and the
 * new position is the explicit Euler step over the post-force velocity.
 */
function gravityDragGraph(
  r: FXNodeRegistry<FXBehaviorNode>,
  damping: number,
): { graph: FXGraph<FXBehaviorNode>; g: FXBehaviorNode } {
  const g = r.create("gravity", { acceleration: [0, -10, 0] });
  const d = r.create("drag", { damping });
  const im = r.create("integrate-motion", undefined);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["rv", readAttr("velocity", VEC3)],
      ["g", g],
      ["d", d],
      ["sv", storeAttr("velocity", VEC3)],
      ["im", im],
    ]),
    connections: [
      edge("rv", "value", "g", "velocity"),
      edge("g", "velocity", "d", "velocity"),
      edge("d", "velocity", "sv", "value"),
      edge("d", "velocity", "im", "velocity"),
    ],
    outputBindings: [
      bind(attributeSlot("velocity"), "sv", "value"),
      bind("position", "im", "position"),
    ],
  });
  return { graph, g };
}

describe("standard behavior forces - registration & numerics", () => {
  it("registers every force definition and describes serializably", () => {
    const r = registry();
    for (const def of FX_BEHAVIOR_FORCE_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("gravity -> drag(0) integrates v += a*dt and advances position", () => {
    const { graph } = gravityDragGraph(registry(), 0);
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = freshBuffers();
    update(buffers, 1, 0.5, compiled.update.bindings);
    expect(buffers.velocity[OFF_Y]).toBeCloseTo(-5, 6);
    expect(buffers.position[OFF_Y]).toBeCloseTo(-2.5, 6);
  });

  it("gravity -> drag(2) applies exponential damping", () => {
    const { graph } = gravityDragGraph(registry(), 2);
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = freshBuffers();
    update(buffers, 1, 0.5, compiled.update.bindings);
    expect(buffers.velocity[OFF_Y]).toBeCloseTo(-5 * Math.exp(-1), 6);
  });

  it("re-tuning gravity's acceleration moves the hash (inline literal -> recompile)", () => {
    const r = registry();
    const { graph, g } = gravityDragGraph(r, 0);
    const before = previewBehaviorHash(graph, velocityTargets);

    // Acceleration is an inline literal now (variant A), so editing it changes the hash.
    g.applyParams?.({ acceleration: [0, -20, 0] });
    expect(previewBehaviorHash(graph, velocityTargets)).not.toBe(before);

    // A fresh compile bakes the new value: v_y += -20 * 0.5 = -10.
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = freshBuffers();
    update(buffers, 1, 0.5, compiled.update.bindings);
    expect(buffers.velocity[OFF_Y]).toBeCloseTo(-10, 6);
  });

  it("point-force falloff is structural (moves the cacheKey)", () => {
    const r = registry();
    const inv = r.create("point-force", { falloff: "inverse-square" });
    const lin = r.create("point-force", { falloff: "linear" });
    expect(inv.cacheKey?.()).not.toBe(lin.cacheKey?.());
  });

  it("drag rejects a negative damping coefficient", () => {
    expect(() => registry().create("drag", { damping: -1 })).toThrow(/within/);
  });

  // Firework is now an instantaneous SPAWN-phase velocity seeder (no dt, no incoming
  // velocity, no position read): it hands each particle an outward burst velocity of
  // magnitude `strength` in a random direction inside the cone. Direction is random
  // (inline Math.random()), so it is asserted by the deterministic invariants - the
  // exact axis at angle 0, and constant speed / cone bounds at a positive angle.
  function fireworkVelocity(params: Record<string, unknown>): Float32Array {
    const r = registry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["n", r.create("firework", params)],
        ["sv", storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN)],
      ]),
      connections: [edge("n", "velocity", "sv", "value")],
      outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
    });
    const compiled = compileBehavior(graph, velocityTargets);
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = freshBuffers();
    spawn(buffers, 0, 1, compiled.spawn.bindings);
    return buffers.velocity;
  }

  it("firework at cone angle 0 seeds velocity straight up the axis (v = axis*strength)", () => {
    const velocity = fireworkVelocity({ strength: 4, angle: 0, axis: [0, 1, 0] });
    expect(velocity[0]).toBeCloseTo(0, 6);
    expect(velocity[OFF_Y]).toBeCloseTo(4, 6); // strength along +y
    expect(velocity[2]).toBeCloseTo(0, 6);
  });

  it("firework at a positive cone angle seeds a random outward burst of constant speed", () => {
    const strength = 4;
    const angle = 0.5;
    // Sample repeatedly: the direction is random, but every draw must be a unit direction
    // scaled by `strength` (constant speed) whose axis component stays inside the cone cap.
    for (let i = 0; i < 24; i += 1) {
      const [x, y, z] = fireworkVelocity({ strength, angle, axis: [0, 1, 0] });
      expect(Math.hypot(x, y, z)).toBeCloseTo(strength, 5); // |dir| = 1 -> speed = strength
      // axis (y) component = strength*cos(theta), theta in [0, angle].
      expect(y).toBeGreaterThanOrEqual(strength * Math.cos(angle) - 1e-4);
      expect(y).toBeLessThanOrEqual(strength + 1e-4);
    }
  });

  it("turbulence force compiles and produces finite velocity deltas", () => {
    for (const type of ["turbulence"]) {
      const r = registry();
      const node = r.create(type, { amplitude: 2, frequency: 1 });
      const graph = new FXGraph<FXBehaviorNode>();
      graph.ingest({
        nodes: new Map([
          ["n", node],
          ["sv", storeAttr("velocity", VEC3)],
        ]),
        connections: [edge("n", "velocity", "sv", "value")],
        outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
      });
      const compiled = compileBehavior(graph, velocityTargets);
      const update = buildParticleUpdateKernel(compiled);
      const buffers = freshBuffers();
      buffers.lifecycle[0] = 0.5; // age drives the field
      update(buffers, 1, 0.016, compiled.update.bindings);
      expect(Number.isFinite(buffers.velocity[OFF_Y])).toBe(true);
    }
  });

  it("turbulence's every velocity channel depends on the full 3D position, not just its own axis", () => {
    // Regression for a bug where each channel sampled a 1D fBm along only its own matching
    // position axis (velocity.y from position.y alone, etc.) - moving a particle along x would
    // then leave velocity.y/z bit-for-bit unchanged. fbm3 samples the whole position per channel.
    const r = registry();
    const node = r.create("turbulence", { amplitude: 2, frequency: 1, octaves: 4 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["n", node],
        ["sv", storeAttr("velocity", VEC3)],
      ]),
      connections: [edge("n", "velocity", "sv", "value")],
      outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
    });
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);
    const sampleAt = (x: number, y: number, z: number): Float32Array => {
      const buffers = freshBuffers();
      buffers.position[0] = x;
      buffers.position[1] = y;
      buffers.position[2] = z;
      buffers.lifecycle[0] = 0.5;
      update(buffers, 1, 0.016, compiled.update.bindings);
      return buffers.velocity;
    };
    const base = sampleAt(0, 0, 0);
    const movedAlongX = sampleAt(3.7, 0, 0);
    expect(movedAlongX[1]).not.toBeCloseTo(base[1], 4);
    expect(movedAlongX[2]).not.toBeCloseTo(base[2], 4);
  });

  it("turbulence compiles on the GPU (standard/GLSL) tier too, with one fbm3 call per channel", () => {
    // The JS/CPU backend (compileBehavior above) and this GLSL/GPU backend (transform-feedback
    // simulation) are two independent compilers over the same node - see
    // FXParticleBehaviorKernelStandard.Internal.ts. A real GLSL compiler is not available in this
    // headless container (same constraint as tests/core/behaviorKernelStandard.test.ts), so this
    // is a smoke test over the compiled GLSL text: it must compile without throwing, call the
    // vector-domain `fxFbm3` (not the 1D `fbm` the old per-axis implementation used) once per
    // velocity channel, with three distinct decorrelation offsets, and emit its helper exactly once.
    const r = registry();
    const node = r.create("turbulence", { amplitude: 2, frequency: 1 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["n", node],
        ["sv", storeAttr("velocity", VEC3)],
      ]),
      connections: [edge("n", "velocity", "sv", "value")],
      outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
    });
    const compiled = compileBehaviorStandard(graph, velocityTargets);
    const body = compiled.update.body.join("\n");
    expect(body).toContain("in_position");
    expect((body.match(/fxFbm3\(/g) ?? []).length).toBe(3);
    expect(body).toContain("vec3(0.0, 0.0, 0.0)");
    expect(body).toContain("vec3(19.1, 7.3, 41.9)");
    expect(body).toContain("vec3(41.3, 53.7, 11.7)");
    const fbm3Helpers = compiled.update.helpers.filter((helper) =>
      helper.includes("float fxFbm3("),
    );
    expect(fbm3Helpers).toHaveLength(1);
  });

  it("turbulence bounds octaves so a runaway value can't freeze the loop (B5)", () => {
    const r = registry();
    // octaves scales the fBm loop count, not the output. The param `max` gates it at
    // coerce (applyParams) - a runaway 1e8 from a scrub/bad snapshot is rejected, not
    // silently turned into particleCount * 1e8 iterations.
    expect(() => r.create("turbulence", { amplitude: 1, frequency: 1, octaves: 1e8 })).toThrow(
      /octaves must be within \[0, 8\]/,
    );

    // The in-range maximum compiles and runs finite (and the helper hard-clamps too,
    // as defense in depth for any path that bypasses coerce).
    const node = r.create("turbulence", { amplitude: 1, frequency: 1, octaves: 8 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["n", node],
        ["sv", storeAttr("velocity", VEC3)],
      ]),
      connections: [edge("n", "velocity", "sv", "value")],
      outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
    });
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = freshBuffers();
    buffers.lifecycle[0] = 0.5;
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect(Number.isFinite(buffers.velocity[OFF_Y])).toBe(true);
  });
});
