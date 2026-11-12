import type { FXParticleKernelArtifact } from "sparcoon";
import { describe, expect, it } from "vitest";

import { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { assembleTransformFeedbackProgram } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import type { FXKernelContext } from "../../src/engine/behavior/FXKernelContext";
import { transformFeedbackUniformBudget } from "../../src/engine/behavior/FXKernelUniformsStandard.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_OBJECT_VELOCITY_INPUT } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import { add, lit, mul, ref } from "../../src/engine/core/ir/FXExprBuilder";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { gpuKernelArtifactBody } from "../../src/engine/emit/artifactLiterals";
import { assembleGpuKernelArtifact } from "../../src/engine/emit/assembleArtifacts";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import { GLSL_NAME } from "../helpers/glslNames";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

/** A behavior node of `phase` whose one output `out` (of `type`) is what `build` returns. */
class KernelTestNode extends FXBehaviorNode {
  public readonly type = "kernel-test";
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[];
  constructor(
    public readonly phase: FXBehaviorPhase,
    type: FXValueType,
    private readonly buildOut: (ctx: FXKernelContext) => FXExpr,
  ) {
    super();
    this.outputs = [{ key: "out", type }];
  }
  public build(ctx: FXKernelContext): void {
    ctx.setOutput("out", this.buildOut(ctx));
  }
}

/**
 * Spawn in a box, then gravity, drag and motion each update. Gravity starts from rest every pass (the
 * graph keeps no velocity), so the velocity it hands the motion depends on the pass's timestep alone.
 */
function compileDragGraph() {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["box", r.create("spawn-box", { size: [2, 2, 2], center: [0, 0, 0] })],
      ["life", r.create("lifetime", { min: 1, max: 2 })],
      ["gravity", r.create("gravity", { acceleration: [0, -9.81, 0] })],
      ["drag", r.create("drag", { damping: 1.5 })],
      ["integrate", r.create("integrate-motion", {})],
    ]),
    connections: [
      {
        from: { nodeId: "gravity", socketKey: "velocity" },
        to: { nodeId: "drag", socketKey: "velocity" },
      },
      {
        from: { nodeId: "drag", socketKey: "velocity" },
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
  return assembleTransformFeedbackProgram(
    compileBehaviorStandard(graph, buildParticleBehaviorTargets([])),
  );
}

describe("a GPU kernel's draw stage", () => {
  it("computes a timestep-only velocity once per pass, not per particle", () => {
    const program = compileDragGraph();
    const compute = program.draw?.stage.statements.join("\n") ?? "";
    expect(compute).toContain("inputs.deltaTime");
    expect(compute).toContain("Math.exp(");
    expect(program.vertexSource).not.toMatch(/exp\(\(- \(1\.5 \* /);
    const [name = "", type] = Object.entries(program.draw?.uniforms ?? {})[0] ?? [];
    expect(type).toBe(FX_VALUE_TYPES.vec3);
    expect(program.vertexSource).toContain(`uniform vec3 ${name};`);
  });

  it("fills its draw uniform with the velocity of the pass's timestep", () => {
    const artifact: FXParticleKernelArtifact = assembleGpuKernelArtifact(compileDragGraph());
    const name = Object.keys(artifact.bindings).find((key) =>
      Array.isArray(artifact.bindings[key].value),
    );
    if (name === undefined) {
      throw new Error("no draw uniform");
    }
    // Seeded at zero among the bindings, like any other.
    expect(artifact.bindings[name].value).toEqual([0, 0, 0]);
    const uniforms = { ...artifact.bindings, [name]: { value: [0, 0, 0] } };
    artifact.compute?.(
      {
        deltaTime: 0.5,
        worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      },
      uniforms,
    );
    const [x, y, z] = uniforms[name].value as number[];
    expect(x).toBe(0);
    expect(y).toBeCloseTo(-9.81 * 0.5 * Math.exp(-0.75), 5);
    expect(z).toBe(0);
  });

  it("lifts spawn's values only as far as update's bindings leave room in the one program", () => {
    /** Spawn: twice the emitter's velocity, one value for the pass. Update: `bindings` floats. */
    const compileWith = (bindings: number) => {
      // A few operations: worth a uniform where it fits (see `minimumCost`).
      const spawn = new KernelTestNode(FXBehaviorPhase.SPAWN, VEC3, (ctx) => {
        const velocity = ctx.readTargetInput(FX_OBJECT_VELOCITY_INPUT);
        return mul(add(mul(velocity, lit(2)), velocity), lit(3));
      });
      const update = new KernelTestNode(FXBehaviorPhase.UPDATE, FLOAT, (ctx) => {
        let first: FXExpr = lit(0);
        for (let index = 0; index < bindings; index += 1) {
          const handle = ctx.allocateBinding({ value: index, hint: "k" });
          if (index === 0) {
            first = ref("binding", handle.name, FLOAT);
          }
        }
        return first;
      });
      const graph = new FXGraph<FXBehaviorNode>();
      graph.ingest({
        nodes: new Map<string, FXBehaviorNode>([
          ["spawn", spawn],
          ["update", update],
        ]),
        connections: [],
        outputBindings: [
          {
            slot: "position",
            from: { nodeId: "spawn", socketKey: "out" },
            phase: FXBehaviorPhase.SPAWN,
          },
          {
            slot: "positionX",
            from: { nodeId: "update", socketKey: "out" },
            phase: FXBehaviorPhase.UPDATE,
          },
        ],
      });
      return compileBehaviorStandard(graph, buildParticleBehaviorTargets([]));
    };
    // With room to spare, spawn's value is computed once per pass.
    expect(compileWith(1).spawn?.draw).toBeDefined();
    // Update's bindings fill the program to Standard's minimum: spawn's value stays per particle.
    const full = compileWith(996);
    expect(full.spawn?.draw).toBeUndefined();
    expect(
      transformFeedbackUniformBudget([...(full.spawn?.uniforms ?? []), ...full.update.uniforms])(
        [],
      ),
    ).toBe(true);
  });

  it("names spawn's and update's values apart: one program holds both", () => {
    const program = compileDragGraph();
    const declared = [
      ...program.vertexSource.matchAll(
        new RegExp(String.raw`\b(?:uniform \w+|float|vec[234]|mat[234]) (${GLSL_NAME})\b`, "g"),
      ),
    ].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("prints its draw uniforms and compute into the exported kernel", () => {
    const body = gpuKernelArtifactBody(compileDragGraph());
    expect(body).toMatch(new RegExp(`"${GLSL_NAME}": \\{ value: \\[0,0,0\\] \\}`));
    expect(body).toContain("  compute(inputs, uniforms) {");
  });
});
