import { describe, expect, it } from "vitest";

import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  compileBehavior,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  FX_SEED_INPUT,
  particleBehaviorTargetsFor,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, storeAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

const FLOAT = FX_VALUE_TYPES.float;
const reg = behaviorRegistry();

/** A random stored in attribute `value` in `phase`. */
function randomIn(phase: FXBehaviorPhase): ReturnType<typeof graphOf> {
  return graphOf(
    { rng: reg.create("random"), store: storeAttr("value", FLOAT, phase) },
    [edge("rng", "out", "store", "value")],
    [bind(attributeSlot("value"), "store", "value")],
  );
}

describe("CPU random draws", () => {
  it("repeat from run to run", () => {
    const shape = graphOf(
      { shape: reg.create("random-sphere-point", { radius: 2 }) },
      [],
      [bind("position", "shape", "position")],
    );
    const first = runKernel(shape, { phase: "spawn", count: 16, seed: 3 }).position;
    const second = runKernel(shape, { phase: "spawn", count: 16, seed: 3 }).position;
    expect([...second]).toEqual([...first]);
  });

  it("are another draw in the update with another seed, and the same with the same", () => {
    const graph = randomIn(FXBehaviorPhase.UPDATE);
    const tick = (seed: number): number[] => [
      ...runKernel(graph, { phase: "update", count: 8, seed }).value,
    ];
    expect(tick(1)).toEqual(tick(1));
    expect(tick(2)).not.toEqual(tick(1));
  });

  it("hash the particle's id and the seed instead of calling Math.random", () => {
    const compiled = compileParticleBehavior(randomIn(FXBehaviorPhase.SPAWN));
    const body = compiled.spawn!.body.join("\n");
    expect(body).toContain("fxRandom(");
    expect(body).not.toContain("Math.random");
  });

  it("are a compile error on a target with no seed to hash", () => {
    const graph = randomIn(FXBehaviorPhase.SPAWN);
    const targets = particleBehaviorTargetsFor(graph);
    const unseeded = {
      ...targets,
      spawn: {
        ...targets.spawn,
        inputs: targets.spawn.inputs.filter((input) => input.name !== FX_SEED_INPUT.name),
      },
    };
    expect(() => compileBehavior(graph, unseeded)).toThrow(/random draw hashes/);
  });
});
