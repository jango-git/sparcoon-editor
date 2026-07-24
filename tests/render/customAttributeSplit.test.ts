import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { renderRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;
const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

/** A registry with the standard render nodes plus the manual ones. */
function renderReg() {
  const registry = renderRegistry();
  registerManualRenderNodes(registry);
  return registry;
}

/** A render graph whose alpha threshold is the `x` component of a per-particle `tint` attribute;
 *  albedo is a plain white constant so the graph has a valid (required) albedo binding too. */
function tintGraph(): FXGraph<FXRenderNode> {
  const reg = renderReg();
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["tint", new FXRenderNodeCustomAttributeSplit("tint", VEC4)],
      ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
    ]),
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      { slot: "alphaThreshold", from: { nodeId: "tint", socketKey: "x" } },
    ],
  });
  return graph;
}

describe("custom-attribute-split render node", () => {
  it("declares its attribute request and reads the p_fx_<name> varying", () => {
    const node = new FXRenderNodeCustomAttributeSplit("tint", VEC4);
    expect(node.attributeRequest).toEqual({ name: "tint", type: VEC4 });
    expect(node.stage).toBe(FXShaderStage.FRAGMENT); // nominal fallback
    expect(node.stageFlexible).toBe(true); // effective stage is inferred
    expect(node.cacheKey()).toBe("tint:vec4");
  });

  it("always declares all four x/y/z/w float outputs, regardless of the source width", () => {
    const node = new FXRenderNodeCustomAttributeSplit("tint", FLOAT);
    expect(node.outputs.map((socket) => socket.key)).toEqual(["x", "y", "z", "w"]);
    expect(node.outputs.every((socket) => socket.type === FLOAT)).toBe(true);
  });

  it("keeps name/type structural but treats stage as inferred, not structural", () => {
    const node = new FXRenderNodeCustomAttributeSplit("tint", VEC4);

    expect(() => node.applyParams({ name: "tint", type: "vec4" })).not.toThrow();
    expect(() => node.applyParams({ stage: "vertex" })).not.toThrow();
    expect(() => node.applyParams({ stage: "fragment" })).not.toThrow();
    expect(() => node.applyParams({ stage: "geometry" })).toThrow(/"stage" must be/);
    expect(() => node.applyParams({ type: "vec3" })).toThrow(/structural param "type"/);
    expect(() => node.applyParams({ name: "other" })).toThrow(/structural param "name"/);

    expect(node.cacheKey()).toBe("tint:vec4");
  });

  it("compiles into GLSL that samples p_fx_tint, fed into alphaThreshold via its x component", () => {
    const compiled = new FXCompilerBaseline().compile(
      tintGraph(),
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    );
    expect(JSON.stringify(compiled)).toContain("p_fx_tint");
    expect(compiled.outputs["alphaThreshold"]).toBeDefined();
  });

  it("fails to compile against a target lacking the attribute input", () => {
    expect(() => new FXCompilerBaseline().compile(tintGraph(), buildParticleTarget([]))).toThrow();
  });
});

describe("custom-attribute-split: editor path (name + type only, no explicit stage)", () => {
  it("validates and compiles a float attribute's x component into a vertex slot", () => {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // Exactly what the editor's attribute picker produces: name + type, no stage.
        ["spin", reg.create("custom-attribute-split", { name: "spin", type: "float" })],
        ["compose", reg.create("compose-transform", {})],
        ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "spin", socketKey: "x" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    const target = buildParticleTarget([{ name: "spin", type: FLOAT }]);
    const result = new FXCompilerBaseline().validate(graph, target);
    expect(result.ok).toBe(true);

    const compiled = new FXCompilerBaseline().compile(graph, target);
    expect(compiled.vertex.body.join("\n")).toContain("p_fx_spin");
    expect(compiled.fragment.body.join("\n")).not.toContain("p_fx_spin");
  });

  it("compiles a vec3 attribute split into x/y/z, wired into position via combine", () => {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["vel", reg.create("custom-attribute-split", { name: "velocity", type: "vec3" })],
        ["combine", reg.create("combine", { type: "vec3" })],
        ["compose", reg.create("compose-transform", {})],
        ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        { from: { nodeId: "vel", socketKey: "x" }, to: { nodeId: "combine", socketKey: "x" } },
        { from: { nodeId: "vel", socketKey: "y" }, to: { nodeId: "combine", socketKey: "y" } },
        { from: { nodeId: "vel", socketKey: "z" }, to: { nodeId: "combine", socketKey: "z" } },
        {
          from: { nodeId: "combine", socketKey: "out" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    const target = buildParticleTarget([{ name: "velocity", type: VEC3 }]);
    const compiled = new FXCompilerBaseline().compile(graph, target);
    expect(compiled.vertex.body.join("\n")).toContain("p_fx_velocity");
  });
});
