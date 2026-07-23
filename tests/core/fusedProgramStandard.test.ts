import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import type { FXCompiledPhaseStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { assembleTransformFeedbackProgram } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import {
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "sparcoon";

// Fuses a graph that exercises both host-owned rules the assembler must inject (spawn zero-
// defaults every buffer before the graph's own writes; update passes every buffer through
// unchanged before the graph's writes, except age, which always advances) - verified against the
// JS backend's own known-correct semantics (FXEmitter.tick()'s age loop, FXInstancedParticle.
// createInstances's zero-fill), not just "does this look like GLSL".

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

function compileMotionGraph() {
  const r = registry();
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })],
      ["life", r.create("lifetime", { min: 1, max: 2 })],
      ["gravity", r.create("gravity", { acceleration: [0, -9.81, 0] })],
      ["integrate", r.create("integrate-motion", {})],
    ]),
    connections: [
      {
        from: { nodeId: "gravity", socketKey: "velocity" },
        to: { nodeId: "integrate", socketKey: "velocity" },
      },
    ],
    outputBindings: [
      {
        slot: "position",
        from: { nodeId: "box", socketKey: "position" },
        phase: FXBehaviorPhase.SPAWN,
      },
      {
        slot: "lifetime",
        from: { nodeId: "life", socketKey: "value" },
        phase: FXBehaviorPhase.SPAWN,
      },
      {
        slot: "position",
        from: { nodeId: "integrate", socketKey: "position" },
        phase: FXBehaviorPhase.UPDATE,
      },
    ],
  });
  const compiled = compileBehaviorStandard(graph, buildParticleBehaviorTargets());
  return assembleTransformFeedbackProgram(compiled);
}

describe("fused transform-feedback program assembly", () => {
  it("declares one in/out attribute pair per state buffer, and the matching varying list", () => {
    const program = compileMotionGraph();
    expect(program.vertexSource).toContain("in vec3 in_position;");
    expect(program.vertexSource).toContain("in vec3 in_lifecycle;");
    expect(program.vertexSource).toContain("out vec3 out_position;");
    expect(program.vertexSource).toContain("out vec3 out_lifecycle;");
    expect(program.transformFeedbackVaryings).toEqual(["out_position", "out_lifecycle"]);
    expect(program.buffers.map((b) => b.name)).toEqual(["position", "lifecycle"]);
  });

  it("zero-defaults every buffer in the spawn branch before the graph's own writes", () => {
    const program = compileMotionGraph();
    const [birthBranch] = program.vertexSource.split("} else {");
    expect(birthBranch).toContain("out_position = vec3(0.0);");
    expect(birthBranch).toContain("out_lifecycle = vec3(0.0);");
    // The graph writes land after the default, so they win (textual order = assignment order).
    expect(birthBranch.indexOf("out_position = vec3(0.0);")).toBeLessThan(
      birthBranch.indexOf("out_position.x ="),
    );
  });

  it("assigns id from the running spawn-count uniform in the spawn branch - host-owned, no graph write slot exists for it", () => {
    const program = compileMotionGraph();
    const [birthBranch] = program.vertexSource.split("} else {");
    expect(birthBranch).toContain(
      `out_lifecycle.z = float(${FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM} + fx_relativeIndex);`,
    );
    expect(program.vertexSource).toContain(
      `uniform int ${FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM};`,
    );
  });

  it("passes every buffer through unchanged in the update branch, except age", () => {
    const program = compileMotionGraph();
    const [, updateBranch] = program.vertexSource.split("} else {");
    expect(updateBranch).toContain("out_position = in_position;");
    expect(updateBranch).toContain("out_lifecycle = in_lifecycle;");
    // Age always advances by dt, unconditionally - the GLSL analog of FXEmitter.tick()'s host-
    // owned age loop, which the graph has no write slot to override (lifetime has no update-phase
    // write slot at all, so its default pass-through is never overwritten - untested here directly
    // since nothing in this fixture writes it, matching the real target shape).
    expect(updateBranch).toContain(`out_lifecycle.x = in_lifecycle.x + u_fxDt;`);
  });

  it("computes birth range from the wraparound-safe spawn-range uniforms", () => {
    const program = compileMotionGraph();
    expect(program.vertexSource).toContain(
      `(fx_particleIndex - ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM} + ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM}) % ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM}`,
    );
    expect(program.vertexSource).toContain(
      `fx_relativeIndex < ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM}`,
    );
  });

  it("emits the rand helper exactly once even though only the spawn branch calls it", () => {
    const program = compileMotionGraph();
    const occurrences = program.vertexSource.split("float fxNextRandom(){").length - 1;
    expect(occurrences).toBe(1);
  });

  it("produces a valid, non-empty pass-through fragment shader (required to link, never rasterized)", () => {
    const program = compileMotionGraph();
    expect(program.fragmentSource).toContain("#version 300 es");
    expect(program.fragmentSource).toContain("void main()");
  });

  it("throws for a spawn-less compiled kernel rather than assembling an incomplete program", () => {
    // buildParticleBehaviorTargets() always includes a spawn target (particle behavior always
    // has both phases) - constructing the compiled shape directly is the only way to exercise
    // the "no spawn phase at all" guard for a genuinely update-only host target.
    const emptyPhase: FXCompiledPhaseStandard = {
      helpers: [],
      uniformDeclarations: [],
      body: [],
      writes: [],
      bindings: {},
      buffers: [],
      writtenBuffers: [],
    };
    expect(() =>
      assembleTransformFeedbackProgram({ spawn: undefined, update: emptyPhase, hash: "" }),
    ).toThrow(/requires a spawn phase/);
  });
});
