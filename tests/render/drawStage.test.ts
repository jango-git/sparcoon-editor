import type { FXDrawInputs, FXRenderArtifact, FXValueSlot } from "sparcoon";
import { describe, expect, it } from "vitest";

import { liftDrawStage } from "../../src/engine/core/codegen/drawStage.Internal";
import { buildDrawCompute } from "../../src/engine/core/codegen/drawStageBuild.Internal";
import { classifyRates } from "../../src/engine/core/codegen/rates.Internal";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import { add, lit, mul, ref, swizzle } from "../../src/engine/core/ir/FXExprBuilder";
import { isImpureFunction } from "../../src/engine/core/ir/FXFunctions.Internal";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import { RENDER_DRAW_INPUTS } from "../../src/engine/render/compiler/FXRenderDrawInputs.Internal";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { FX_INPUT_RATE_RANK, renderRatePolicy } from "../../src/engine/render/target/FXTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { fullRenderRegistry } from "../helpers/stdRegistry";

const reg = fullRenderRegistry();
const compiler = new FXCompilerStandard();
const FLOAT = FX_VALUE_TYPES.float;

/** Runs `shader`'s draw stage for one tick and returns its uniforms' values by name. */
function computed(
  shader: FXCompiledShader,
  inputs: Partial<FXDrawInputs>,
): Record<string, unknown> {
  const uniforms: Record<string, FXValueSlot<number | number[]>> = {};
  for (const [name, handle] of Object.entries(shader.uniforms)) {
    const value = handle.value as number | number[];
    uniforms[name] = { value: Array.isArray(value) ? [...value] : value };
  }
  const stage = shader.draw;
  if (stage === undefined) {
    throw new Error("no draw stage");
  }
  buildDrawCompute<NonNullable<FXRenderArtifact["compute"]>>(stage)(
    {
      time: 0,
      deltaTime: 0,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      objectVelocity: [0, 0, 0],
      objectAngularVelocity: [0, 0, 0],
      seed: 0,
      ...inputs,
    },
    uniforms,
  );
  return Object.fromEntries(Object.entries(uniforms).map(([name, slot]) => [name, slot.value]));
}

