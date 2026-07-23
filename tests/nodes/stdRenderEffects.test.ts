import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { registerStandardRenderNodes } from "../../src/engine/nodes-std/index";
import { FX_RENDER_EFFECT_NODES } from "../../src/engine/nodes-std/render/effects";
import { fxLambertShading, fxAmbientShading } from "../../src/engine/nodes-std/render/lighting";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function registry(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  return r;
}

describe("standard render effects - registration & compilation", () => {
  const compiler = new FXCompilerBaseline();

  it("registers every effect definition and describes serializably", () => {
    const r = registry();
    for (const def of FX_RENDER_EFFECT_NODES) {
      expect(r.has(def.type)).toBe(true);
      expect(() => JSON.stringify(def.describe())).not.toThrow();
    }
  });

  it("color inlines its albedo as a literal (no uniform slot)", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([["c", r.create("constant", { type: "color", value: [1, 0, 0, 1] })]]),
      connections: [],
      outputBindings: [bind("albedo", "c", "out")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    // Variant A: a constant color bakes inline; only param nodes allocate uniforms.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
    const src = shader.fragment.body.join("\n") + JSON.stringify(shader.outputs);
    expect(src).toContain("1.0");
  });

  it("color -> dissolve -> albedo emits the shared noise helper and samples it", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["c", r.create("constant", { type: "color" })],
        ["d", r.create("dissolve", { scale: 6, edge: 0.2 })],
      ]),
      connections: [edge("c", "out", "d", "color")],
      outputBindings: [bind("albedo", "d", "color")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const helpers = shader.fragment.helperFunctions.join("\n");
    const body = shader.fragment.body.join("\n");
    // dissolve no longer bakes its own named helper - it builds on the shared `noise` primitive
    // (baseline: sin-hash) through ordinary IR calls, so only that helper (plus its own
    // smoothstep/mix call sites, inline in the body) shows up.
    expect(helpers).toContain("float noise(vec2 p)");
    expect(body).toContain("noise(");
    expect(body).toContain("smoothstep(");
    // color + dissolve's scale/edge are all inline literals now - no uniform slots spent.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("blend composites two colors; the mode is structural", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["a", r.create("constant", { type: "color", value: [1, 0, 0, 1] })],
        ["b", r.create("constant", { type: "color", value: [0, 0, 1, 1] })],
        ["mix", r.create("blend", { mode: "add" })],
      ]),
      connections: [edge("a", "out", "mix", "base"), edge("b", "out", "mix", "blend")],
      outputBindings: [bind("albedo", "mix", "color")],
    });
    expect(() => compiler.compile(graph, FX_PARTICLE_TARGET)).not.toThrow();

    const add = r.create("blend", { mode: "add" });
    const screen = r.create("blend", { mode: "screen" });
    expect(add.cacheKey?.()).not.toBe(screen.cacheKey?.());
  });

  it("normal-map unpacks a sampled color and rotates it to world via the surface frame", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["map", r.create("constant", { type: "vec4", value: [0.5, 0.5, 1, 1] })],
        ["nm", r.create("normal-map", {})],
        ["c", r.create("constant", { type: "color" })],
        ["lit", r.create("lambert-shading", {})],
      ]),
      connections: [
        edge("map", "out", "nm", "color"),
        edge("c", "out", "lit", "color"),
        edge("nm", "normal", "lit", "normal"),
      ],
      outputBindings: [bind("albedo", "lit", "color")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const body = shader.fragment.body.join("\n");
    // The unpacked tangent normal goes through the shared surface frame (world), then to the intrinsic.
    expect(body).toContain("fxUnpackNormal");
    expect(body).toContain("fxTangentToWorldNormal");
    expect(body).toContain("fxLambertShade");
  });

  it("surface-normal reads the world-space geometryNormal builtin (usable without a lighting node)", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["sn", r.create("surface-normal", {})],
        ["c", r.create("constant", { type: "color" })],
        ["lit", r.create("lambert-shading", {})],
      ]),
      connections: [edge("c", "out", "lit", "color"), edge("sn", "normal", "lit", "normal")],
      outputBindings: [bind("albedo", "lit", "color")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.fragment.body.join("\n")).toContain("geometryNormal");
  });

  it("spherical-normal is roll-correct: authored in tangent space, rotated through the surface frame", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["sn", r.create("spherical-normal", {})],
        ["c", r.create("constant", { type: "color" })],
        ["lit", r.create("lambert-shading", {})],
      ]),
      connections: [edge("c", "out", "lit", "color"), edge("sn", "normal", "lit", "normal")],
      outputBindings: [bind("albedo", "lit", "color")],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const body = shader.fragment.body.join("\n");
    // It builds a tangent-space bump, then rotates it into world with the runtime tangent + normal.
    expect(body).toContain("fxComputeSphericalNormal");
    expect(body).toContain("fxTangentToWorldNormal");
    expect(body).toContain("geometryTangent");
  });

  it("lambert/ambient shading expose inline Color + Emission color inputs", () => {
    for (const def of [fxLambertShading, fxAmbientShading]) {
      const inputs = def.describe().inputs;
      const color = inputs.find((socket) => socket.key === "color");
      const emission = inputs.find((socket) => socket.key === "emission");
      // Both are inline color pickers (item 3), and emission is the new unlit add (item 2).
      expect(color?.control?.color).toBe(true);
      expect(emission?.control?.color).toBe(true);
    }
  });

  it("a lambert node adds its emission on top of the shaded color", () => {
    const r = registry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([
        ["emit", r.create("constant", { type: "vec4", value: [0.2, 0, 0, 1] })],
        ["lit", r.create("lambert-shading", {})],
      ]),
      connections: [edge("emit", "out", "lit", "emission")],
      outputBindings: [bind("albedo", "lit", "color")],
    });
    const body = compiler.compile(graph, FX_PARTICLE_TARGET).fragment.body.join("\n");
    // Shaded color plus the emission rgb (alpha zeroed so it never disturbs the shaded alpha).
    expect(body).toContain("fxLambertShade");
    expect(body).toMatch(/fxLambertShade\([^\n]*\)\s*\+/);
  });
});
