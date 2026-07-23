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
  buildParticleUpdateKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";

// `object-velocity` / `object-angular-velocity` are shared nodes: in behavior they read the
// emitter's world-space linear/angular velocity, which the runtime pushes as the `emitter`
// argument's `velocity`/`angularVelocity` fields each spawn/update call (see
// FXParticleBehaviorTarget's EMITTER_HOST_INPUTS/FX_EMITTER_INPUT_FIELD) - the same synthesized-
// input mechanism `worldMatrix` uses (stdBehaviorWorldMatrix.test.ts).

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

/** An `FXEmitterTransform` fixture with an identity world matrix and the given motion. */
function fixture(
  velocity: readonly [number, number, number],
  angularVelocity: readonly [number, number, number],
): FXEmitterTransform {
  return { worldMatrix: IDENTITY_MATRIX, velocity, angularVelocity };
}

/** Binds `nodeType` (with the given inline input values) to `position` and runs one spawn call. */
function spawnPosition(
  nodeType: string,
  emitter: FXEmitterTransform,
  params: Readonly<Record<string, unknown>> = {},
): [number, number, number] {
  const r = registry();
  const graph = new FXGraph<FXBehaviorNode>();
  const connections: readonly FXConnection[] = [];
  graph.ingest({
    nodes: new Map([["source", r.create(nodeType, params)]]),
    connections,
    outputBindings: [bind("position", "source", "out", FXBehaviorPhase.SPAWN)],
  });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
  const spawn = buildParticleSpawnKernel(compiled);
  const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
  spawn(buffers, 0, 1, compiled.spawn!.bindings, emitter);
  return [buffers.position[0], buffers.position[1], buffers.position[2]];
}

/** Binds `nodeType` directly to the `position` slot at `phase` and runs one update call. */
function updatePosition(nodeType: string, emitter: FXEmitterTransform): [number, number, number] {
  const r = registry();
  const graph = new FXGraph<FXBehaviorNode>();
  const connections: readonly FXConnection[] = [];
  graph.ingest({
    nodes: new Map([["source", r.create(nodeType, {})]]),
    connections,
    outputBindings: [bind("position", "source", "out", FXBehaviorPhase.UPDATE)],
  });
  const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
  const update = buildParticleUpdateKernel(compiled);
  const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
  update(buffers, 1, 1, compiled.update.bindings, emitter);
  return [buffers.position[0], buffers.position[1], buffers.position[2]];
}

describe("behavior object-velocity / object-angular-velocity nodes", () => {
  it("object-velocity resolves to the emitter's world-space linear velocity at spawn", () => {
    const out = spawnPosition("object-velocity", fixture([1, 2, 3], [0, 0, 0]));
    expect(out).toEqual([1, 2, 3]);
  });

  it("object-angular-velocity resolves to the emitter's world-space angular velocity at spawn", () => {
    const out = spawnPosition("object-angular-velocity", fixture([0, 0, 0], [4, 5, 6]));
    expect(out).toEqual([4, 5, 6]);
  });

  it("both nodes are also legal in the update phase (EMITTER_HOST_INPUTS is shared)", () => {
    const velocity = updatePosition("object-velocity", fixture([7, 8, 9], [0, 0, 0]));
    expect(velocity).toEqual([7, 8, 9]);
    const angularVelocity = updatePosition(
      "object-angular-velocity",
      fixture([0, 0, 0], [10, 11, 12]),
    );
    expect(angularVelocity).toEqual([10, 11, 12]);
  });
});

describe("behavior point-velocity node", () => {
  // velocity=(1,0,0), torque=(0,0,2), offset=(0,3,0):
  // cross(torque, offset) = (0*0 - 2*3, 2*0 - 0*0, 0*3 - 0*0) = (-6, 0, 0)
  // out = velocity + cross = (-5, 0, 0)
  const EXPECTED: [number, number, number] = [-5, 0, 0];

  it("computes velocity + cross(torque, offset) from explicitly wired inputs", () => {
    // velocity/torque are wired from `constant` nodes (a `default: { targetInput }` socket takes
    // its override from a real connection, not an inline param - unlike `offset`'s plain `value`
    // default, which spawnPosition's inline-param path does correctly override elsewhere below).
    const r = registry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["velocity", r.create("constant", { type: "vec3", value: [1, 0, 0] })],
        ["torque", r.create("constant", { type: "vec3", value: [0, 0, 2] })],
        ["pv", r.create("point-velocity", { offset: [0, 3, 0] })],
      ]),
      connections: [
        edge("velocity", "out", "pv", "velocity"),
        edge("torque", "out", "pv", "torque"),
      ],
      outputBindings: [bind("position", "pv", "out", FXBehaviorPhase.SPAWN)],
    });
    const compiled = compileBehavior(graph, buildParticleBehaviorTargets());
    const spawn = buildParticleSpawnKernel(compiled);
    const buffers = { position: new Float32Array(3), lifecycle: new Float32Array(2) };
    // The emitter's own motion is deliberately different from the wired constants, proving the
    // wire wins over the objectVelocity/objectAngularVelocity default.
    spawn(buffers, 0, 1, compiled.spawn!.bindings, fixture([99, 99, 99], [99, 99, 99]));
    expect(buffers.position[0]).toBeCloseTo(EXPECTED[0], 6);
    expect(buffers.position[1]).toBeCloseTo(EXPECTED[1], 6);
    expect(buffers.position[2]).toBeCloseTo(EXPECTED[2], 6);
  });

  it("defaults velocity/torque to the emitter's object-velocity/object-torque builtins when unwired", () => {
    const out = spawnPosition("point-velocity", fixture([1, 0, 0], [0, 0, 2]), {
      offset: [0, 3, 0],
    });
    expect(out[0]).toBeCloseTo(EXPECTED[0], 6);
    expect(out[1]).toBeCloseTo(EXPECTED[1], 6);
    expect(out[2]).toBeCloseTo(EXPECTED[2], 6);
  });

  it("offset defaults to zero, reducing to the plain object velocity", () => {
    const out = spawnPosition("point-velocity", fixture([3, 4, 5], [1, 1, 1]));
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[1]).toBeCloseTo(4, 6);
    expect(out[2]).toBeCloseTo(5, 6);
  });
});
