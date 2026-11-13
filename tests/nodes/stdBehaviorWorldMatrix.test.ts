import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXEmitterTransform } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// `world-matrix` / `inverse-world-matrix` are shared nodes: in behavior they read the emitter's
// world matrix, which the runtime pushes as the `emitter` argument (its `matrixWorld`). The
// inverse is computed in the sim - and since an update's world matrix is particle-invariant, the
// CSE + hoist pass lifts it out of the per-particle loop. A spawn reads it as of each particle's
// birth instead: its translation moved back along the emitter's velocity by the newborn's age.

const reg = behaviorRegistry();

/** A column-major mat4 that translates by `offset`. */
function translation(offset: readonly [number, number, number]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset[0], offset[1], offset[2], 1];
}

/** An `FXEmitterTransform` fixture moving at `velocity`. */
function emitterTransform(
  worldMatrix: readonly number[],
  velocity: readonly number[] = [0, 0, 0],
): FXEmitterTransform {
  return { worldMatrix, velocity, angularVelocity: [0, 0, 0] };
}

/** `matrixType` -> transform-point(1, 2, 3), bound to the position of `phase`. */
function transformedPointGraph(
  matrixType: string,
  phase: "spawn" | "update" = "spawn",
): FXGraph<FXBehaviorNode> {
  return graphOf(
    { m: reg.create(matrixType), tp: reg.create("transform-point", { p: [1, 2, 3] }) },
    [edge("m", "out", "tp", "m")],
    [bind("position", "tp", "out", phase)],
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

  it.each([
    // Born 0.5 s before its tick's end by an emitter moving +4 x per second: from 2 units back.
    ["world-matrix", [9, 2, 3]],
    ["inverse-world-matrix", [-7, 2, 3]],
  ] as const)(
    "%s spawns from the emitter as it stood at the particle's birth",
    (type, expected) => {
      const position = runKernel(transformedPointGraph(type), {
        phase: "spawn",
        emitter: emitterTransform(translation([10, 0, 0]), [4, 0, 0]),
        state: { lifecycle: [0.5, 0, 0] },
      }).position;
      expected.forEach((value, i) => expect(position[i]).toBeCloseTo(value, 5));
    },
  );

  it("reads a spawn's emitter matrix once per invocation but its translation, which moves per birth", () => {
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
      runKernel(transformedPointGraph("world-matrix"), {
        phase: "spawn",
        count,
        emitter: emitterTransform(worldMatrix),
      });
      return reads;
    };
    expect(readsFor(64) - readsFor(1)).toBe(63 * 3);
  });

  it("reads an update's emitter matrix once per invocation, not per particle (the inverse is hoisted)", () => {
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
      runKernel(transformedPointGraph("inverse-world-matrix", "update"), {
        count,
        emitter: emitterTransform(worldMatrix),
      });
      return reads;
    };
    expect(readsFor(1)).toBeGreaterThan(0);
    expect(readsFor(64)).toBe(readsFor(1));
  });
});
