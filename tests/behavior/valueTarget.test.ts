import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  compileBehavior,
  validateBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { bind, fieldSpawnKernel, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";
import type { FXValueSlot } from "../helpers/valueTarget";
import { buildValueBehaviorTarget, VALUES_BUFFER } from "../helpers/valueTarget";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

/** progress (float) + tint (vec3) -> a 4-float `values` buffer. */
const SLOTS: readonly FXValueSlot[] = [
  { name: "progress", type: FLOAT },
  { name: "tint", type: VEC3 },
];
const targetFactory = (): ReturnType<typeof buildValueBehaviorTarget> =>
  buildValueBehaviorTarget(SLOTS);

const reg = behaviorRegistry();

/** Two `constant` update nodes writing the value slots directly. */
function valueGraph(progress: number, tint: readonly number[]): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      p: reg.create("constant", { type: "float", value: progress, phase: "update" }),
      t: reg.create("constant", { type: "vec3", value: tint, phase: "update" }),
    },
    [],
    [bind("progress", "p", "out"), bind("tint", "t", "out")],
  );
}

describe("update-only value behavior target", () => {
  it("compiles with no spawn phase", () => {
    const compiled = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    expect(compiled.spawn).toBeUndefined();
    expect(compiled.update).toBeDefined();
  });

  it("writes the graph's values into the buffer on update()", () => {
    const buffers = runKernel(valueGraph(0.5, [1, 0, 0]), { targets: targetFactory() });
    expect([...buffers[VALUES_BUFFER]]).toEqual([0.5, 1, 0, 0]);
  });

  it("throws a clear message when a spawn kernel is built (no spawn phase)", () => {
    const compiled = compileBehavior(valueGraph(0.5, [1, 0, 0]), targetFactory());
    expect(() => fieldSpawnKernel(compiled)).toThrow(/no spawn phase/);
  });

  it("rejects a reachable spawn node: validate names it, compile refuses outright", () => {
    const graph = graphOf(
      { s: reg.create("constant", { type: "float", value: 1, phase: "spawn" }) },
      [],
      [bind("progress", "s", "out")],
    );

    const result = validateBehavior(graph, targetFactory());
    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.code === "phase-not-supported")?.nodeId).toBe("s");
    expect(() => compileBehavior(graph, targetFactory())).toThrow();
  });
});
