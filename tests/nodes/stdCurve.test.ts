import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXCurveData } from "../../src/engine/core/nodes/FXParamSpec";
import { DEFAULT_CURVE } from "../../src/engine/core/nodes/FXParamSpec";
import {
  buildParticleUpdateKernel,
  compileParticleBehavior,
  previewParticleBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

// The Curve node (`ramp`) remaps a scalar `t` through an editable smooth/sharp curve, baked
// inline (a piecewise-linear mix chain over pre-sampled points) so it runs in both backends.

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

/** constant(t) -> ramp; binds `out` into the float `positionX` slot, runs, reads it back. */
function rampAt(curve: FXCurveData | undefined, t: number): number {
  const r = registry();
  const nodes = new Map<string, FXBehaviorNode>([
    ["t", r.create("constant", { value: t, type: "float" })],
    ["ramp", r.create("ramp", curve === undefined ? undefined : { curve })],
  ]);
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes,
    connections: [edge("t", "out", "ramp", "t")],
    outputBindings: [bind("positionX", "ramp", "out")],
  });
  const compiled = compileParticleBehavior(graph);
  const update = buildParticleUpdateKernel(compiled);
  const buffers = coreBuffers();
  update(buffers, 1, 0.016, compiled.update.bindings);
  return buffers.position[0];
}

const sharp = (position: number, value: number): FXCurveData["points"][number] => ({
  position,
  value,
  interpolation: "sharp",
});
const smooth = (position: number, value: number): FXCurveData["points"][number] => ({
  position,
  value,
  interpolation: "smooth",
});

