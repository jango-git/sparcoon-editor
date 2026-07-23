import { describe, expect, it } from "vitest";
import type {
  FXCompilerErrorCode,
  FXValidationResult,
} from "../../src/engine/core/compiler/FXCompilerError";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXRenderLiveBackend } from "../../src/engine/render/live/FXRenderLiveBackend";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXTarget } from "../../src/engine/render/target/FXTarget";
import { renderRegistry } from "../helpers/stdRegistry";

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
const VEC4 = FX_VALUE_TYPES.vec4;
const { VERTEX, FRAGMENT } = FXShaderStage;

/** A well-formed render target (all-optional outputs, so an empty graph is legal). */
function baseTarget(): FXTarget {
  return {
    name: "lint-render",
    inputs: [
      { name: "PARTICLE_AGE", type: FLOAT, stages: [VERTEX, FRAGMENT] },
      { name: "p_uv", type: VEC2, stages: [FRAGMENT] },
    ],
    outputs: [{ slot: "albedo", type: VEC4, stage: FRAGMENT, required: false }],
  };
}

/** Validates an empty graph against `target` (isolates target-shape errors). */
function lint(target: FXTarget): FXValidationResult {
  return new FXCompilerBaseline().validate(new FXGraph<FXRenderNode>(), target);
}

/** Whether any error matches `code` (optionally matching `substr` in its message). */
function hasError(result: FXValidationResult, code: FXCompilerErrorCode, substr = ""): boolean {
  return result.errors.some((error) => error.code === code && error.message.includes(substr));
}

/** Every code `renderTargetShapeErrors`/`validateRenderTargetSemantics` can produce - this
 *  file's own concern, split out of the former single `invalid-target` code. A well-formed
 *  target should have none of these, but `lint()`'s empty graph can still fail an unrelated
 *  check (e.g. `missing-required-output`), so "no errors at all" is too strict a negative. */
const TARGET_SHAPE_CODES: readonly FXCompilerErrorCode[] = [
  "malformed-target-shape",
  "unknown-target-value-type",
  "bad-render-input-identifier",
  "render-input-is-glsl-keyword",
  "render-input-matches-generated-pattern",
  "duplicate-target-input",
  "unknown-render-input-stage",
  "duplicate-target-output",
  "unknown-render-output-stage",
];

function hasAnyTargetShapeError(result: FXValidationResult): boolean {
  return result.errors.some((error) => TARGET_SHAPE_CODES.includes(error.code));
}

describe("validateRenderTarget (render target shape lint)", () => {
  it("passes a well-formed target", () => {
    expect(hasAnyTargetShapeError(lint(baseTarget()))).toBe(false);
  });

  it("flags an input name that is not a GLSL identifier", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      inputs: [{ name: "p uv", type: VEC2, stages: [FRAGMENT] }],
    });
    expect(hasError(result, "bad-render-input-identifier", "GLSL identifier")).toBe(true);
  });

  it("flags a duplicated input name", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      inputs: [...target.inputs, { name: "PARTICLE_AGE", type: FLOAT, stages: [FRAGMENT] }],
    });
    expect(hasError(result, "duplicate-target-input", "more than once")).toBe(true);
  });

  it("flags an input naming an unknown stage", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      // Editor data can carry a junk stage past the type system.
      inputs: [{ name: "PARTICLE_AGE", type: FLOAT, stages: ["geometry" as FXShaderStage] }],
    });
    expect(hasError(result, "unknown-render-input-stage", "unknown stage")).toBe(true);
  });

  it("flags a duplicated output slot", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      outputs: [
        ...target.outputs,
        { slot: "albedo", type: VEC4, stage: FRAGMENT, required: false },
      ],
    });
    expect(hasError(result, "duplicate-target-output", "more than once")).toBe(true);
  });
});

