import { describe, expect, it } from "vitest";

import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { FXRenderNodeBuiltinAttribute } from "../../src/engine/render/nodes/FXRenderNodeBuiltinAttribute";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;
const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

/** A render graph whose albedo is a per-particle `tint` attribute. */
function tintGraph(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([["tint", new FXRenderNodeCustomAttribute("tint", VEC4)]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "tint", socketKey: "value" } }],
  });
  return graph;
}

/** A render graph whose alpha threshold is the `x` component of a per-particle `tint` attribute;
 *  albedo is a plain white constant so the graph has its required albedo binding too. */
function tintSplitGraph(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["tint", new FXRenderNodeCustomAttributeSplit("tint", VEC4)],
      ["col", renderRegistry().create("constant", { type: "color", value: [1, 1, 1, 1] })],
    ]),
    connections: [],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      { slot: "alphaThreshold", from: { nodeId: "tint", socketKey: "x" } },
    ],
  });
  return graph;
}

describe.each([
  {
    node: "custom-attribute",
    create: (stage?: FXShaderStage) => new FXRenderNodeCustomAttribute("tint", VEC4, stage),
    graph: tintGraph,
    slot: "albedo",
  },
  {
    node: "custom-attribute-split",
    create: (stage?: FXShaderStage) => new FXRenderNodeCustomAttributeSplit("tint", VEC4, stage),
    graph: tintSplitGraph,
    slot: "alphaThreshold",
  },
])("$node render node", ({ create, graph, slot }) => {
  it("declares its attribute request and reads the p_fx_<name> varying", () => {
    const node = create();
    expect(node.attributeRequest).toEqual({ name: "tint", type: VEC4 });
    expect(node.stage).toBe(FXShaderStage.FRAGMENT); // nominal fallback
    expect(node.stageFlexible).toBe(true); // effective stage is inferred
    expect(node.cacheKey()).toBe("tint:vec4");
  });

  it("keeps name/type structural but treats stage as inferred, not structural", () => {
    const node = create(); // fragment is only a nominal default

    // Re-applying the current name/type (what every same-id snapshot carries) is fine.
    expect(() => node.applyParams({ name: "tint", type: "vec4" })).not.toThrow();

    // `stage` is inferred by the compiler (the node is stage-flexible), so an in-place stage
    // value is tolerated - both directions - and never forces a re-mint...
    expect(() => node.applyParams({ stage: "vertex" })).not.toThrow();
    expect(() => node.applyParams({ stage: "fragment" })).not.toThrow();
    // ...but a malformed stage fails loudly, and name/type stay structural (the editor
    // re-types/re-names by emitting a fresh node id).
    expect(() => node.applyParams({ stage: "geometry" })).toThrow(/"stage" must be/);
    expect(() => node.applyParams({ type: "vec3" })).toThrow(/structural param "type"/);
    expect(() => node.applyParams({ name: "other" })).toThrow(/structural param "name"/);

    // `stage` is not in the cache key (it is inferred, folded via stageTag), so two reads of the
    // same attribute share a key regardless of where the compiler places them.
    expect(node.cacheKey()).toBe("tint:vec4");
    expect(create(FXShaderStage.VERTEX).cacheKey()).toBe("tint:vec4");
  });

  it(`carries exactly the requested p_fx_tint into the fragment and binds ${slot}`, () => {
    const compiled = new FXCompilerBaseline().compile(
      graph(),
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    );
    // The attribute rides its p_fx_tint varying into the fragment; a fragment-slot read stays
    // there, never promoted to the vertex stage.
    expect(compiled.fragment.body.join("\n")).toContain("p_fx_tint");
    expect(compiled.vertex.body.join("\n")).not.toContain("p_fx_tint");
    expect(compiled.outputs[slot]).toBeDefined();
    // Exactly `tint` is requested - no other p_fx_<name> attribute is pulled into the IR.
    const attributeVaryings = new Set(
      [...JSON.stringify(compiled).matchAll(/p_fx_(\w+)/g)].map((match) => match[1]),
    );
    expect(attributeVaryings).toEqual(new Set(["tint"]));
  });

  it("fails to compile against a target lacking the attribute input", () => {
    expect(() => new FXCompilerBaseline().compile(graph(), buildParticleTarget([]))).toThrow();
  });
});

