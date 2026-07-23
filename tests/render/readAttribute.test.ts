import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXRenderNodeReadAttribute } from "../../src/engine/render/nodes/FXRenderNodeReadAttribute";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { renderRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;
const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

/** A render graph whose albedo is a per-particle `tint` attribute. */
function tintGraph(): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([["tint", new FXRenderNodeReadAttribute("tint", VEC4)]]),
    connections: [],
    outputBindings: [{ slot: "albedo", from: { nodeId: "tint", socketKey: "value" } }],
  });
  return graph;
}

describe("read-attribute render node (step 5.4)", () => {
  it("declares its attribute request and reads the p_fx_<name> varying", () => {
    const node = new FXRenderNodeReadAttribute("tint", VEC4);
    expect(node.attributeRequest).toEqual({ name: "tint", type: VEC4 });
    expect(node.stage).toBe(FXShaderStage.FRAGMENT); // nominal fallback
    expect(node.stageFlexible).toBe(true); // effective stage is inferred
    expect(node.cacheKey()).toBe("tint:vec4");
  });

  it("keeps name/type structural but treats stage as inferred, not structural", () => {
    const node = new FXRenderNodeReadAttribute("tint", VEC4); // fragment is only a nominal default

    // Re-applying the current name/type (what every same-id snapshot carries) is fine.
    expect(() => node.applyParams({ name: "tint", type: "vec4" })).not.toThrow();

    // `stage` is inferred by the compiler (the node is stage-flexible), so an in-place stage
    // value is tolerated - both directions - and never forces a re-mint...
    expect(() => node.applyParams({ stage: "vertex" })).not.toThrow();
    expect(() => node.applyParams({ stage: "fragment" })).not.toThrow();
    // ...but a malformed stage still fails loudly (audit-4 N5), and name/type stay structural
    // (the editor re-types/re-names by emitting a fresh node id).
    expect(() => node.applyParams({ stage: "geometry" })).toThrow(/"stage" must be/);
    expect(() => node.applyParams({ type: "vec3" })).toThrow(/structural param "type"/);
    expect(() => node.applyParams({ name: "other" })).toThrow(/structural param "name"/);

    // `stage` is out of the cache key now (inferred -> folded via stageTag), so two reads of the
    // same attribute share a key regardless of where the compiler places them.
    expect(node.cacheKey()).toBe("tint:vec4");
    expect(new FXRenderNodeReadAttribute("tint", VEC4, FXShaderStage.VERTEX).cacheKey()).toBe(
      "tint:vec4",
    );
  });

  it("compiles into GLSL that samples p_fx_tint for albedo", () => {
    const compiled = new FXCompilerBaseline().compile(
      tintGraph(),
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    );
    // The attribute rides through the p_fx_tint varying into the fragment.
    expect(JSON.stringify(compiled)).toContain("p_fx_tint");
    expect(compiled.outputs["albedo"]).toBeDefined();
  });

  it("fails to compile against a target lacking the attribute input", () => {
    expect(() => new FXCompilerBaseline().compile(tintGraph(), buildParticleTarget([]))).toThrow();
  });
});

describe("read-attribute reads core builtins in render (position/age/lifetime)", () => {
  it("resolves a builtin to its PARTICLE_* input with a fixed type and no buffer request", () => {
    // The `type` arg is ignored for a builtin - its type is authoritative from the registry.
    const pos = new FXRenderNodeReadAttribute("position", VEC4);
    expect(pos.attributeRequest).toBeUndefined();
    expect(pos.outputs[0].type).toBe(VEC3);
    expect(pos.targetReads).toEqual(["PARTICLE_POSITION"]);
    expect(pos.cacheKey()).toBe("position:vec3");

    const age = new FXRenderNodeReadAttribute("age", VEC4);
    expect(age.attributeRequest).toBeUndefined();
    expect(age.outputs[0].type).toBe(FLOAT);
    expect(age.targetReads).toEqual(["PARTICLE_AGE"]);
  });

  it("compiles a position read against the plain target (no buffer), reading PARTICLE_POSITION", () => {
    const rr = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["pos", new FXRenderNodeReadAttribute("position", VEC4, FXShaderStage.VERTEX)],
        ["compose", rr.create("compose-transform", {})],
        ["col", rr.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "pos", socketKey: "value" },
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
    // removed: `new FXGraphUnlitMaterial(graph).attributeRequests` (dead material) - the empty
    // attribute set is now proven by compiling against `buildParticleTarget([])` below.
    const compiled = new FXCompilerBaseline().compile(graph, buildParticleTarget([]));
    const json = JSON.stringify(compiled);
    expect(json).toContain("PARTICLE_POSITION");
    expect(json).not.toContain("p_fx_position");
  });
});

