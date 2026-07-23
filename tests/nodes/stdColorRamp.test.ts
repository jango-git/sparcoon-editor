import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardBehaviorNodes } from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGradientData } from "../../src/engine/core/nodes/FXParamSpec";
import { DEFAULT_GRADIENT } from "../../src/engine/core/nodes/FXParamSpec";
import {
  buildParticleUpdateKernel,
  compileParticleBehavior,
  previewParticleBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

// Color Ramp maps a scalar `t` through a gradient and emits a single RGBA `vec4` color.
// To read rgb + alpha separately in the behavior backend these route the ramp through a
// Split Color node and bind each part into a core state slot: `rgb` -> the `position` vec3
// (rgb in position[0..2]); `alpha` -> `positionX` (a float).

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function coreBuffers(): Record<string, Float32Array> {
  return { position: new Float32Array(3), lifecycle: new Float32Array(2) };
}

function registry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  return r;
}

/** constant(t) -> color-ramp -> split-color; binds one split output to `slot`, runs, reads it. */
function evalRamp(
  gradient: FXGradientData | undefined,
  t: number,
  output: "rgb" | "alpha",
  slot: string,
): Record<string, Float32Array> {
  const r = registry();
  const nodes = new Map<string, FXBehaviorNode>([
    ["t", r.create("constant", { value: t, type: "float" })],
    ["ramp", r.create("color-ramp", gradient === undefined ? undefined : { gradient })],
    ["split", r.create("split-color", undefined)],
  ]);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections: [edge("t", "out", "ramp", "t"), edge("ramp", "color", "split", "color")],
    outputBindings: [bind(slot, "split", output)],
  });
  const compiled = compileParticleBehavior(graph);
  const update = buildParticleUpdateKernel(compiled);
  const buffers = coreBuffers();
  update(buffers, 1, 0.016, compiled.update.bindings);
  return buffers;
}

/** rgb the ramp emits at `t` for `gradient`. */
function colorAt(gradient: FXGradientData | undefined, t: number): [number, number, number] {
  const b = evalRamp(gradient, t, "rgb", "position");
  return [b.position[0], b.position[1], b.position[2]];
}

/** the alpha the ramp emits at `t` for `gradient`. */
function alphaAt(gradient: FXGradientData | undefined, t: number): number {
  return evalRamp(gradient, t, "alpha", "positionX").position[0];
}

