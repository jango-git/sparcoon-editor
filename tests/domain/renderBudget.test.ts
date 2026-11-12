import type { FXAttributeDecl, FXBufferLayout, FXRenderArtifact } from "sparcoon";
import { type FXRenderBudget, packingOrder } from "sparcoon/editor";
import { describe, expect, it } from "vitest";

import {
  emitterRenderBudgetFindings,
  type FXRenderArtifactsByTier,
  renderBudgetFindings,
  RenderBudgetMemo,
  trailRenderBudgetFindings,
} from "../../src/domain/renderBudget";
import { SPAWN_SINK_ID, SPAWN_TRY_GPU_SIMULATION_PARAM } from "../../src/domain/sinkMeta";
import { interpolate } from "../../src/i18n/interpolate";
import errorsEn from "../../src/i18n/locales/errors.en.json" with { type: "json" };
import type { EmitterDoc } from "../../src/model/editorState";
import { createDefaultEmitter } from "../../src/model/editorState";
import { compileEmitter } from "../../src/persistence/exportCompile";
import { unlitArtifact } from "../helpers/artifacts";

/** `render` as the artifact of both tiers. */
function bothTiers(render: FXRenderArtifact): FXRenderArtifactsByTier {
  return { baseline: render, standard: render };
}

/** A budget within every minimum, with `over` taking its place. */
function budget(over: Partial<FXRenderBudget> = {}): FXRenderBudget {
  return {
    attributes: 8,
    varyingVectors: 8,
    vertexUniformVectors: 64,
    fragmentUniformVectors: 32,
    vertexSamplers: 2,
    fragmentSamplers: 4,
    ...over,
  };
}

describe("renderBudgetFindings", () => {
  it("finds nothing within both tiers' minimums", () => {
    expect(renderBudgetFindings(budget(), budget())).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("warns past only Baseline's (WebGL1) minimums", () => {
    const over = budget({ attributes: 9, varyingVectors: 12 });
    const { errors, warnings } = renderBudgetFindings(over, over);
    expect(errors).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      "render-attribute-budget-baseline",
      "render-varying-budget-baseline",
    ]);
    expect(warnings[0]?.params).toEqual({ used: 9, limit: 8 });
  });

  it("errs past Standard's (WebGL2) minimums, without repeating the same overrun as a warning", () => {
    const over = budget({ attributes: 17, varyingVectors: 12 });
    const { errors, warnings } = renderBudgetFindings(over, over);
    expect(errors.map((error) => error.code)).toEqual(["render-attribute-budget"]);
    expect(errors[0]?.params).toEqual({ used: 17, limit: 16 });
    // The varyings are still past Baseline's only.
    expect(warnings.map((warning) => warning.code)).toEqual(["render-varying-budget-baseline"]);
  });

  it("measures uniforms and texture units per stage against the device floor", () => {
    const over = budget({ fragmentUniformVectors: 65, vertexSamplers: 17 });
    const { errors, warnings } = renderBudgetFindings(over, over);
    expect(errors.map((error) => error.code)).toEqual(["render-vertex-sampler-budget"]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      "render-fragment-uniform-budget-baseline",
    ]);
    expect(warnings[0]?.message).toContain("the least WebGL1 device the Baseline tier supports");
    expect(warnings[0]?.params).toEqual({ used: 65, limit: 64 });
  });
});

/** A particle slot over `decls`: the core buffers and every attribute, in packing order (as
 *  `buildParticleBehaviorTargets` lays out both the JS behavior's and the GPU kernel's). */
function kernelSlot(decls: readonly FXAttributeDecl[]): FXBufferLayout[] {
  return packingOrder([
    { name: "position", components: 3 },
    { name: "lifecycle", components: 3 },
    ...decls,
  ]).map((field) => ({ name: field.name, stride: field.components }));
}

/** `count` float attributes named a0, a1, ... */
function floats(count: number): FXAttributeDecl[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `a${String(index)}`,
    components: 1 as const,
  }));
}

