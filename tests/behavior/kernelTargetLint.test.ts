import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  compileBehavior,
  validateBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorLiveBackend } from "../../src/engine/behavior/live/FXBehaviorLiveBackend";
import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { attributeSlot } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXCompilerErrorCode } from "../../src/engine/core/compiler/FXCompilerError";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { add, mul, ref } from "../../src/engine/core/ir/FXExprBuilder";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { behaviorRegistry } from "../helpers/stdRegistry";
import { buildValueBehaviorTarget } from "../helpers/valueTarget";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

const reg = behaviorRegistry();

/**
 * A constant(0.5) bound to the `progress` slot - the graph the deleted apply tests fed the
 * live gate. Only the target under test is malformed, so the graph itself always compiles.
 */
function constantProgressGraph(): FXGraph<FXBehaviorNode> {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map<string, FXBehaviorNode>([
      ["p", reg.create("constant", { type: "float", value: 0.5 })],
    ]),
    connections: [],
    outputBindings: [{ slot: "progress", from: { nodeId: "p", socketKey: "out" } }],
  });
  return graph;
}

/** A well-formed update-only value target (progress:float + tint:vec3 in `values`). */
function baseTarget(): FXKernelTarget {
  return {
    name: "lint-update",
    buffers: [{ name: "values", stride: 4 }],
    inputs: [
      { name: "VALUE_progress", type: FLOAT, buffer: "values", offsets: [0] },
      { name: "dt", type: FLOAT },
    ],
    outputs: [
      { slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [0] },
      { slot: "tint", type: VEC3, required: false, buffer: "values", offsets: [1, 2, 3] },
    ],
  };
}

/** Runs the shape lint through the real validation entrypoint (empty graph). */
function lint(update: FXKernelTarget): ReturnType<typeof validateBehavior> {
  return validateBehavior(new FXGraph<FXBehaviorNode>(), { update });
}

/** True if some error matches `code` with `substr` in its message. */
function hasError(
  result: ReturnType<typeof validateBehavior>,
  code: FXCompilerErrorCode,
  substr: string,
): boolean {
  return result.errors.some((error) => error.code === code && error.message.includes(substr));
}

describe("validateKernelTarget (behavior target shape lint)", () => {
  it("passes a well-formed target", () => {
    const result = lint(baseTarget());
    expect(result.ok).toBe(true);
  });

  it("flags an output slot naming an undeclared buffer", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      outputs: [{ slot: "progress", type: FLOAT, required: false, buffer: "nope", offsets: [0] }],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "undeclared-target-buffer", `"nope"`)).toBe(true);
  });

  it("flags an offset count that disagrees with the slot type", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      // vec3 tint with only two offsets -> silent component truncation without the lint.
      outputs: [{ slot: "tint", type: VEC3, required: false, buffer: "values", offsets: [1, 2] }],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "target-output-offset-count-mismatch", "offset(s)")).toBe(true);
  });

  it("flags an offset outside its buffer stride", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      outputs: [{ slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [9] }],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "target-offset-out-of-bounds", "outside buffer")).toBe(true);
  });

  it("flags a duplicated input name", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      inputs: [
        ...target.inputs,
        { name: "VALUE_progress", type: FLOAT, buffer: "values", offsets: [0] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "duplicate-target-input", "more than once")).toBe(true);
  });

  it("flags integration reading an undeclared input", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      buffers: [...target.buffers, { name: "builtin", stride: 16 }],
      integration: [{ offset: 0, expr: ref("targetInput", "NOPE", FLOAT) }],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "integration-input-not-declared", `"NOPE"`)).toBe(true);
  });

  it("flags integration writing outside the builtin buffer", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      buffers: [...target.buffers, { name: "builtin", stride: 16 }],
      integration: [{ offset: 99, expr: ref("targetInput", "dt", FLOAT) }],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "target-offset-out-of-bounds", "integration")).toBe(true);
  });

  it("flags a duplicate offset within one output slot (B3)", () => {
    const target = baseTarget();
    // vec3 tint with offsets [1, 1, 2]: component x overwrites y silently.
    const result = lint({
      ...target,
      outputs: [
        { slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [0] },
        { slot: "tint", type: VEC3, required: false, buffer: "values", offsets: [1, 1, 2] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "duplicate-output-offset-write", "more than once")).toBe(true);
  });

  it("flags two integration steps writing the same offset (B3)", () => {
    const target = baseTarget();
    const result = lint({
      ...target,
      buffers: [...target.buffers, { name: "builtin", stride: 16 }],
      integration: [
        { offset: 0, expr: ref("targetInput", "dt", FLOAT) },
        { offset: 0, expr: ref("targetInput", "dt", FLOAT) },
      ],
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "duplicate-integration-offset-write", "more than one step")).toBe(true);
  });
});