describe("the draw stage, compiled", () => {
  it("inverts the pose once per tick: the inverse moves a point back by the translation", () => {
    const graph = graphOf(
      {
        iwm: reg.create("inverse-world-matrix"),
        tp: reg.create("transform-point", { p: [1, 2, 3] }),
        compose: reg.create("compose-transform"),
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
      },
      [edge("iwm", "out", "tp", "m"), edge("tp", "out", "compose", "position")],
      [bind("particleTransform", "compose", "out"), bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const transform = shader.color.outputs["particleTransform"] ?? "";
    const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const matrix = computed(shader, { modelMatrix: pose })[transform] as number[];
    expect(matrix.slice(12, 15)).toEqual([-4, 2, 3]);
  });

  it("keeps a constant on the GPU and never makes it a uniform", () => {
    const graph = graphOf(
      {
        col: reg.create("constant", { type: "color", value: [1, 0.5, 0.25, 1] }),
      },
      [],
      [bind("albedo", "col", "out")],
    );
    const shader = compiler.compile(graph, FX_MESH_TARGET);
    expect(shader.draw).toBeUndefined();
    expect(Object.keys(shader.uniforms)).toEqual([]);
  });
});

/** A local for `liftDrawStage`: its name, IR and type. */
function local(name: string, expr: FXExpr, type: FXValueType = FLOAT) {
  return { name, expr, type };
}
const time = ref("targetInput", "u_time", FLOAT);
const uv = ref("targetInput", "p_uv", FX_VALUE_TYPES.vec2);

/** Lifts `fragment` (no vertex locals) with slots reading `slots`, every root fitting unless not. */
function lift(
  fragment: ReturnType<typeof local>[],
  slots: string[],
  fits = true,
): ReturnType<typeof liftDrawStage<ReturnType<typeof local>>> {
  const rates = classifyRates(fragment, renderRatePolicy(FX_PARTICLE_TARGET, isImpureFunction));
  let next = 0;
  return liftDrawStage([[], fragment], [new Set(), new Set(slots)], rates, {
    ...RENDER_DRAW_INPUTS,
    rate: FX_INPUT_RATE_RANK.frame,
    minimumCost: [3, 0],
    fits: () => fits,
    declareUniform: () => `u_draw_${String(next++)}`,
  });
}

/** Lifts `vertex` (no fragment locals) with vertex slots reading `slots`. */
function liftVertex(
  vertex: ReturnType<typeof local>[],
  slots: string[],
): ReturnType<typeof liftDrawStage<ReturnType<typeof local>>> {
  const rates = classifyRates(vertex, renderRatePolicy(FX_PARTICLE_TARGET, isImpureFunction));
  let next = 0;
  return liftDrawStage([vertex, []], [new Set(slots), new Set()], rates, {
    ...RENDER_DRAW_INPUTS,
    rate: FX_INPUT_RATE_RANK.frame,
    minimumCost: [3, 0],
    fits: () => true,
    declareUniform: () => `u_draw_${String(next++)}`,
  });
}

describe("liftDrawStage - what a value must cost", () => {
  const age = ref("targetInput", "PARTICLE_AGE", FLOAT);

  it("leaves a value of an operation or two to the vertex stage", () => {
    const lifted = liftVertex(
      [local("fast", mul(time, lit(2))), local("shade", mul(ref("local", "fast", FLOAT), age))],
      ["shade"],
    );
    expect(lifted.stage).toBeUndefined();
    expect(lifted.stages[0].map((each) => each.name)).toEqual(["fast", "shade"]);
  });

  it("lifts a vertex value of a few operations", () => {
    const lifted = liftVertex(
      [
        local("fast", add(mul(add(time, lit(1)), lit(2)), lit(3))),
        local("shade", mul(ref("local", "fast", FLOAT), age)),
      ],
      ["shade"],
    );
    expect(lifted.stages[0].map((each) => each.name)).toEqual(["shade"]);
  });

  it("lifts a fragment value of any cost", () => {
    const lifted = lift(
      [
        local("fast", mul(time, lit(2))),
        local(
          "shade",
          mul(ref("local", "fast", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
      ],
      ["shade"],
    );
    expect(lifted.stages[1].map((each) => each.name)).toEqual(["shade"]);
  });
});

describe("liftDrawStage", () => {
  it("makes only what the GPU reads a uniform, computing the rest on the CPU alone", () => {
    const lifted = lift(
      [
        local("scaled", mul(time, lit(2))),
        local("wave", add(ref("local", "scaled", FLOAT), lit(1))),
        local(
          "shade",
          mul(ref("local", "wave", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
      ],
      ["shade"],
    );
    expect(lifted.stages[1].map((each) => each.name)).toEqual(["shade"]);
    expect(lifted.stage?.statements.join("\n")).toContain('uniforms["u_draw_0"].value = wave;');
  });

  it("computes an alias read on the GPU and by a lifted value on both sides (and ends)", () => {
    // `clock` costs nothing (an alias of the uniform) and both the GPU and `fast` read it.
    const lifted = lift(
      [
        local("clock", time),
        local("fast", mul(ref("local", "clock", FLOAT), lit(3))),
        local(
          "out",
          add(
            mul(ref("local", "clock", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
            ref("local", "fast", FLOAT),
          ),
        ),
      ],
      ["out"],
    );
    // `fast` lifts; `clock`, an alias, is computed on both sides (on the CPU, read through) and
    // never a uniform.
    const statements = lifted.stage?.statements.join("\n") ?? "";
    expect(statements).toContain("const fast = ((inputs.time * 3));");
    expect(statements).toContain('uniforms["u_draw_0"].value = fast;');
    expect(lifted.stages[1].map((each) => each.name)).toEqual(["clock", "out"]);
  });

  it("keeps a shared alias an output slot reads, dropping one nothing on the GPU reads", () => {
    const lifted = lift(
      [
        local("clock", time),
        local("unused", time),
        local("fast", mul(ref("local", "unused", FLOAT), lit(3))),
        local(
          "shade",
          mul(ref("local", "fast", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
      ],
      ["clock", "shade"],
    );
    expect(lifted.stages[1].map((each) => each.name)).toEqual(["clock", "shade"]);
  });

  it("drops a dead local, which may read a value only the CPU computes", () => {
    const lifted = lift(
      [
        local("wave", mul(time, lit(2))),
        local("raised", add(ref("local", "wave", FLOAT), lit(1))),
        local(
          "dead",
          mul(ref("local", "wave", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
        local(
          "shade",
          mul(ref("local", "raised", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
      ],
      ["shade"],
    );
    expect(lifted.stages[1].map((each) => each.name)).toEqual(["shade"]);
  });

  it("reads a vector's component apart from a value named like that component", () => {
    const VEC3 = FX_VALUE_TYPES.vec3;
    const lifted = lift(
      [
        local("tinted", mul(ref("uniform", "u_param_tint", VEC3), time), VEC3),
        local(
          "sum",
          add(
            swizzle(ref("local", "tinted", VEC3), "x"),
            mul(ref("uniform", "u_param_tint_x", FLOAT), time),
          ),
        ),
        local(
          "shade",
          mul(ref("local", "sum", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
        ),
      ],
      ["shade"],
    );
    const statements = lifted.stage?.statements.join("\n") ?? "";
    expect(statements).toContain('uniforms["u_param_tint"].value[0]');
    expect(statements).toContain('uniforms["u_param_tint_x"].value');
    expect(statements).not.toContain('uniforms["u_param_tint_x"].value[');
  });

  it("lifts nothing when the uniforms do not fit", () => {
    const fragment = [
      local("wave", mul(time, lit(2))),
      local(
        "shade",
        mul(ref("local", "wave", FLOAT), ref("targetInput", "p_cameraDistance", FLOAT)),
      ),
    ];
    const lifted = lift(fragment, ["shade"], false);
    expect(lifted.stage).toBeUndefined();
    expect(lifted.stages[1]).toEqual(fragment);
  });

  it("never lifts a random value", () => {
    const random: FXExpr = { kind: "call", type: FLOAT, fn: "rand", args: [] };
    const lifted = lift([local("noise", mul(random, time))], ["noise"]);
    expect(lifted.stage).toBeUndefined();
  });

  it("never lifts what reads a per-vertex input", () => {
    const lifted = lift([local("drift", mul(uv, time), FX_VALUE_TYPES.vec2)], ["drift"]);
    expect(lifted.stage).toBeUndefined();
  });
});