describe("validateRenderTarget v2 - keywords, reserved forms, value types (P12)", () => {
  it("flags an input named after a GLSL keyword", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      inputs: [{ name: "float", type: FLOAT, stages: [FRAGMENT] }],
    });
    expect(hasError(result, "render-input-is-glsl-keyword", "GLSL keyword")).toBe(true);
  });

  it("flags an input matching the compiler-generated u_/v_ counter form", () => {
    const target = baseTarget();
    for (const name of ["u_uniform_0", "v_bridge_3"]) {
      const result = lint({
        ...target,
        inputs: [{ name, type: FLOAT, stages: [FRAGMENT] }],
      });
      expect(hasError(result, "render-input-matches-generated-pattern", "reserved"), name).toBe(
        true,
      );
    }
  });

  it("still accepts digit-suffixed names outside the u_/v_ namespace (attribute varyings)", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      inputs: [{ name: "p_glow_2", type: FLOAT, stages: [FRAGMENT] }],
    });
    expect(hasAnyTargetShapeError(result)).toBe(false);
  });

  it("flags a home-made FXValueType on inputs and outputs", () => {
    const target = baseTarget();
    const junk = { glslTypeName: "vec4; } void main() {", components: 4 } as unknown as typeof VEC4;
    expect(
      hasError(
        lint({ ...target, inputs: [{ name: "p_junk", type: junk, stages: [FRAGMENT] }] }),
        "unknown-target-value-type",
        "unknown value type",
      ),
    ).toBe(true);
    expect(
      hasError(
        lint({
          ...target,
          outputs: [{ slot: "albedo", type: junk, stage: FRAGMENT, required: false }],
        }),
        "unknown-target-value-type",
        "unknown value type",
      ),
    ).toBe(true);
  });

  it("regression: the built-in particle target (with attributes) stays green", () => {
    expect(
      hasAnyTargetShapeError(lint(buildParticleTarget([{ name: "glow_2", type: FLOAT }]))),
    ).toBe(false);
  });
});

describe("render live apply against a broken target -> invalid (P12)", () => {
  const snapshot: FXGraphSnapshotData = {
    version: 2,
    nodes: { e: { type: "constant", params: { type: "color" } } },
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "e", socketKey: "out" } }],
  };

  const badInputs: readonly [string, string, FXCompilerErrorCode][] = [
    ["GLSL keyword", "float", "render-input-is-glsl-keyword"],
    ["reserved generated form", "u_uniform_0", "render-input-matches-generated-pattern"],
  ];

  for (const [label, name, code] of badInputs) {
    it(`apply with a "${name}" input (${label}) -> invalid, not recompiled`, () => {
      const live = new FXLiveGraph(
        new FXGraphReconciler(renderRegistry()),
        new FXRenderLiveBackend(
          "baseline",
          (): FXTarget => ({
            ...buildParticleTarget([]),
            inputs: [{ name, type: FLOAT, stages: [FRAGMENT] }],
          }),
          () => {
            /* install sink */
          },
        ),
      );
      let result: ReturnType<typeof live.apply> | undefined;
      expect(() => {
        result = live.apply(snapshot);
      }).not.toThrow();
      expect(result?.status).toBe("invalid");
      expect(result?.errors.some((error) => error.code === code)).toBe(true);
    });
  }
});

describe("static compile surface carries typed errors (T10)", () => {
  it("FXCompilerBaseline.compile over an invalid target throws FXCompilerErrorException with a code", () => {
    const target = baseTarget();
    let caught: unknown;
    try {
      new FXCompilerBaseline().compile(new FXGraph<FXRenderNode>(), {
        ...target,
        inputs: [{ name: "float", type: FLOAT, stages: [FRAGMENT] }],
      });
    } catch (error) {
      caught = error;
    }
    expect(isFXCompilerErrorException(caught)).toBe(true);
    if (isFXCompilerErrorException(caught)) {
      // throwIfInvalid spreads the first error's own code/params, only appending the
      // "(N error(s) total)" summary suffix to its message.
      expect(caught.error.code).toBe("render-input-is-glsl-keyword");
      expect(caught.error.message).toContain("error(s) total");
    }
  });
});