describe("curve node (ramp)", () => {
  it("registers as a shared node in both backends", () => {
    const behavior = new FXNodeRegistry<FXBehaviorNode>();
    registerStandardBehaviorNodes(behavior);
    const render = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(render);
    expect(behavior.has("ramp")).toBe(true);
    expect(render.has("ramp")).toBe(true);
  });

  it("passes the default identity curve straight through (out ~= t)", () => {
    // DEFAULT_CURVE: (0,0) -> (1,1). A straight line stays exact under discretization
    // (linear samples re-lerp exactly), whichever endpoints' smoothing.
    expect(rampAt(DEFAULT_CURVE, 0)).toBeCloseTo(0, 6);
    expect(rampAt(DEFAULT_CURVE, 0.25)).toBeCloseTo(0.25, 6);
    expect(rampAt(DEFAULT_CURVE, 0.5)).toBeCloseTo(0.5, 6);
    expect(rampAt(DEFAULT_CURVE, 1)).toBeCloseTo(1, 6);
    expect(rampAt(undefined, 0.5)).toBeCloseTo(0.5, 6); // no param -> same default
  });

  it("is a linear triangle when all anchors are sharp", () => {
    const tri: FXCurveData = { points: [sharp(0, 0), sharp(0.5, 1), sharp(1, 0)] };
    // The rising/falling edges are linear regions, so sampling is exact there.
    expect(rampAt(tri, 0.25)).toBeCloseTo(0.5, 6);
    expect(rampAt(tri, 0.75)).toBeCloseTo(0.5, 6);
  });

  it("a smooth arch bulges above the linear (sharp) reading of the same anchors", () => {
    const anchors: [number, number][] = [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ];
    const smoothArch: FXCurveData = { points: anchors.map(([p, v]) => smooth(p, v)) };
    const sharpArch: FXCurveData = { points: anchors.map(([p, v]) => sharp(p, v)) };
    // At t=0.25 the sharp arch reads the linear 0.5; Catmull-Rom smoothing lifts it well above.
    expect(rampAt(sharpArch, 0.25)).toBeCloseTo(0.5, 6);
    expect(rampAt(smoothArch, 0.25)).toBeGreaterThan(0.55);
  });

  it("extrapolates flat outside [first, last] anchor", () => {
    const curve: FXCurveData = { points: [smooth(0.25, 0.2), smooth(0.75, 0.8)] };
    expect(rampAt(curve, 0)).toBeCloseTo(0.2, 6); // below first anchor -> first value
    expect(rampAt(curve, 1)).toBeCloseTo(0.8, 6); // above last anchor -> last value
  });

  it("editing the curve moves the structural hash (baked inline -> recompile)", () => {
    const r = registry();
    const ramp = r.create("ramp", undefined);
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([
        ["t", r.create("constant", { value: 0.5, type: "float" })],
        ["ramp", ramp],
      ]),
      connections: [edge("t", "out", "ramp", "t")],
      outputBindings: [bind("positionX", "ramp", "out")],
    });
    const before = previewParticleBehaviorHash(graph);
    ramp.applyParams?.({ curve: { points: [smooth(0, 1), sharp(0.5, 0.2), smooth(1, 0)] } });
    expect(previewParticleBehaviorHash(graph)).not.toBe(before);
  });

  it("rejects a malformed curve (non-finite / bad interpolation)", () => {
    const r = registry();
    expect(() =>
      r.create("ramp", { curve: { points: [{ position: 0, value: Number.NaN }] } }),
    ).toThrow(/FXNodeDefinition/);
    expect(() =>
      r.create("ramp", {
        curve: { points: [{ position: 0, value: 0, interpolation: "wobbly" }] },
      }),
    ).toThrow(/FXNodeDefinition/);
  });

  it("compiles into the render backend (feeds a material albedo's alpha)", () => {
    const r = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(r);
    const nodes = new Map<string, FXRenderNode>([
      ["rgb", r.create("constant", { value: [1, 0, 0], type: "vec3" })],
      ["ramp", r.create("ramp", undefined)],
      ["combine", r.create("combine-color", undefined)],
    ]);
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes,
      connections: [edge("rgb", "out", "combine", "rgb"), edge("ramp", "out", "combine", "alpha")],
      outputBindings: [bind("albedo", "combine", "color")],
    });
    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
    const src = shader.fragment.body.join("\n");
    expect(src).toContain("mix");
    expect(src).toContain("clamp");
  });

  // The bake places knots adaptively: one `mix` per emitted segment, and combine-color adds none,
  // so counting `mix(` in the fragment is exactly the curve's segment count.
  function rampSegments(curve: FXCurveData | undefined): number {
    const r = new FXNodeRegistry<FXRenderNode>();
    registerStandardRenderNodes(r);
    const nodes = new Map<string, FXRenderNode>([
      ["rgb", r.create("constant", { value: [1, 0, 0], type: "vec3" })],
      ["ramp", r.create("ramp", curve === undefined ? undefined : { curve })],
      ["combine", r.create("combine-color", undefined)],
    ]);
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes,
      connections: [edge("rgb", "out", "combine", "rgb"), edge("ramp", "out", "combine", "alpha")],
      outputBindings: [bind("albedo", "combine", "color")],
    });
    const src = new FXCompilerBaseline()
      .compile(graph, FX_PARTICLE_TARGET)
      .fragment.body.join("\n");
    return (src.match(/mix\(/g) ?? []).length;
  }

  it("collapses a straight line to a single segment (adaptive, not a fixed grid)", () => {
    // The default identity curve is linear, so its reconstruction needs no interior knots.
    expect(rampSegments(DEFAULT_CURVE)).toBe(1);
    // An all-sharp triangle is two exact linear pieces - a knot at each anchor, nothing between.
    const tri: FXCurveData = { points: [sharp(0, 0), sharp(0.5, 1), sharp(1, 0)] };
    expect(rampSegments(tri)).toBe(2);
  });

  it("spends more segments on a curved region but never exceeds the 32-point budget", () => {
    const arch: FXCurveData = { points: [smooth(0, 0), smooth(0.5, 1), smooth(1, 0)] };
    // A full-amplitude smooth bump genuinely needs several linear pieces per side.
    expect(rampSegments(arch)).toBeGreaterThan(2);
    // A pathologically wiggly curve is capped: at most CURVE_MAX_POINTS (32) knots => 31 segments.
    const wiggle: FXCurveData = {
      points: Array.from({ length: 12 }, (_, i) => smooth(i / 11, i % 2)),
    };
    expect(rampSegments(wiggle)).toBeLessThanOrEqual(31);
  });
});