describe("color-ramp node", () => {
  it("registers and describes JSON-serializably", () => {
    const r = registry();
    expect(r.has("color-ramp")).toBe(true);
  });

  it("samples the default black->white ramp linearly across t", () => {
    // DEFAULT_GRADIENT: (0,0,0,1) @0 -> (1,1,1,1) @1.
    expect(colorAt(DEFAULT_GRADIENT, 0)).toEqual([0, 0, 0]);
    const mid = colorAt(DEFAULT_GRADIENT, 0.5);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.5, 6);
    expect(mid[2]).toBeCloseTo(0.5, 6);
    expect(colorAt(DEFAULT_GRADIENT, 1).map((c) => Math.round(c))).toEqual([1, 1, 1]);
    expect(alphaAt(DEFAULT_GRADIENT, 0.5)).toBeCloseTo(1, 6);
  });

  it("interpolates color and alpha independently between stops", () => {
    // red-transparent (1,0,0,0) @0 -> blue-opaque (0,0,1,1) @1.
    const g: FXGradientData = {
      stops: [
        { position: 0, color: [1, 0, 0, 0] },
        { position: 1, color: [0, 0, 1, 1] },
      ],
    };
    const mid = colorAt(g, 0.5);
    expect(mid[0]).toBeCloseTo(0.5, 6); // r
    expect(mid[1]).toBeCloseTo(0, 6); // g
    expect(mid[2]).toBeCloseTo(0.5, 6); // b
    expect(alphaAt(g, 0.5)).toBeCloseTo(0.5, 6);
    expect(alphaAt(g, 0.25)).toBeCloseTo(0.25, 6);
  });

  it("clamps outside [first, last] to a flat color (t below 0 / above 1)", () => {
    const g: FXGradientData = {
      stops: [
        { position: 0.25, color: [0.2, 0.2, 0.2, 1] },
        { position: 0.75, color: [0.8, 0.8, 0.8, 1] },
      ],
    };
    expect(colorAt(g, 0)[0]).toBeCloseTo(0.2, 6); // below first stop -> first color
    expect(colorAt(g, 1)[0]).toBeCloseTo(0.8, 6); // above last stop -> last color
  });

  it("honors a three-stop gradient at its middle stop", () => {
    const g: FXGradientData = {
      stops: [
        { position: 0, color: [0, 0, 0, 1] },
        { position: 0.5, color: [1, 0, 0, 1] },
        { position: 1, color: [0, 0, 0, 1] },
      ],
    };
    const mid = colorAt(g, 0.5);
    expect(mid[0]).toBeCloseTo(1, 6);
    expect(mid[1]).toBeCloseTo(0, 6);
  });

  it("editing the gradient moves the structural hash (baked inline -> recompile)", () => {
    const r = registry();
    const ramp = r.create("color-ramp", undefined);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["t", r.create("constant", { value: 0.5, type: "float" })],
        ["ramp", ramp],
        ["split", r.create("split-color", undefined)],
      ]),
      connections: [edge("t", "out", "ramp", "t"), edge("ramp", "color", "split", "color")],
      outputBindings: [bind("positionX", "split", "alpha")],
    });
    const before = previewParticleBehaviorHash(graph);
    ramp.applyParams?.({
      gradient: {
        stops: [
          { position: 0, color: [1, 1, 1, 0] },
          { position: 1, color: [0, 0, 0, 1] },
        ],
      },
    });
    expect(previewParticleBehaviorHash(graph)).not.toBe(before);
  });

  it("rejects a malformed gradient (non-finite / wrong-width color)", () => {
    const r = registry();
    expect(() => r.create("color-ramp", { gradient: { stops: [] } })).toThrow();
    expect(() =>
      r.create("color-ramp", { gradient: { stops: [{ position: 0, color: [1, 0, 0] } as never] } }),
    ).toThrow();
  });

  // The shared node's primary use is coloring the material, so it must compile in the
  // render (GLSL) backend too. Round-trip the RGBA through Split Color + Combine Color
  // (exercising both new nodes) back into a vec4 albedo.
  it("compiles into the render backend feeding a material albedo", () => {
    const r = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(r);
    const nodes = new Map<string, FXRenderNode>([
      ["ramp", r.create("color-ramp", undefined)],
      ["split", r.create("split-color", undefined)],
      ["combine", r.create("combine-color", undefined)],
    ]);
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes,
      connections: [
        edge("ramp", "color", "split", "color"),
        edge("split", "rgb", "combine", "rgb"),
        edge("split", "alpha", "combine", "alpha"),
      ],
      outputBindings: [bind("albedo", "combine", "color")],
    });
    const compiler = new FXCompilerBaseline();
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
    const src = shader.fragment.body.join("\n");
    expect(src).toContain("mix");
    expect(src).toContain("clamp");
  });

  it("combine-color and split-color round-trip rgb + alpha (vec4)", () => {
    // constant(rgb) + constant(a) -> combine-color -> split-color -> bind rgb & alpha back.
    const r = registry();
    const build = (output: "rgb" | "alpha", slot: string): Record<string, Float32Array> => {
      const nodes = new Map<string, FXBehaviorNode>([
        ["rgb", r.create("constant", { value: [0.1, 0.2, 0.3], type: "vec3" })],
        ["a", r.create("constant", { value: 0.4, type: "float" })],
        ["combine", r.create("combine-color", undefined)],
        ["split", r.create("split-color", undefined)],
      ]);
      const graph = new FXGraph<FXBehaviorNode>();
      graph.ingest({
        nodes,
        connections: [
          edge("rgb", "out", "combine", "rgb"),
          edge("a", "out", "combine", "alpha"),
          edge("combine", "color", "split", "color"),
        ],
        outputBindings: [bind(slot, "split", output)],
      });
      const compiled = compileParticleBehavior(graph);
      const update = buildParticleUpdateKernel(compiled);
      const buffers = coreBuffers();
      update(buffers, 1, 0.016, compiled.update.bindings);
      return buffers;
    };
    const rgb = build("rgb", "position").position;
    expect(rgb[0]).toBeCloseTo(0.1, 6);
    expect(rgb[1]).toBeCloseTo(0.2, 6);
    expect(rgb[2]).toBeCloseTo(0.3, 6);
    expect(build("alpha", "positionX").position[0]).toBeCloseTo(0.4, 6);
  });

  // hsl-adjust takes a color in and shifts its hue/saturation/lightness in HSL space.
  // Feed a constant(vec4) color, adjust, split, read the rgb back.
  const adjustRgb = (
    color: readonly number[],
    params: { hueShift?: number; saturation?: number; lightness?: number },
  ): [number, number, number] => {
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["c", r.create("constant", { value: [...color], type: "vec4" })],
      ["hue", r.create("constant", { value: params.hueShift ?? 0, type: "float" })],
      ["sat", r.create("constant", { value: params.saturation ?? 1, type: "float" })],
      ["lit", r.create("constant", { value: params.lightness ?? 1, type: "float" })],
      ["hsl", r.create("hsl-adjust", undefined)],
      ["split", r.create("split-color", undefined)],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [
        edge("c", "out", "hsl", "color"),
        edge("hue", "out", "hsl", "hueShift"),
        edge("sat", "out", "hsl", "saturation"),
        edge("lit", "out", "hsl", "lightness"),
        edge("hsl", "color", "split", "color"),
      ],
      outputBindings: [bind("position", "split", "rgb")],
    });
    const compiled = compileParticleBehavior(graph);
    const update = buildParticleUpdateKernel(compiled);
    const buffers = coreBuffers();
    update(buffers, 1, 0.016, compiled.update.bindings);
    return [buffers.position[0], buffers.position[1], buffers.position[2]];
  };
  const nearRgb = (got: number[], want: number[]): void => {
    for (let i = 0; i < 3; i++) {
      expect(got[i]).toBeCloseTo(want[i], 5);
    }
  };

  it("hsl-adjust passes a color through unchanged at identity settings", () => {
    nearRgb(adjustRgb([0.2, 0.5, 0.7, 1], {}), [0.2, 0.5, 0.7]);
    nearRgb(
      adjustRgb([0.9, 0.1, 0.3, 1], { hueShift: 0, saturation: 1, lightness: 1 }),
      [0.9, 0.1, 0.3],
    );
  });

  it("hsl-adjust rotates hue (red -> green -> blue at +/-1/3 turns)", () => {
    nearRgb(adjustRgb([1, 0, 0, 1], { hueShift: 1 / 3 }), [0, 1, 0]);
    nearRgb(adjustRgb([1, 0, 0, 1], { hueShift: 2 / 3 }), [0, 0, 1]);
  });

  it("hsl-adjust with saturation 0 collapses to the greyscale lightness", () => {
    // red (1,0,0) has L = 0.5 -> desaturating to 0 yields mid grey.
    nearRgb(adjustRgb([1, 0, 0, 1], { saturation: 0 }), [0.5, 0.5, 0.5]);
  });

  it("hsl-adjust with lightness 0 yields black, and passes alpha through", () => {
    nearRgb(adjustRgb([0.3, 0.6, 0.9, 0.4], { lightness: 0 }), [0, 0, 0]);
    const r = registry();
    const nodes = new Map<string, FXBehaviorNode>([
      ["c", r.create("constant", { value: [0.3, 0.6, 0.9, 0.4], type: "vec4" })],
      ["hsl", r.create("hsl-adjust", undefined)],
      ["split", r.create("split-color", undefined)],
    ]);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes,
      connections: [edge("c", "out", "hsl", "color"), edge("hsl", "color", "split", "color")],
      outputBindings: [bind("positionX", "split", "alpha")],
    });
    const compiled = compileParticleBehavior(graph);
    const buffers = coreBuffers();
    buildParticleUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[0]).toBeCloseTo(0.4, 6); // alpha untouched
  });

  it("hsl-adjust compiles into the render backend feeding a material albedo", () => {
    const r = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(r);
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([["hsl", r.create("hsl-adjust", undefined)]]),
      connections: [],
      outputBindings: [bind("albedo", "hsl", "color")],
    });
    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
  });
});
