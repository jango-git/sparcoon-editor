import { describe, expect, it } from "vitest";
import type { FXEmitterTransform } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// `object-velocity` / `object-angular-velocity` are shared nodes: in behavior they read the
// emitter's world-space linear/angular velocity, which the runtime pushes as the `emitter`
// argument's `velocity`/`angularVelocity` fields each spawn/update call (see
// FXParticleBehaviorTarget's EMITTER_HOST_INPUTS/FX_EMITTER_INPUT_FIELD) - the same synthesized-
// input mechanism `worldMatrix` uses (stdBehaviorWorldMatrix.test.ts).

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const reg = behaviorRegistry();

/** An `FXEmitterTransform` fixture with an identity world matrix and the given motion. */
function fixture(
  velocity: readonly [number, number, number],
  angularVelocity: readonly [number, number, number],
): FXEmitterTransform {
  return { worldMatrix: IDENTITY_MATRIX, velocity, angularVelocity };
}

/** Binds `nodeType` (with the given inline input values) to `position`; runs one `phase` call. */
function positionOf(
  nodeType: string,
  emitter: FXEmitterTransform,
  params: Readonly<Record<string, unknown>> = {},
  phase: "spawn" | "update" = "spawn",
): [number, number, number] {
  const graph = graphOf(
    { source: reg.create(nodeType, params) },
    [],
    [bind("position", "source", "out", phase)],
  );
  const [x, y, z] = runKernel(graph, { phase, emitter }).position;
  return [x, y, z];
}

describe("behavior object-velocity / object-angular-velocity nodes", () => {
  it("object-velocity resolves to the emitter's world-space linear velocity at spawn", () => {
    const out = positionOf("object-velocity", fixture([1, 2, 3], [0, 0, 0]));
    expect(out).toEqual([1, 2, 3]);
  });

  it("object-angular-velocity resolves to the emitter's world-space angular velocity at spawn", () => {
    const out = positionOf("object-angular-velocity", fixture([0, 0, 0], [4, 5, 6]));
    expect(out).toEqual([4, 5, 6]);
  });

  it("both nodes are also legal in the update phase (EMITTER_HOST_INPUTS is shared)", () => {
    const velocity = positionOf("object-velocity", fixture([7, 8, 9], [0, 0, 0]), {}, "update");
    expect(velocity).toEqual([7, 8, 9]);
    const angularVelocity = positionOf(
      "object-angular-velocity",
      fixture([0, 0, 0], [10, 11, 12]),
      {},
      "update",
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
    // default, which positionOf's inline-param path does correctly override elsewhere below).
    const graph = graphOf(
      {
        velocity: reg.create("constant", { type: "vec3", value: [1, 0, 0] }),
        torque: reg.create("constant", { type: "vec3", value: [0, 0, 2] }),
        pv: reg.create("point-velocity", { offset: [0, 3, 0] }),
      },
      [edge("velocity", "out", "pv", "velocity"), edge("torque", "out", "pv", "torque")],
      [bind("position", "pv", "out", "spawn")],
    );
    // The emitter's own motion is deliberately different from the wired constants, proving the
    // wire wins over the objectVelocity/objectAngularVelocity default.
    const position = runKernel(graph, {
      phase: "spawn",
      emitter: fixture([99, 99, 99], [99, 99, 99]),
    }).position;
    EXPECTED.forEach((value, i) => expect(position[i]).toBeCloseTo(value, 6));
  });

  it("defaults velocity/torque to the emitter's object-velocity/object-torque builtins when unwired", () => {
    const out = positionOf("point-velocity", fixture([1, 0, 0], [0, 0, 2]), {
      offset: [0, 3, 0],
    });
    expect(out[0]).toBeCloseTo(EXPECTED[0], 6);
    expect(out[1]).toBeCloseTo(EXPECTED[1], 6);
    expect(out[2]).toBeCloseTo(EXPECTED[2], 6);
  });

  it("offset defaults to zero, reducing to the plain object velocity", () => {
    const out = positionOf("point-velocity", fixture([3, 4, 5], [1, 1, 1]));
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[1]).toBeCloseTo(4, 6);
    expect(out[2]).toBeCloseTo(5, 6);
  });
});