describe("read-attribute request set surfaces in the compiled shader (step 5.4)", () => {
  it("carries exactly the requested attribute (p_fx_tint) into the fragment and binds albedo", () => {
    // Was: `new FXGraphUnlitMaterial(tintGraph()).attributeRequests` equalled `[{ name: "tint",
    // type: vec4 }]` and `prepare()` did not throw (the material derived its own attr-aware
    // target and compiled). Here we compile against that target directly and read the request
    // set straight off the compiled IR.
    const compiled = new FXCompilerBaseline().compile(
      tintGraph(),
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    );
    // The tint attribute rides its p_fx_tint varying into the fragment (the albedo tint).
    expect(compiled.fragment.body.join("\n")).toContain("p_fx_tint");
    expect(compiled.outputs["albedo"]).toBeDefined();
    // Exactly `tint` is requested - no other p_fx_<name> attribute is pulled into the IR.
    const attributeVaryings = new Set(
      [...JSON.stringify(compiled).matchAll(/p_fx_(\w+)/g)].map((match) => match[1]),
    );
    expect(attributeVaryings).toEqual(new Set(["tint"]));
    // removed: `material.prepare()`/`material.destroy()` were dead-material lifecycle with no
    // compiled-IR equivalent - the successful compile above is the live stand-in.
  });

  it("prunes an unreachable read-attribute: not requested, never enters the IR", () => {
    const registry = renderRegistry();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // No path from this read to an output slot -> unreachable -> not requested.
        ["tint", new FXRenderNodeReadAttribute("tint", VEC4)],
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

describe("read-attribute drives a vertex output slot (editor path, stage inferred)", () => {
  // The editor never sets `stage` (it is hidden as inferred) and the attribute picker recreates
  // the node with only `{ name, type }`. Before stage inference this pinned the read to the
  // fragment stage, so wiring it to a vertex slot (a transform slot, via compose-transform)
  // failed with `stage-direction-mismatch`. Now the node is stage-flexible, so the compiler
  // places it in the vertex stage to satisfy the slot - the attribute reaches the vertex program.

  /** A registry with the standard render nodes plus the manual ones (read-attribute). */
  function renderReg() {
    const registry = renderRegistry();
    registerManualRenderNodes(registry);
    return registry;
  }

  /** `read-attribute(spin) -> compose-transform -> particleTransform` (VERTEX); albedo = white. */
  function spinGraph(): FXGraph<FXRenderNode> {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // Exactly what the editor's attribute picker produces: name + type, no stage.
        ["spin", reg.create("read-attribute", { name: "spin", type: "float" })],
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

  it("still places the same read in the fragment stage when it tints albedo", () => {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["tint", reg.create("read-attribute", { name: "tint", type: "vec4" })],
      ]),
      connections: [],
      outputBindings: [{ slot: "albedo", from: { nodeId: "tint", socketKey: "value" } }],
    });
    const compiled = new FXCompilerBaseline().compile(
      graph,
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    );
    // Fragment placement for an albedo tint - inference did not gratuitously promote it.
    expect(compiled.fragment.body.join("\n")).toContain("p_fx_tint");
    expect(compiled.vertex.body.join("\n")).not.toContain("p_fx_tint");
  });
});
