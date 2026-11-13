import { FX_CORE_LIFECYCLE, FX_CORE_LIFECYCLE_STRIDE, FX_ID, FX_LIFETIME } from "sparcoon";
import { describe, expect, it } from "vitest";

import { linkReaction, type ReactionSource } from "../../src/domain/reactionLinking";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  collectInheritRequests,
  inheritInputName,
  planInherits,
} from "../../src/engine/behavior/FXInherit";
import type { FXInheritRequest } from "../../src/engine/behavior/FXInheritPlan";
import { assembleTransformFeedbackProgram } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import { validateKernelTarget } from "../../src/engine/behavior/FXKernelTargetValidation.Internal";
import { validateBehavior } from "../../src/engine/behavior/FXKernelValidation.Internal";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { particleBehaviorTargetsFor } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorNodeInheritedAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeInheritedAttribute";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { behaviorArtifactBody } from "../../src/engine/emit/artifactLiterals";
import { bind, fieldSpawnKernel, graphOf } from "../helpers/graphBuild";

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
const VEC3 = FX_VALUE_TYPES.vec3;

function inherited(
  name: string,
  type = FLOAT,
  value: unknown = 0,
): FXBehaviorNodeInheritedAttribute {
  return new FXBehaviorNodeInheritedAttribute({ kind: "attribute", name }, type, value);
}

function request(name: string, type = FLOAT, defaults = [0]): FXInheritRequest {
  return { source: { kind: "attribute", name }, type, defaults };
}

/** A spawn graph whose lifetime and position come from what its newborns inherit. */
function inheritingGraph(): FXGraph<FXBehaviorNode> {
  return graphOf<FXBehaviorNode>(
    {
      life: new FXBehaviorNodeInheritedAttribute({ kind: "builtin", field: "lifetime" }, FLOAT, 3),
      at: inherited("spot", VEC3, [1, 2, 3]),
    },
    [],
    [bind("lifetime", "life", "value", "spawn"), bind("position", "at", "value", "spawn")],
  );
}

describe("inherit layout", () => {
  it("places one value per source, type and default, never across a vec4", () => {
    const plan = planInherits([
      request("a", VEC3, [1, 2, 3]),
      request("b", VEC2, [4, 5]),
      request("a", VEC3, [1, 2, 3]), // the same value again
      request("c", FLOAT, [6]),
    ]);
    expect(plan.entries.map((entry) => [entry.request.source, entry.offset])).toEqual([
      [{ kind: "attribute", name: "a" }, 0],
      [{ kind: "attribute", name: "b" }, 4], // a vec2 at 3 would cross into the next vec4
      [{ kind: "attribute", name: "c" }, 6],
    ]);
    expect(plan.layout).toEqual({ stride: 7, defaults: [1, 2, 3, 0, 4, 5, 6] });
  });

  it("reads one source with two defaults as two values, and names them apart", () => {
    const first = request("a", FLOAT, [1]);
    const second = request("a", FLOAT, [2]);
    expect(inheritInputName(first)).not.toBe(inheritInputName(second));
    expect(planInherits([first, second]).layout.stride).toBe(2);
  });

  it("refuses one source read at two types", () => {
    const graph = graphOf<FXBehaviorNode>(
      { x: inherited("heat", FLOAT), y: inherited("heat", VEC2) },
      [],
      [bind("positionX", "x", "value", "spawn"), bind("positionY", "y", "value", "spawn")],
    );
    expect(collectInheritRequests(graph).errors.map((error) => error.code)).toEqual([
      "inherit-type-conflict",
    ]);
    expect(validateBehavior(graph, particleBehaviorTargetsFor(graph)).ok).toBe(false);
  });

  it("refuses an inherited input on an update target, or one outside the layout", () => {
    const { spawn, update } = particleBehaviorTargetsFor(inheritingGraph());
    const input = spawn.inputs.find((candidate) => candidate.inheritOffset !== undefined);
    expect(input).toBeDefined();
    const codes = (errors: readonly { code: string }[]): string[] =>
      errors.map((error) => error.code);
    expect(codes(validateKernelTarget({ ...update, inputs: [input!] }, "update"))).toContain(
      "inherit-input-not-in-spawn",
    );
    expect(
      codes(validateKernelTarget({ ...spawn, inputs: [{ ...input!, inheritOffset: 3 }] }, "spawn")),
    ).toContain("inherit-input-out-of-layout");
    expect(validateKernelTarget(spawn, "spawn")).toEqual([]);
  });
});

