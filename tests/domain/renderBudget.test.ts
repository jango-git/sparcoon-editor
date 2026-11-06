import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RenderBudgetMemo, renderBudgetFindings } from "../../src/domain/renderBudget";
import { createDefaultEmitter, createDefaultVfxMesh } from "../../src/model/editorState";
import { compileEmitter, compileMesh } from "../../src/persistence/exportCompile";
import { PROJECT_PRESETS } from "../../src/persistence/presets";
import { deserializeProject } from "../../src/persistence/projectFile";
import type { EmitterDoc } from "../../src/model/editorState";

describe("renderBudgetFindings", () => {
  it("finds nothing within both tiers' minimums", () => {
    expect(renderBudgetFindings({ attributes: 8, varyingVectors: 8 })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("warns past only Baseline's (WebGL1) minimums", () => {
    const { errors, warnings } = renderBudgetFindings({ attributes: 9, varyingVectors: 12 });
    expect(errors).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      "render-attribute-budget-baseline",
      "render-varying-budget-baseline",
    ]);
    expect(warnings[0]?.params).toEqual({ used: 9, limit: 8 });
  });

  it("errs past Standard's (WebGL2) minimums, without repeating the same overrun as a warning", () => {
    const { errors, warnings } = renderBudgetFindings({ attributes: 17, varyingVectors: 12 });
    expect(errors.map((error) => error.code)).toEqual(["render-attribute-budget"]);
    expect(errors[0]?.params).toEqual({ used: 17, limit: 16 });
    // The varyings are still past Baseline's only.
    expect(warnings.map((warning) => warning.code)).toEqual(["render-varying-budget-baseline"]);
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

/** The starter emitter with `count` vec4 behavior attributes, each read in the fragment stage. */
function emitterReading(count: number): EmitterDoc {
  const emitter = createDefaultEmitter("emitter_1", "Heavy");
  const names = Array.from({ length: count }, (_, index) => `a${String(index)}`);
  const behavior = emitter.behaviorGraph;
  const render = emitter.renderGraph;
  return {
    ...emitter,
    behaviorGraph: {
      ...behavior,
      attributes: names.map((name) => ({ name, type: "vec4" })),
      nodes: {
        ...behavior.nodes,
        ...Object.fromEntries(
          names.map((name, index) => [
            `w_${name}`,
            {
              id: `w_${name}`,
              type: "constant",
              parameters: { type: "vec4", value: [index, 0, 0, 1] },
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
    // albedo = a0 + a1 + ... - every read reachable, every read in the fragment stage.
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
              parameters: { name, type: "vec4" },
              position: { x: 0, y: index * 80 },
            },
          ]),
        ),
        ...Object.fromEntries(
          names.slice(1).map((name, index) => [
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
        ...render.outputBindings.filter((binding) => binding.slot !== "albedo"),
        {
          slot: "albedo",
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
  it("compiles every bundled preset within the Standard tier's minimums", () => {
    for (const preset of PROJECT_PRESETS) {
      const source = deserializeProject(
        readFileSync(
          new URL(`../../src/persistence/presets/${preset.fileName}`, import.meta.url),
          "utf8",
        ),
      );
      expect(source, preset.id).toBeDefined();
      for (const emitter of source!.scene.emitters) {
        expect(() => compileEmitter(emitter), `${preset.id}/${emitter.name}`).not.toThrow();
      }
      for (const mesh of source!.scene.meshes) {
        expect(() => compileMesh(mesh), `${preset.id}/${mesh.name}`).not.toThrow();
      }
    }
  });

  it("refuses an emitter whose fragment stage reads more attributes than WebGL2 can pass", () => {
    // Each fragment-read vec4 takes a varying vector of its own; WebGL2 guarantees 15 in all.
    expect(() => compileEmitter(emitterReading(4))).not.toThrow();
    // 11: 3 + 2 + 11 = 16 attributes (within the minimum), 5 + 11 = 16 varying vectors (past it).
    expect(() => compileEmitter(emitterReading(11))).toThrow(
      /16 varying vectors; every WebGL2 GPU/,
    );
  });
});

describe("default VFX mesh", () => {
  it("reads its world matrix, so it moves with its transform", () => {
    const ir = compileMesh(createDefaultVfxMesh("mesh_1", "Mesh"));
    const code = [
      ...ir.shaders.standard.vertex.body,
      ...Object.values(ir.shaders.standard.outputs),
    ];
    expect(code.join("\n")).toMatch(/\bmodelMatrix\b/);
  });
});