describe("validateKernelTarget v2 - numeric and identifier strictness (P12)", () => {
  /** One editor typo per case: [label, broken update target, message fragment, expected code]. */
  const badTargets: readonly [string, FXKernelTarget, string, FXCompilerErrorCode][] = (() => {
    const base = baseTarget();
    const withBuffers = (buffers: FXKernelTarget["buffers"]): FXKernelTarget => ({
      ...base,
      buffers,
    });
    return [
      [
        "NaN stride",
        withBuffers([{ name: "values", stride: Number.NaN }]),
        "positive integer",
        "bad-target-buffer-stride",
      ],
      [
        "fractional stride",
        withBuffers([{ name: "values", stride: 2.5 }]),
        "positive integer",
        "bad-target-buffer-stride",
      ],
      [
        "zero stride",
        withBuffers([{ name: "values", stride: 0 }]),
        "positive integer",
        "bad-target-buffer-stride",
      ],
      [
        "negative stride",
        withBuffers([{ name: "values", stride: -4 }]),
        "positive integer",
        "bad-target-buffer-stride",
      ],
      [
        "duplicate buffer names",
        withBuffers([
          { name: "values", stride: 4 },
          { name: "values", stride: 4 },
        ]),
        "more than once",
        "duplicate-target-buffer",
      ],
      [
        "buffer name with a space and a semicolon",
        {
          ...base,
          buffers: [{ name: "my values; alert(1)//", stride: 4 }],
          inputs: [{ name: "dt", type: FLOAT }],
          outputs: [],
        },
        "not a valid identifier",
        "bad-target-buffer-identifier",
      ],
      [
        "NaN offset",
        {
          ...base,
          outputs: [
            {
              slot: "progress",
              type: FLOAT,
              required: false,
              buffer: "values",
              offsets: [Number.NaN],
            },
          ],
        },
        "must be an integer",
        "bad-target-offset",
      ],
      [
        "fractional offset",
        {
          ...base,
          outputs: [
            { slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [0.5] },
          ],
        },
        "must be an integer",
        "bad-target-offset",
      ],
      [
        "input name containing @ (aliases the component encoding)",
        {
          ...base,
          inputs: [
            ...base.inputs,
            { name: "VALUE_progress@1", type: FLOAT, buffer: "values", offsets: [1] },
          ],
        },
        "not a valid identifier",
        "bad-target-input-identifier",
      ],
      [
        "offset-less input that is not dt",
        { ...base, inputs: [...base.inputs, { name: "u_progress", type: FLOAT }] },
        `reserved for "dt"`,
        "offsetless-input-not-reserved",
      ],
      [
        "dt declared with offsets (diverges between function/interpreter modes)",
        {
          ...base,
          inputs: [
            { name: "VALUE_progress", type: FLOAT, buffer: "values", offsets: [0] },
            { name: "dt", type: FLOAT, buffer: "values", offsets: [1] },
          ],
        },
        "must be offset-less",
        "dt-input-has-offsets",
      ],
      [
        "home-made value type",
        {
          ...base,
          inputs: [
            ...base.inputs,
            {
              name: "VALUE_junk",
              type: {
                glslTypeName: "vec3; } void main() {",
                components: 3,
              } as unknown as FXValueType,
              buffer: "values",
              offsets: [1, 2, 3],
            },
          ],
        },
        "unknown value type",
        "unknown-target-value-type",
      ],
      [
        "vector ref in integration",
        {
          ...base,
          buffers: [...base.buffers, { name: "builtin", stride: 16 }],
          inputs: [
            ...base.inputs,
            { name: "VALUE_tint", type: VEC3, buffer: "values", offsets: [1, 2, 3] },
          ],
          integration: [{ offset: 0, expr: ref("targetInput", "VALUE_tint", VEC3) }],
        },
        "must be scalar",
        "integration-ref-not-scalar",
      ],
      [
        "non-targetInput ref in integration",
        {
          ...base,
          buffers: [...base.buffers, { name: "builtin", stride: 16 }],
          integration: [{ offset: 0, expr: ref("attribute", "a_thing", FLOAT) }],
        },
        "may only read target inputs",
        "integration-ref-not-target-input",
      ],
    ];
  })();

  for (const [label, target, fragment, code] of badTargets) {
    it(`flags ${label}`, () => {
      const result = lint(target);
      expect(result.ok).toBe(false);
      expect(hasError(result, code, fragment)).toBe(true);
    });
  }

  it("each broken target validates as invalid without throwing (never a silent compile)", () => {
    // A real constant->progress graph (the snapshot the deleted live gate drove): only the
    // target is malformed, so validation must collect its own typed error rather than
    // throw or compile a broken kernel.
    const graph = constantProgressGraph();
    for (const [label, target, , code] of badTargets) {
      let result: ReturnType<typeof validateBehavior> | undefined;
      expect(() => {
        result = validateBehavior(graph, { update: target });
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(false);
      expect(
        result?.errors.some((error) => error.code === code),
        label,
      ).toBe(true);
    }
  });
});

describe("validateKernelTarget v2 - phase awareness and the spawn/update pair (P12)", () => {
  /** A minimal well-formed spawn/update pair over one shared buffer. */
  function pair(): { spawn: FXKernelTarget; update: FXKernelTarget } {
    const spawn: FXKernelTarget = {
      name: "pair-spawn",
      buffers: [{ name: "values", stride: 4 }],
      inputs: [{ name: "VALUE_progress", type: FLOAT, buffer: "values", offsets: [0] }],
      outputs: [{ slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [0] }],
    };
    const update = { ...baseTarget(), name: "pair-update" };
    return { spawn, update };
  }

  function lintPair(targets: FXBehaviorTargets): ReturnType<typeof validateBehavior> {
    return validateBehavior(new FXGraph<FXBehaviorNode>(), targets);
  }

  it("passes a well-formed pair", () => {
    expect(lintPair(pair()).ok).toBe(true);
  });

  it("T1: a spawn integration reading dt is invalid at validate (not a frame-time ReferenceError)", () => {
    const targets = pair();
    // The editor copies the update target's Euler integration into its spawn target.
    const result = lintPair({
      ...targets,
      spawn: {
        ...targets.spawn,
        buffers: [...targets.spawn.buffers, { name: "builtin", stride: 16 }],
        integration: [
          {
            offset: 0,
            expr: add(
              ref("targetInput", "VALUE_progress", FLOAT),
              mul(ref("targetInput", "VALUE_progress", FLOAT), ref("targetInput", "dt", FLOAT)),
            ),
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "integration-reads-dt-in-spawn", "spawn kernel has no dt")).toBe(true);
  });

  it("a spawn target declaring a dt input is invalid", () => {
    const targets = pair();
    const result = lintPair({
      ...targets,
      spawn: { ...targets.spawn, inputs: [...targets.spawn.inputs, { name: "dt", type: FLOAT }] },
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "spawn-input-has-dt", "spawn kernel has no dt")).toBe(true);
  });

  it("a buffer with different strides in spawn and update is invalid", () => {
    const targets = pair();
    const result = lintPair({
      ...targets,
      spawn: {
        ...targets.spawn,
        buffers: [{ name: "values", stride: 7 }],
        inputs: [],
        outputs: [
          { slot: "progress", type: FLOAT, required: false, buffer: "values", offsets: [0] },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "phase-buffer-stride-mismatch", "stride 7")).toBe(true);
  });

  it("a buffer declared only in the spawn target is invalid (the host allocates from update)", () => {
    const targets = pair();
    const result = lintPair({
      ...targets,
      spawn: {
        ...targets.spawn,
        buffers: [...targets.spawn.buffers, { name: "spawnOnly", stride: 2 }],
      },
    });
    expect(result.ok).toBe(false);
    expect(hasError(result, "phase-buffer-not-in-update", `"spawnOnly"`)).toBe(true);
  });
});

describe("kernel-target lint regression - legitimate targets stay green (P12)", () => {
  it("accepts the built-in particle pair (with and without attributes)", () => {
    expect(lintPair(buildParticleBehaviorTargets())).toBe(true);
    expect(
      lintPair(buildParticleBehaviorTargets([{ name: "glow", type: FX_VALUE_TYPES.vec3 }])),
    ).toBe(true);
  });

  it("accepts the value-target helper (doc section 6 shape)", () => {
    expect(
      lintPair(
        buildValueBehaviorTarget([
          { name: "progress", type: FLOAT },
          { name: "tint", type: VEC3 },
        ]),
      ),
    ).toBe(true);
  });

  function lintPair(targets: FXBehaviorTargets): boolean {
    return validateBehavior(new FXGraph<FXBehaviorNode>(), targets).ok;
  }
});

describe("compile and validate surfaces carry typed errors (T10)", () => {
  it("compileBehavior over an invalid target throws FXCompilerErrorException with a code", () => {
    let caught: unknown;
    try {
      compileBehavior(new FXGraph<FXBehaviorNode>(), {
        update: { ...baseTarget(), buffers: [{ name: "values", stride: Number.NaN }] },
      });
    } catch (error) {
      caught = error;
    }
    expect(isFXCompilerErrorException(caught)).toBe(true);
    if (isFXCompilerErrorException(caught)) {
      // throwIfInvalid spreads the first error's own code/params - a NaN stride is the first
      // check `validateKernelTarget` runs, so it wins regardless of what else is wrong.
      expect(caught.error.code).toBe("bad-target-buffer-stride");
      expect(caught.error.message).toContain("error(s) total");
    }
  });

  it("the live validate surface merges an attribute-collection conflict precisely (B4)", () => {
    // Two store-attribute nodes claim the name "tint" at conflicting types. The live
    // backend's validate merges collectAttributeRequests' errors, so the mismatch surfaces
    // as its precise attribute-type-conflict instead of resurfacing downstream as a confusing
    // output-slot-type-mismatch.
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map<string, FXBehaviorNode>([
        ["a", new FXBehaviorNodeStoreAttribute("tint", FLOAT, FXBehaviorPhase.SPAWN)],
        ["b", new FXBehaviorNodeStoreAttribute("tint", VEC3, FXBehaviorPhase.SPAWN)],
      ]),
      connections: [],
      outputBindings: [
        { slot: attributeSlot("tint"), from: { nodeId: "a", socketKey: "value" } },
        { slot: attributeSlot("tint"), from: { nodeId: "b", socketKey: "value" } },
      ],
    });

    const result = new FXBehaviorLiveBackend(() => {}, buildParticleBehaviorTargets).validate(
      graph,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "attribute-type-conflict")).toBe(true);
  });
});

describe("a malformed kernel target validated against a real graph", () => {
  it("reports invalid with an undeclared-target-buffer error (never compiles a broken kernel)", () => {
    // A single typo: the `progress` slot points at a buffer that does not exist. The
    // constant->progress graph itself compiles, so the target is the only fault; validation
    // must collect its own typed error rather than compile a kernel that ReferenceErrors on
    // the first frame.
    const graph = constantProgressGraph();
    const target: FXKernelTarget = {
      ...baseTarget(),
      outputs: [{ slot: "progress", type: FLOAT, required: false, buffer: "typo", offsets: [0] }],
    };
    const result = validateBehavior(graph, { update: target });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "undeclared-target-buffer")).toBe(true);
    // removed: the post-invalid safe no-op tick exercised deleted FXSimulation.live
    // kernel-install orchestration, which has no validateBehavior equivalent.
  });
});
