import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_LIFETIME } from "sparcoon";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";

const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

// Mirrors playground/main.ts: the standard node library drives the graphs, with the
// two not-yet-migrated resource/curve nodes registered by hand. Guards the param
// shapes the playground feeds (ranges as [min,max]) against the descriptors.

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

describe("playground graphs - standard registries + hand-written resource nodes", () => {
  it("compiles and runs the smoke behavior snapshot", () => {
    const r = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(r);

    // Executor model: velocity/rotation are user attributes now, not builtin slots.
    // Spawn seeds velocity + rotation into their attribute buffers; the update phase
    // reads velocity, runs the force chain (gravity -> turbulence -> drag), stores it
    // back (accumulate) and feeds it to integrate-motion (move).
    const nodes = new Map<string, FXBehaviorNode>([
      // spawn
      ["life", r.create("lifetime", { min: 4, max: 4 })],
      ["pos", r.create("spawn-box", { size: [0.8, 0, 0.8], center: [0, 0, 0] })],
      ["ivel", r.create("initial-velocity", { direction: [0, 1, 0], speed: [1.8, 2.6] })],
      ["storeVelSpawn", storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN)],
      ["rot", r.create("random")],
      ["storeRot", storeAttr("rotation", FLOAT, FXBehaviorPhase.SPAWN)],
      // update
      ["rv", readAttr("velocity", VEC3)],
      ["grav", r.create("gravity", { acceleration: [0, -1.2, 0] })],
      ["noise", r.create("turbulence", { amplitude: 0.6, frequency: 0.8 })],
      ["drag", r.create("drag", { damping: 0.6 })],
      ["storeVel", storeAttr("velocity", VEC3, FXBehaviorPhase.UPDATE)],
      ["move", r.create("integrate-motion")],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [
        edge("ivel", "velocity", "storeVelSpawn", "value"),
        edge("rot", "out", "storeRot", "value"),
        edge("rv", "value", "grav", "velocity"),
        edge("grav", "velocity", "noise", "velocity"),
        edge("noise", "velocity", "drag", "velocity"),
        edge("drag", "velocity", "storeVel", "value"),
        edge("drag", "velocity", "move", "velocity"),
      ],
      outputBindings: [
        bind("lifetime", "life", "value"),
        bind("position", "pos", "position"),
        bind(attributeSlot("velocity"), "storeVelSpawn", "value"),
        bind(attributeSlot("rotation"), "storeRot", "value"),
        bind(attributeSlot("velocity"), "storeVel", "value"),
        bind("position", "move", "position"),
      ],
    });

    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);
    const update = buildParticleUpdateKernel(compiled);
    // One Float32Array per state buffer the compiled kernel declares (core + attributes).
    const buffers: Record<string, Float32Array> = {};
    for (const buffer of compiled.update.buffers) {
      buffers[buffer.name] = new Float32Array(buffer.stride);
    }
    expect(() => spawn(buffers, 0, 1, compiled.spawn.bindings)).not.toThrow();
    expect(() => update(buffers, 1, 0.016, compiled.update.bindings)).not.toThrow();
    expect(buffers.lifecycle[FX_LIFETIME]).toBe(4); // lifetime (core lifecycle buffer)
    expect(Number.isFinite(buffers.velocity[1])).toBe(true); // velocity.y (attribute buffer)
  });

  it("compiles the smoke render graph (descriptor clip + color source)", () => {
    const r = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(r);

    const color = r.create("constant", { type: "color", value: [0.5, 0.5, 0.5, 0.5] });
    const clip = r.create("spherical-clip", { innerRadius: 0.35 });
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["color", color],
        ["clip", clip],
      ]),
      connections: [edge("color", "out", "clip", "color")],
      outputBindings: [bind("albedo", "clip", "color")],
    });

    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
  });
});
