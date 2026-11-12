import { FX_AGE, FX_CORE_LIFECYCLE, FX_LIFETIME } from "sparcoon";
import { describe, expect, it } from "vitest";

import { sinkMeta, UPDATE_SINK_TYPE } from "../../src/domain/sinkMeta";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { assembleTransformFeedbackProgram } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import { FX_KILL_SLOT } from "../../src/engine/behavior/FXKernelLifecycle.Internal";
import { validateKernelTarget } from "../../src/engine/behavior/FXKernelTargetValidation.Internal";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import type { FXKernelTarget } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { readAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

const reg = behaviorRegistry();

function killedBy(value: number, phase?: "spawn" | "update"): FXGraph<FXBehaviorNode> {
  return graphOf(
    { k: reg.create("constant", { type: "float", value }) },
    [],
    [bind(FX_KILL_SLOT, "k", "out", phase)],
  );
}

/** A plane at y = 0 whose contact kills. */
function killedOnContact(): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      v: readAttr("velocity", FX_VALUE_TYPES.vec3),
      c: reg.create("plane-collision", { point: [0, 0, 0], normal: [0, 1, 0], radius: 0.05 }),
      life: reg.create("lifetime", { min: 1, max: 1 }),
    },
    [edge("v", "value", "c", "velocity")],
    [bind(FX_KILL_SLOT, "c", "contact"), bind("lifetime", "life", "value", "spawn")],
  );
}

function ageAfterUpdate(graph: FXGraph<FXBehaviorNode>, position: readonly number[]): number {
  const state = { position, velocity: [0, -2, 0], [FX_CORE_LIFECYCLE]: [0.2, 1, 0] };
  return runKernel(graph, { state })[FX_CORE_LIFECYCLE][FX_AGE];
}

describe("kill", () => {
  it("brings a killed particle's age up to its lifetime, leaving the lifetime alone", () => {
    const lifecycle = runKernel(killedBy(1), {
      state: { [FX_CORE_LIFECYCLE]: [0.2, 1, 0] },
    })[FX_CORE_LIFECYCLE];
    expect(lifecycle[FX_AGE]).toBe(1);
    expect(lifecycle[FX_LIFETIME]).toBe(1);
  });

  it("leaves a particle alive while the kill value is at or below the threshold", () => {
    const lifecycle = runKernel(killedBy(0.5), {
      state: { [FX_CORE_LIFECYCLE]: [0.2, 1, 0] },
    })[FX_CORE_LIFECYCLE];
    expect(lifecycle[FX_AGE]).toBeCloseTo(0.2, 6);
  });

  it("kills on a collider's contact only", () => {
    expect(ageAfterUpdate(killedOnContact(), [0, 0, 0])).toBe(1);
    expect(ageAfterUpdate(killedOnContact(), [0, 1, 0])).toBeCloseTo(0.2, 6);
  });

  it("marks the lifecycle buffer written only when the graph kills", () => {
    expect(compileParticleBehavior(killedBy(1)).update.writtenBuffers).toContain(FX_CORE_LIFECYCLE);
    expect(compileParticleBehavior(graphOf({}, [], [])).update.writtenBuffers).not.toContain(
      FX_CORE_LIFECYCLE,
    );
  });

  it("cannot be bound at spawn", () => {
    expect(() => compileParticleBehavior(killedBy(1, "spawn"))).toThrow();
  });

  it("kills in the GPU program's age epilogue, before aging", () => {
    const targets = buildParticleBehaviorTargets([{ name: "velocity", type: FX_VALUE_TYPES.vec3 }]);
    const compiled = compileBehaviorStandard(killedOnContact(), targets);
    const program = assembleTransformFeedbackProgram(compiled);
    expect(compiled.update.kill).toBeDefined();
    expect(program.vertexSource).toContain(
      `(${compiled.update.kill ?? ""} > 0.5 ? max(in_lifecycle.x, in_lifecycle.y) : in_lifecycle.x) + u_fxDt`,
    );
  });

  it("is a socket of the update sink, not of the spawn sink", () => {
    const kill = sinkMeta(UPDATE_SINK_TYPE).inputs.find((socket) => socket.key === FX_KILL_SLOT);
    expect(kill?.type).toBe("float");
    expect(buildParticleBehaviorTargets().spawn.killSlot).toBeUndefined();
  });

  it("is refused on a spawn target and on a target without the lifecycle buffer", () => {
    const { update } = buildParticleBehaviorTargets();
    const codes = (target: FXKernelTarget, phase: "spawn" | "update"): string[] =>
      validateKernelTarget(target, phase).map((error) => error.code);
    expect(codes(update, "update")).toEqual([]);
    expect(codes(update, "spawn")).toContain("kill-slot-in-spawn");
    const withoutLifecycle: FXKernelTarget = {
      ...update,
      buffers: update.buffers.filter((buffer) => buffer.name !== FX_CORE_LIFECYCLE),
      inputs: update.inputs.filter((input) => input.buffer !== FX_CORE_LIFECYCLE),
      outputs: update.outputs.filter((output) => output.buffer !== FX_CORE_LIFECYCLE),
    };
    expect(codes(withoutLifecycle, "update")).toContain("kill-slot-needs-lifecycle");
  });
});