/** An unlit render declaring `decls` and reading every one in its vertex stage. */
function reading(decls: readonly FXAttributeDecl[]): ReturnType<typeof unlitArtifact> {
  return unlitArtifact({
    attributeReads: decls,
    // A held field the render never names takes no attribute.
    vertexBody: [`float fxSum = ${decls.map((decl) => `p_fx_${decl.name}`).join(" + ")};`],
  });
}

/** `count` vec4 attributes named v0, v1, ... - a view each, whatever the order. */
function vec4s(count: number): FXAttributeDecl[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `v${String(index)}`,
    components: 4 as const,
  }));
}

describe("emitterRenderBudgetFindings", () => {
  it("packs the JS mesh's slot: twelve floats share five views with the core, not twelve", () => {
    const decls = floats(12);
    // The base geometry's three, lifecycle + a float, position + a float, then ten floats in three.
    expect(
      emitterRenderBudgetFindings(bothTiers(reading(decls)), kernelSlot(decls), false, undefined),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("errs on the JS mesh when the emitter has no GPU kernel", () => {
    const decls = vec4s(12);
    const { errors, warnings } = emitterRenderBudgetFindings(
      bothTiers(reading(decls)),
      kernelSlot(decls),
      false,
      undefined,
    );
    expect(errors.map((error) => error.code)).toEqual(["render-attribute-budget"]);
    expect(errors[0]?.params).toEqual({ used: 17, limit: 16 });
    expect(warnings).toEqual([]);
  });

  it("measures Standard on the GPU kernel's slot, Baseline on the JS behavior's", () => {
    // Four vec4s on the JS mesh (9, past WebGL1's 8), twelve in the kernel (17).
    const decls = vec4s(12);
    const { errors, warnings } = emitterRenderBudgetFindings(
      bothTiers(reading(decls)),
      kernelSlot(decls.slice(0, 4)),
      false,
      kernelSlot(decls),
    );
    expect(errors.map((error) => error.code)).toEqual(["render-attribute-budget"]);
    expect(errors[0]?.params).toEqual({ used: 17, limit: 16 });
    // The same resource's Baseline overrun is not repeated as a warning.
    expect(warnings).toEqual([]);

    const within = emitterRenderBudgetFindings(
      bothTiers(reading(decls.slice(0, 4))),
      kernelSlot(decls.slice(0, 4)),
      false,
      kernelSlot(decls.slice(0, 4)),
    );
    expect(within.errors).toEqual([]);
    expect(within.warnings[0]?.params).toEqual({ used: 9, limit: 8 });
  });
});

describe("renderBudgetFindings - wording", () => {
  it("bakes each finding's English message from its errors.en.json template", () => {
    // Past every minimum of both tiers on Standard's count, past only Baseline's on the other:
    // every resource yields an error, and (on a budget of its own) every warning.
    const huge = budget({
      attributes: 99,
      varyingVectors: 99,
      vertexUniformVectors: 999,
      fragmentUniformVectors: 999,
      vertexSamplers: 99,
      fragmentSamplers: 99,
    });
    const errors = renderBudgetFindings(huge, huge).errors;
    const warnings = renderBudgetFindings(budget(), huge).warnings;
    expect(errors).toHaveLength(6);
    expect(warnings).toHaveLength(6);
    for (const finding of [...errors, ...warnings]) {
      const template = (errorsEn as Record<string, { message: string } | undefined>)[finding.code];
      expect(template, finding.code).toBeDefined();
      expect(interpolate("en", template?.message ?? "", finding.params ?? {})).toBe(
        finding.message,
      );
    }
  });
});

describe("each tier's artifact, counted on its own", () => {
  /** An unlit render whose fragment stage reads `count` vec4 parameters. */
  const parameters = (count: number): FXRenderArtifact => {
    const names = Array.from({ length: count }, (_, index) => `u_param_p${String(index)}`);
    return unlitArtifact({
      uniformDeclarations: names.map((name) => `uniform vec4 ${name};`),
      outputs: { albedo: names.join(" + ") },
    });
  };

  it("warns on what Baseline runs, not on what Standard does", () => {
    // Standard lifted 70 vectors' worth to uniforms; Baseline, short of room, kept them on the GPU.
    const findings = emitterRenderBudgetFindings(
      { standard: parameters(70), baseline: unlitArtifact() },
      kernelSlot([]),
      false,
      undefined,
    );
    expect(findings).toEqual({ errors: [], warnings: [] });
  });

  it("errs on what Standard runs and warns on what Baseline does", () => {
    const { errors, warnings } = emitterRenderBudgetFindings(
      { standard: parameters(230), baseline: parameters(70) },
      kernelSlot([]),
      false,
      undefined,
    );
    expect(errors.map((error) => error.code)).toEqual(["render-fragment-uniform-budget"]);
    expect(warnings).toEqual([]);
    const baselineOnly = emitterRenderBudgetFindings(
      { standard: unlitArtifact(), baseline: parameters(70) },
      kernelSlot([]),
      false,
      undefined,
    );
    expect(baselineOnly.warnings.map((warning) => warning.code)).toEqual([
      "render-fragment-uniform-budget-baseline",
    ]);
  });
});

describe("trailRenderBudgetFindings", () => {
  // Five vec4 attributes the trail reads and the behavior writes: 15 vertex attributes over the
  // JS history (within WebGL2's 16, past WebGL1's 8), 18 over the GPU one (which also records the
  // position and the lifecycle, a view each, two per segment).
  const decls = Array.from({ length: 5 }, (_, index) => ({
    name: `a${String(index)}`,
    components: 4 as const,
  }));
  const render = bothTiers(reading(decls));

  it("measures a JS-only emitter's trail on the JS history alone", () => {
    const { errors, warnings } = trailRenderBudgetFindings(render, kernelSlot(decls), undefined);
    expect(errors).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["render-attribute-budget-baseline"]);
    expect(warnings[0]?.params).toEqual({ used: 15, limit: 8 });
  });

  it("errs on the GPU history when the emitter has a GPU kernel, without also warning", () => {
    const { errors, warnings } = trailRenderBudgetFindings(
      render,
      kernelSlot(decls),
      kernelSlot(decls),
    );
    expect(errors.map((error) => error.code)).toEqual(["render-attribute-budget"]);
    expect(errors[0]?.params).toEqual({ used: 18, limit: 16 });
    // The same resource's Baseline overrun (15 on the JS history) is not repeated as a warning.
    expect(warnings).toEqual([]);
  });

  it("counts the GPU history over the kernel's packed slot, not one view per field", () => {
    // Twelve floats: 32 attributes if every recorded field had a view of its own, 14 over the
    // kernel's slot, where they pack four to a view.
    const many = floats(12);
    const { errors, warnings } = trailRenderBudgetFindings(
      bothTiers(reading(many)),
      kernelSlot(many),
      kernelSlot(many),
    );
    expect(errors).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["render-attribute-budget-baseline"]);
  });

  it("finds nothing for a light trail on either backend", () => {
    const light = bothTiers(unlitArtifact());
    expect(trailRenderBudgetFindings(light, kernelSlot([]), kernelSlot([]))).toEqual({
      errors: [],
      warnings: [],
    });
    expect(trailRenderBudgetFindings(light, kernelSlot([]), undefined)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

describe("RenderBudgetMemo", () => {
  it("counts again only when a key part changes identity", () => {
    const memo = new RenderBudgetMemo();
    const shader = {};
    let counted = 0;
    const count = () => {
      counted += 1;
      return { errors: [], warnings: [] };
    };
    memo.get([shader, "blending", false], count);
    memo.get([shader, "blending", false], count);
    expect(counted).toBe(1);
    memo.get([{}, "blending", false], count);
    memo.get([{}, "blending", true], count);
    expect(counted).toBe(3);
  });
});

/**
 * The starter emitter with `count` behavior attributes of `type` (vec4 by default), each read in
 * the fragment stage; `tryGpuSimulation: false` turns its spawn sink's GPU kernel off.
 */
function emitterReading(
  count: number,
  {
    type = "vec4",
    tryGpuSimulation = true,
  }: { type?: "float" | "vec4"; tryGpuSimulation?: boolean } = {},
): EmitterDoc {
  const emitter = createDefaultEmitter("emitter_1", "Heavy");
  const names = Array.from({ length: count }, (_, index) => `a${String(index)}`);
  const behavior = emitter.behaviorGraph;
  const render = emitter.renderGraph;
  // A vec4 sum is the albedo; a float one the (optional, fragment-stage) additivity.
  const slot = type === "vec4" ? "albedo" : "additivity";
  const spawnSink = behavior.nodes[SPAWN_SINK_ID];
  return {
    ...emitter,
    behaviorGraph: {
      ...behavior,
      attributes: names.map((name) => ({ name, type })),
      nodes: {
        ...behavior.nodes,
        [SPAWN_SINK_ID]: {
          ...spawnSink,
          parameters: {
            ...spawnSink.parameters,
            [SPAWN_TRY_GPU_SIMULATION_PARAM]: tryGpuSimulation,
          },
        },
        ...Object.fromEntries(
          names.map((name, index) => [
            `w_${name}`,
            {
              id: `w_${name}`,
              type: "constant",
              parameters: { type, value: type === "vec4" ? [index, 0, 0, 1] : index },
              position: { x: 0, y: index * 80 },
            },
          ]),
        ),
      },
      outputBindings: [
        ...behavior.outputBindings,
        ...names.map((name) => ({
          slot: `attr:${name}`,
          from: { nodeId: `w_${name}`, socketKey: "out" },
          phase: "spawn" as const,
        })),
      ],
    },
    // slot = a0 + a1 + ... - every read reachable, every read in the fragment stage.
    renderGraph: {
      ...render,
      nodes: {
        ...render.nodes,
        ...Object.fromEntries(
          names.map((name, index) => [
            `r_${name}`,
            {
              id: `r_${name}`,
              type: "custom-attribute",
              parameters: { name, type },
              position: { x: 0, y: index * 80 },
            },
          ]),
        ),
        ...Object.fromEntries(
          names.slice(1).map((_name, index) => [
            `sum_${String(index)}`,
            {
              id: `sum_${String(index)}`,
              type: "binary-op",
              parameters: { op: "add" },
              position: { x: 200, y: index * 80 },
            },
          ]),
        ),
      },
      connections: names.slice(1).flatMap((name, index) => [
        {
          id: `ca_${String(index)}`,
          from: {
            nodeId: index === 0 ? `r_${names[0]}` : `sum_${String(index - 1)}`,
            socketKey: index === 0 ? "value" : "out",
          },
          to: { nodeId: `sum_${String(index)}`, socketKey: "a" },
        },
        {
          id: `cb_${String(index)}`,
          from: { nodeId: `r_${name}`, socketKey: "value" },
          to: { nodeId: `sum_${String(index)}`, socketKey: "b" },
        },
      ]),
      outputBindings: [
        ...render.outputBindings.filter((binding) => binding.slot !== slot),
        {
          slot,
          from:
            names.length === 1
              ? { nodeId: `r_${names[0]}`, socketKey: "value" }
              : { nodeId: `sum_${String(names.length - 2)}`, socketKey: "out" },
        },
      ],
    },
  };
}

describe("export render budget", () => {
  it("refuses an emitter whose fragment stage reads more attributes than WebGL2 can pass", () => {
    // Each fragment-read vec4 takes a varying vector of its own beside the material's one fixed
    // row (WebGL2 guarantees 15) and an attribute of its own (WebGL2 guarantees 16), so the
    // attributes run out first: 11 reads are 3 + 2 + 11 = 16 attributes and 1 + 11 = 12 varying
    // vectors, 12 reads 17 attributes.
    expect(() => compileEmitter(emitterReading(11))).not.toThrow();
    expect(() => compileEmitter(emitterReading(12))).toThrow(
      /17 vertex attributes; every WebGL2 GPU/,
    );
  });

  it("counts either backend's attributes over its packed slot", () => {
    // Twelve floats: 17 vertex attributes if each had one of its own (past WebGL2's 16), but both
    // the JS mesh and the GPU kernel's read them from the slot four to a view.
    expect(() => compileEmitter(emitterReading(12, { type: "float" }))).not.toThrow();
    expect(() =>
      compileEmitter(emitterReading(12, { type: "float", tryGpuSimulation: false })),
    ).not.toThrow();
  });
});
