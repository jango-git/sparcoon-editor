import { describe, expect, it } from "vitest";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXEmitterTransform } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// `world-matrix` / `inverse-world-matrix` are shared nodes: in behavior they read the emitter's
// world matrix, which the runtime pushes as the `emitter` argument (its `matrixWorld`). The
// inverse is computed in the sim - and since the world matrix is particle-invariant, the CSE +
// hoist pass lifts it out of the per-particle loop.

const reg = behaviorRegistry();

/** A column-major mat4 that translates by `offset`. */
function translation(offset: readonly [number, number, number]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset[0], offset[1], offset[2], 1];
}

/** An `FXEmitterTransform` fixture; these tests only exercise `worldMatrix`. */
function emitterTransform(worldMatrix: readonly number[]): FXEmitterTransform {
  return { worldMatrix, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
}

/** `matrixType` -> transform-point(1, 2, 3), bound to the spawn position. */
function transformedPointGraph(matrixType: string): FXGraph<FXBehaviorNode> {
  return graphOf(
    { m: reg.create(matrixType), tp: reg.create("transform-point", { p: [1, 2, 3] }) },
    [edge("m", "out", "tp", "m")],
    [bind("position", "tp", "out", "spawn")],
  );
}

describe("behavior world-matrix nodes", () => {
  it.each([
    // translate(+10) sends (1,2,3) to (11,2,3); its inverse, translate(-10), to (-9,2,3).
    ["world-matrix", [11, 2, 3]],
    ["inverse-world-matrix", [-9, 2, 3]],
  ] as const)("%s transforms a point by the emitter's world matrix", (type, expected) => {
    const position = runKernel(transformedPointGraph(type), {
      phase: "spawn",
      emitter: emitterTransform(translation([10, 0, 0])),
    }).position;
    expected.forEach((value, i) => expect(position[i]).toBeCloseTo(value, 5));
  });

  it("reads the emitter matrix once per invocation, not per particle (the inverse is hoisted)", () => {
    // Count element reads of the world matrix: a hoisted inverse reads it a fixed number of times
    // however many particles spawn, a per-particle one would scale with the count.
    const readsFor = (count: number): number => {
      let reads = 0;
      const worldMatrix = new Proxy(translation([10, 0, 0]), {
        get(target, key, receiver): unknown {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            reads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      runKernel(transformedPointGraph("inverse-world-matrix"), {
        phase: "spawn",
        count,
        emitter: emitterTransform(worldMatrix),
      });
      return reads;
    };
    expect(readsFor(1)).toBeGreaterThan(0);
    expect(readsFor(64)).toBe(readsFor(1));
  });
});
