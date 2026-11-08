import { describe, expect, it } from "vitest";
import type { FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import { FX_RENDER_SOURCE_NODES } from "../../src/engine/nodes-std/render/source";
import { FX_RENDER_CONTENT_NODES } from "../../src/engine/nodes-std/render/content";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { literalGenericType } from "../../src/engine/core/socket/FXValueType";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";

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

  it("animated-texture plays once through by default, looping only when asked", () => {
    const r = registry();
    const helpers = (params: Record<string, unknown>): string => {
      const graph = graphOf(
        new Map([
          ["a", r.create("animated-texture", params)],
          ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ]),
        [bind("albedo", "c", "out"), bind("alphaThreshold", "a", "factor")],
      );
      return compiler.compile(graph, FX_PARTICLE_TARGET).fragment.helperFunctions.join("\n");
    };
    // Once through: the ratio is clamped and both frames stop at the last cell, so a particle at
    // the end of its life shows the last frame - never a fade back into the first.
    const once = helpers({ columns: 4, rows: 4 });
    expect(once).toContain("clamp(ratio, 0.0, 1.0)");
    expect(once).toContain("min(frame + 1.0, last)");
    expect(once).not.toContain("fract(");
    const looping = helpers({ columns: 4, rows: 4, loop: true });
    expect(looping).toContain("fract(ratio)");
    expect(looping).toContain("mod(frame + 1.0, totalFrames)");
  });

  it("animated-texture runs over the sheet's used frames, every cell when Frames is 0", () => {
    const r = registry();
    const fragment = (params: Record<string, unknown>) => {
      const graph = graphOf(
        new Map([
          ["a", r.create("animated-texture", params)],
          ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
        ]),
        [bind("albedo", "c", "out"), bind("alphaThreshold", "a", "factor")],
      );
      const stage = compiler.compile(graph, FX_PARTICLE_TARGET).fragment;
      return [...stage.helperFunctions, ...stage.body].join("\n");
    };
    // The frame count: Frames when set (above 0), else columns * rows
    expect(fragment({ columns: 5, rows: 5, frames: 23 })).toMatch(/> 0\.5 \? floor\(/);
    // The column comes off the row, never a mod that may land a cell off at a row's end
    const code = fragment({ columns: 8, rows: 8 });
    expect(code).toContain("float row = floor((frame + 0.5) / columns);");
    expect(code).toContain("float column = frame - row * columns;");
  });

  it("flipbook-frame picks a cell by number: floored, wrapped round the frames, no cross-fade", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["f", r.create("flipbook-frame", { columns: 8, rows: 2, frame: 17.6 })],
        ["l", r.create("length", {})],
        ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        { from: { nodeId: "f", socketKey: "uv" }, to: { nodeId: "l", socketKey: "v" } },
      ],
      outputBindings: [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
    });
    const stage = compiler.compile(graph, FX_PARTICLE_TARGET).fragment;
    const code = [...stage.helperFunctions, ...stage.body].join("\n");
    expect(code).toMatch(/floor\(\(floor\(.*\+ 0\.5\) \//);
    expect(code).toContain("fxFlipbookFrameUV(");
    expect(code).not.toContain("fxAnimatedFrame");
  });

  it("compiles a wired intensity into the artifact's outputs, beside albedo", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["c", r.create("constant", { type: "color", value: [1, 0.5, 0.2, 1] })],
        ["i", r.create("constant", { type: "float", value: 2.5 })],
      ]),
      [bind("albedo", "c", "out"), bind("intensity", "i", "out")],
    );
    const compiled = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(compiled.outputs["intensity"]).toBeDefined();
    expect(compiled.outputs["albedo"]).toBeDefined();
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
      key: "uvFrame",
      type: "vec2",
      label: undefined,
      description: undefined,
      required: undefined,
    });
    expect(meta?.outputs).toContainEqual({
      key: "uvNext",
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

describe("standard render nodes - surface sources, literal-typed generics, pivot", () => {
  const compiler = new FXCompilerBaseline();

  /** The fragment code a graph with `node` feeding `alphaThreshold` (white albedo) compiles to. */
  function fragmentOf(
    node: FXRenderNode,
    socketKey: string,
    target: Parameters<FXCompilerBaseline["compile"]>[1] = FX_PARTICLE_TARGET,
  ): string {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["n", node],
        ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [bind("albedo", "c", "out"), bind("alphaThreshold", "n", socketKey)],
    );
    const stage = compiler.compile(graph, target).fragment;
    return [...stage.helperFunctions, ...stage.body].join("\n");
  }

  it("front-facing reads gl_FrontFacing, on a particle and on a VFX mesh", () => {
    const r = registry();
    expect(fragmentOf(r.create("front-facing", {}), "out")).toContain("gl_FrontFacing");
    expect(fragmentOf(r.create("front-facing", {}), "out", FX_MESH_TARGET)).toContain(
      "gl_FrontFacing",
    );
  });

  it("surface-position reads the fragment's world position, on a VFX mesh too", () => {
    const r = registry();
    const length = (): Map<string, FXRenderNode> =>
      new Map([
        ["p", r.create("surface-position", {})],
        ["l", r.create("length", {})],
        ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]);
    for (const target of [FX_PARTICLE_TARGET, FX_MESH_TARGET]) {
      const graph = new FXGraph<FXRenderNode>();
      graph.ingest({
        nodes: length(),
        connections: [
          { from: { nodeId: "p", socketKey: "position" }, to: { nodeId: "l", socketKey: "v" } },
        ],
        outputBindings: [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
      });
      const stage = compiler.compile(graph, target).fragment;
      expect(stage.body.join("\n")).toContain("worldPosition");
    }
  });

  it("a mix of two typed-in colors resolves to vec4 with nothing wired", () => {
    const r = registry();
    const graph = graphOf(
      new Map([["m", r.create("mix", { a: [1, 0, 0, 1], b: [0, 0, 1, 1], t: 0.25 })]]),
      [bind("albedo", "m", "out")],
    );
    const compiled = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(compiled.outputs["albedo"]).toBeDefined();
    expect(compiled.fragment.body.join("\n")).toContain("vec4(");
  });

  it("a binary-op of two typed-in numbers resolves to float with nothing wired", () => {
    const r = registry();
    expect(fragmentOf(r.create("binary-op", { op: "multiply", a: 0.5, b: 0.4 }), "out")).toMatch(
      /0\.5 \* 0\.4/,
    );
  });

  it("compose-transform shifts its translation by the rotated, scaled pivot", () => {
    const r = registry();
    const graph = graphOf(
      new Map([
        ["t", r.create("compose-transform", { scale: [2, 3, 1], pivot: [0, -0.5, 0] })],
        ["c", r.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      [bind("albedo", "c", "out"), bind("particleTransform", "t", "out")],
    );
    const vertex = compiler.compile(graph, FX_PARTICLE_TARGET).vertex.body.join("\n");
    expect(vertex).toContain("-0.5");
  });
});

describe("literalGenericType", () => {
  it("takes the widest vector, else float for numbers, else nothing", () => {
    expect(literalGenericType([0.5, [1, 0, 0, 1]])).toBe("vec4");
    expect(
      literalGenericType([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toBe("vec3");
    expect(literalGenericType([0, 1])).toBe("float");
    expect(literalGenericType([undefined])).toBeUndefined();
    expect(literalGenericType([])).toBeUndefined();
  });
});