describe("builtin-attribute reads all four host builtins in render", () => {
  it("exposes position/age/lifetime/id with fixed types and no buffer request", () => {
    const node = new FXRenderNodeBuiltinAttribute();
    expect(node.attributeRequest).toBeUndefined();
    expect(node.outputs.map((socket) => socket.key)).toEqual(["position", "age", "lifetime", "id"]);
    expect(node.outputs[0]?.type).toBe(VEC3);
    expect(node.outputs[1]?.type).toBe(FLOAT);
    expect(node.outputs[2]?.type).toBe(FLOAT);
    expect(node.outputs[3]?.type).toBe(FLOAT);
    expect(node.targetReads).toEqual([
      "PARTICLE_POSITION",
      "PARTICLE_AGE",
      "PARTICLE_LIFETIME",
      "PARTICLE_ID",
    ]);
  });

  it("compiles a position read against the plain target (no buffer), reading PARTICLE_POSITION", () => {
    const rr = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["pos", new FXRenderNodeBuiltinAttribute()],
        ["compose", rr.create("compose-transform", {})],
        ["col", rr.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "pos", socketKey: "position" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    // The builtin rides the core `p_position` varying, so it needs no `a_fx_position` buffer:
    // the graph compiles against the attribute-free target and its IR reads PARTICLE_POSITION,
    // never the `p_fx_position` attribute varying.
    const compiled = new FXCompilerBaseline().compile(graph, buildParticleTarget([]));
    const json = JSON.stringify(compiled);
    expect(json).toContain("PARTICLE_POSITION");
    expect(json).not.toContain("p_fx_position");
  });
});

describe("custom-attribute request set", () => {
  it("prunes an unreachable custom-attribute: not requested, never enters the IR", () => {
    const registry = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // No path from this read to an output slot -> unreachable -> not requested.
        ["tint", new FXRenderNodeCustomAttribute("tint", VEC4)],
        ["col", registry.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "col", socketKey: "out" } }],
    });
    // The attribute-free target declares no p_fx_<name> input; the unreachable read is pruned,
    // so the graph compiles against it and its varying never appears in the compiled IR.
    const compiled = new FXCompilerBaseline().compile(graph, buildParticleTarget([]));
    expect(JSON.stringify(compiled)).not.toContain("p_fx_tint");
  });
});

describe("custom-attribute drives a vertex output slot (editor path, stage inferred)", () => {
  // The editor never sets `stage` (it is hidden as inferred) and the attribute picker recreates
  // the node with only `{ name, type }`. The node is stage-flexible, so wired to a vertex slot (a
  // transform slot, via compose-transform) the compiler places it in the vertex stage - the
  // attribute reaches the vertex program instead of failing with `stage-direction-mismatch`.

  /** A registry with the standard render nodes plus the manual ones (custom-attribute). */
  function renderReg() {
    const registry = renderRegistry();
    registerManualRenderNodes(registry);
    return registry;
  }

  /** `custom-attribute(spin) -> compose-transform -> particleTransform` (VERTEX); albedo = white. */
  function spinGraph(): FXGraph<FXRenderNode> {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // Exactly what the editor's attribute picker produces: name + type, no stage.
        ["spin", reg.create("custom-attribute", { name: "spin", type: "float" })],
        ["compose", reg.create("compose-transform", {})],
        ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "spin", socketKey: "value" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    return graph;
  }

  it("validates and compiles the attribute into the vertex transform slot", () => {
    const target = buildParticleTarget([{ name: "spin", type: FLOAT }]);

    const result = new FXCompilerBaseline().validate(spinGraph(), target);
    expect(result.ok).toBe(true); // no stage-direction-mismatch

    const compiled = new FXCompilerBaseline().compile(spinGraph(), target);
    expect(compiled.outputs["particleTransform"]).toBeDefined();
    // The attribute read landed in the *vertex* program (particleTransform is vertex-stage).
    expect(compiled.vertex.body.join("\n")).toContain("p_fx_spin");
    expect(compiled.fragment.body.join("\n")).not.toContain("p_fx_spin");
  });
});