describe("inheriting kernels", () => {
  it("seed each newborn from the call's inherited values on the JS backend", () => {
    const graph = inheritingGraph();
    const compiled = compileBehavior(graph, particleBehaviorTargetsFor(graph));
    // Ordered by input name: the attribute before the core field.
    expect(compiled.inherit?.layout).toEqual({ stride: 4, defaults: [1, 2, 3, 3] });
    const spawn = fieldSpawnKernel(compiled);

    const fields = {
      position: new Float32Array(6),
      lifecycle: new Float32Array(2 * FX_CORE_LIFECYCLE_STRIDE),
    };
    spawn(fields, 0, 2, compiled.spawn!.bindings, undefined, new Float32Array([4, 5, 6, 9]));
    expect([...fields.position]).toEqual([4, 5, 6, 4, 5, 6]);
    expect(fields.lifecycle[FX_LIFETIME]).toBe(9);
    expect(fields.lifecycle[FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME]).toBe(9);

    // Without values handed in, the defaults.
    spawn(fields, 0, 1, compiled.spawn!.bindings);
    expect([...fields.position.subarray(0, 3)]).toEqual([1, 2, 3]);
  });

  it("export the inherit layout, and a spawn taking the inherited values", () => {
    const graph = inheritingGraph();
    const body = behaviorArtifactBody(compileBehavior(graph, particleBehaviorTargetsFor(graph)));
    expect(body).toContain('inherit: {"stride":4,"defaults":[1,2,3,3]},');
    expect(body).toContain("spawn(slots, start, count, bindings, emitter, inherited) {");
  });

  it("read the inherited uniform on the GPU, declared as many vec4s as the layout takes", () => {
    const graph = inheritingGraph();
    const program = assembleTransformFeedbackProgram(
      compileBehaviorStandard(graph, particleBehaviorTargetsFor(graph, true)),
    );
    expect(program.vertexSource).toContain("uniform vec4 u_fxInherited[1];");
    expect(program.vertexSource).toContain("u_fxInherited[0].xyz");
    expect(program.vertexSource).toContain("u_fxInherited[0].w");
  });

  it("declare no inherited uniform when nothing is inherited", () => {
    const graph = graphOf<FXBehaviorNode>({}, [], []);
    const program = assembleTransformFeedbackProgram(
      compileBehaviorStandard(graph, particleBehaviorTargetsFor(graph, true)),
    );
    expect(program.vertexSource).not.toContain("u_fxInherited");
  });
});

describe("reaction linking", () => {
  // A slot of position (0..2), lifecycle (3..5), heat (6), tint (7..9).
  const source: ReactionSource = {
    slot: {
      stride: 10,
      fields: [
        { name: "position", components: 3, offset: 0 },
        { name: FX_CORE_LIFECYCLE, components: 3, offset: 3 },
        { name: "heat", components: 1, offset: 6 },
        { name: "tint", components: 3, offset: 7 },
      ],
    },
    written: new Set(["position", FX_CORE_LIFECYCLE, "heat"]),
  };

  it("copies each value from where the source's slot holds it, core fields included", () => {
    const plan = planInherits([
      request("heat", FLOAT, [0]),
      { source: { kind: "builtin", field: "id" }, type: FLOAT, defaults: [-1] },
    ]);
    const offsetOf = (name: string): number =>
      plan.entries.find((entry) => entry.inputName.includes(name))?.offset ?? -1;
    const link = linkReaction(source, plan.entries);
    expect(link.issues).toEqual([]);
    expect(link.copies).toEqual(
      expect.arrayContaining([6, offsetOf("heat"), 1, 3 + FX_ID, offsetOf("builtin_id"), 1]),
    );
    expect(link.copies).toHaveLength(6);
  });

  it("leaves at defaults, and reports, what the source lacks, holds at another type or never writes", () => {
    const plan = planInherits([
      request("missing"),
      request("heat", VEC2, [0, 0]),
      request("tint", VEC3, [0, 0, 0]),
    ]);
    const link = linkReaction(source, plan.entries);
    expect(link.copies).toEqual([]);
    expect(link.issues).toEqual(
      expect.arrayContaining([
        { kind: "missing", name: "missing", expected: "float" },
        { kind: "mistyped", name: "heat", expected: "vec2", found: "float" },
        { kind: "unwritten", name: "tint", expected: "vec3" },
      ]),
    );
  });

  it("links nothing from an unbuilt source, and reports nothing", () => {
    expect(linkReaction(undefined, planInherits([request("heat")]).entries)).toEqual({
      copies: [],
      issues: [],
    });
  });
});
