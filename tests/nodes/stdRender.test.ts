import { describe, expect, it } from "vitest";
import type { FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import { FX_RENDER_SOURCE_NODES } from "../../src/engine/nodes-std/render/source";
import { FX_RENDER_CONTENT_NODES } from "../../src/engine/nodes-std/render/content";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function registry(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  return r;
}

function graphOf(
  nodes: Map<string, FXRenderNode>,
  out: readonly FXOutputBinding[],
): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes, connections: [], outputBindings: out });
  return graph;
}

describe("standard render nodes - registration & compilation", () => {
  const compiler = new FXCompilerBaseline();

  it("registers every render definition and describes serializably", () => {
    const r = registry();
    for (const def of [...FX_RENDER_SOURCE_NODES, ...FX_RENDER_CONTENT_NODES]) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("color inlines its albedo as a literal (a constant spends no uniform slot)", () => {
    const r = registry();
    const graph = graphOf(
      new Map([["c", r.create("constant", { type: "color", value: [0.2, 0.4, 0.6, 1] })]]),
      [bind("albedo", "c", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
    // Variant A: a constant color bakes inline; only param nodes allocate uniforms.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
    const src = shader.fragment.body.join("\n") + JSON.stringify(shader.outputs);
    expect(src).toContain("0.2");
  });

  it("re-tuning an inline color moves the structural hash (recompile, not rebind)", () => {
    const r = registry();
    const c = r.create("constant", { type: "color", value: [1, 1, 1, 1] });
    const graph = graphOf(new Map([["c", c]]), [bind("albedo", "c", "out")]);
    const before = compiler.previewHash(graph, FX_PARTICLE_TARGET);
    // The color is an inline literal now, so editing it changes the hash -> recompile.
    c.applyParams?.({ value: [0.5, 0.25, 0, 1] });
    expect(compiler.previewHash(graph, FX_PARTICLE_TARGET)).not.toBe(before);
  });

  it("animated-texture is a fragment-stage UV producer driven by a ratio input (inline params)", () => {
    const r = registry();
    const anim = r.create("animated-texture", { columns: 4, rows: 4 });
    // It maps a normalized `ratio` input to the current flipbook cell - no age/lifetime read
    // of its own now; it only reads the UV it offsets (via its `uv` default).
    expect(anim.targetReads).not.toContain("PARTICLE_AGE");
    expect(anim.targetReads).not.toContain("PARTICLE_LIFETIME");
    expect(anim.targetReads).toContain("p_uv");
    // columns/rows are inline literals (editable pins), so it spends no uniform slot: two
    // instances with the same grid hash alike.
    const twin = r.create("animated-texture", { columns: 4, rows: 4 });
    expect(anim.cacheKey?.()).toBe(twin.cacheKey?.());
  });

  it("a stage-param source's stage is inferred (not in the cacheKey)", () => {
    const r = registry();
    // `time`/`color` carry no `stage` param - placement is inferred from the graph, so
    // it does not enter the cacheKey (two `time` sources hash alike).
    const a = r.create("time", {});
    const b = r.create("time", {});
    expect(a.cacheKey?.()).toBe(b.cacheKey?.());
  });

  it("exposes editable float inputs and a defaulted uv input in describe()", () => {
    const anim = FX_RENDER_CONTENT_NODES.find((d) => d.type === "animated-texture");
    expect(anim).toBeDefined();
    const meta = anim?.describe();
    // `columns` is an editable input pin now (the value-on-the-pin), not a body param.
    expect(meta?.params["columns"]).toBeUndefined();
    expect(meta?.inputs.find((s) => s.key === "columns")?.control).toEqual({
      default: 1,
      min: 1,
      max: 64,
      step: 1,
    });
    expect(meta?.inputs).toContainEqual({
      key: "uv",
      type: "vec2",
      label: undefined,
      description: undefined,
      required: undefined,
      default: { targetInput: "p_uv" },
    });
    expect(meta?.outputs).toContainEqual({
      key: "uvPrevious",
      type: "vec2",
      label: undefined,
      description: undefined,
      required: undefined,
    });
    expect(meta?.outputs).toContainEqual({
      key: "uvCurrent",
      type: "vec2",
      label: undefined,
      description: undefined,
      required: undefined,
    });
    expect(meta?.outputs).toContainEqual({
      key: "factor",
      type: "float",
      label: undefined,
      description: undefined,
      required: undefined,
    });
  });
});
