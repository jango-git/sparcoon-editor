import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import type { FXEmitterTransform } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  buildParticleSpawnKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// `world-matrix` / `inverse-world-matrix` are shared nodes: in behavior they read the emitter's
// world matrix, which the runtime pushes as the `emitter` argument (its `matrixWorld`). The
// inverse is computed in the sim - and since the world matrix is particle-invariant, the CSE +
// hoist pass lifts it out of the per-particle loop.

function bind(
  slot: string,
  nodeId: string,
  socketKey: string,
  phase: FXBehaviorPhase,
): FXOutputBinding {
  return { slot, from: { nodeId, socketKey }, phase };
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

/** A column-major mat4 that translates by `offset`. */
function translation(offset: readonly [number, number, number]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset[0], offset[1], offset[2], 1];
}

/** An `FXEmitterTransform` fixture; these tests only exercise `worldMatrix`. */
function emitterTransform(worldMatrix: readonly number[]): FXEmitterTransform {
  return { worldMatrix, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
}

function spawnWorld(
  nodes: Map<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  terminal: string,
  emitter: FXEmitterTransform,
): [number, number, number] {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections,
    outputBindings: [bind("position", terminal, "out", FXBehaviorPhase.SPAWN)],
  });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
  const spawn = buildParticleSpawnKernel(compiled);
  const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
  spawn(buffers, 0, 1, compiled.spawn!.bindings, emitter);
  return [buffers.position[0], buffers.position[1], buffers.position[2]];
}

describe("behavior world-matrix nodes", () => {
  it("world-matrix transforms a point by the emitter's world matrix", () => {
    const r = registry();
    const out = spawnWorld(
      new Map([
        ["wm", r.create("world-matrix", {})],
        ["tp", r.create("transform-point", { p: [1, 2, 3] })],
      ]),
      [edge("wm", "out", "tp", "m")],
      "tp",
      emitterTransform(translation([10, 0, 0])),
    );
    expect(out[0]).toBeCloseTo(11, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it("inverse-world-matrix inverts the emitter matrix in-sim (world -> emitter space)", () => {
    const r = registry();
    const out = spawnWorld(
      new Map([
        ["iwm", r.create("inverse-world-matrix", {})],
        ["tp", r.create("transform-point", { p: [1, 2, 3] })],
      ]),
      [edge("iwm", "out", "tp", "m")],
      "tp",
      emitterTransform(translation([10, 0, 0])),
    );
    // inverse(translate(+10)) = translate(-10): (1,2,3) -> (-9,2,3).
    expect(out[0]).toBeCloseTo(-9, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it("hoists the emitter-matrix inverse out of the per-particle loop", () => {
    const r = registry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["iwm", r.create("inverse-world-matrix", {})],
        ["tp", r.create("transform-point", { p: [1, 2, 3] })],
      ]),
      connections: [edge("iwm", "out", "tp", "m")],
      outputBindings: [bind("position", "tp", "out", FXBehaviorPhase.SPAWN)],
    });
    const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
    // The world matrix (and hence its inverse) is particle-invariant, so the inverse's division
    // is emitted before the loop, not per particle.
    expect(compiled.spawn!.preLoop.join("\n")).toContain("/");
    expect(compiled.spawn!.body.join("\n")).not.toContain("/");
  });
});
