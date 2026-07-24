import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { defineNode } from "../../src/engine/core/nodes/defineNode";
import { lit, litVec } from "../../src/engine/core/ir/FXExprBuilder";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleUpdateKernel,
  compileBehavior,
  previewBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

// velocity is a user attribute now: the node reads it via custom-attribute, and its
// result is persisted via store-attribute bound to `attr:velocity` (asserted on the
// stride-3 `velocity` buffer, y at offset 1).
const OFF_VELOCITY_Y = 1;
const VEC3 = FX_VALUE_TYPES.vec3;
const velocityTargets = buildParticleBehaviorTargets([{ name: "velocity", type: VEC3 }]);

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** Fresh per-particle state buffers (one particle) for the velocity-attribute targets. */
function freshBuffers(): Record<string, Float32Array> {
  return {
    position: new Float32Array(3),
    lifecycle: new Float32Array(2),
    velocity: new Float32Array(3),
  };
}

// A behavior node authored purely declaratively: `v += acceleration * dt`. Its velocity
// input defaults to a zero vector (velocity is no longer a target builtin).
const gravityDef = defineNode({
  type: "test-gravity",
  domain: "behavior",
  phase: "update",
  label: "Gravity",
  inputs: { velocity: { type: "vec3", default: litVec(0, 0, 0) } },
  outputs: { velocity: { type: "vec3" } },
  params: { acceleration: { kind: "value", type: "vec3", default: [0, -10, 0] } },
  cost: 6,
  build: ({ inputs, params, target, fn }) => ({
    velocity: fn.add(inputs["velocity"], fn.mul(params.acceleration, target.read("dt"))),
  }),
});

// A render node authored declaratively: a constant color exposed as a live uniform.
const colorDef = defineNode({
  type: "test-color",
  domain: "render",
  stage: "fragment",
  label: "Color",
  inputs: {},
  outputs: { color: { type: "vec4" } },
  params: { tint: { kind: "value", type: "vec4", default: [1, 0, 0, 1] } },
  cost: 0,
  build: ({ params }) => ({ color: params.tint }),
});

/** custom-attribute(velocity) -> node -> store-attribute(velocity), bound to `attr:velocity`. */
function velocityGraph(node: FXBehaviorNode): FXGraph<FXBehaviorNode> {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({
    nodes: new Map([
      ["rv", readAttr("velocity", VEC3)],
      ["g", node],
      ["sv", storeAttr("velocity", VEC3)],
    ]),
    connections: [edge("rv", "value", "g", "velocity"), edge("g", "velocity", "sv", "value")],
    outputBindings: [bind(attributeSlot("velocity"), "sv", "value")],
  });
  return graph;
}

describe("defineNode - behavior backend", () => {
  it("compiles a vec3 value param into scalar bindings and integrates v += a*dt", () => {
    const node = gravityDef.createInstance("behavior") as unknown as FXBehaviorNode;
    const graph = velocityGraph(node);

    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);

    const buffers = freshBuffers();
    update(buffers, 1, 0.5, compiled.update.bindings);
    expect(buffers.velocity[OFF_VELOCITY_Y]).toBeCloseTo(-5, 6);
  });

  it("re-tunes a value param via applyParams + syncLiveValues without changing the hash", () => {
    const node = gravityDef.createInstance("behavior") as unknown as FXBehaviorNode;
    const graph = velocityGraph(node);

    const before = previewBehaviorHash(graph, velocityTargets);
    const compiled = compileBehavior(graph, velocityTargets);
    const update = buildParticleUpdateKernel(compiled);

    node.applyParams?.({ acceleration: [0, -20, 0] });
    node.syncLiveValues?.();
    const after = previewBehaviorHash(graph, velocityTargets);
    expect(after).toBe(before); // value edit is a rebind, not a recompile

    const buffers = freshBuffers();
    update(buffers, 1, 0.5, compiled.update.bindings);
    expect(buffers.velocity[OFF_VELOCITY_Y]).toBeCloseTo(-10, 6);
  });

  it("rejects a value param of the wrong shape", () => {
    expect(() => gravityDef.createInstance("behavior", { acceleration: [0, -10] })).toThrow(
      /3 finite numbers/,
    );
  });
});

describe("defineNode - render backend", () => {
  it("compiles a vec4 value param into one uniform bound to albedo", () => {
    const node = colorDef.createInstance("render") as unknown as FXRenderNode;
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([["c", node]]),
      connections: [],
      outputBindings: [bind("albedo", "c", "color")],
    });

    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();

    const uniformNames = Object.keys(shader.uniforms);
    expect(uniformNames).toHaveLength(1);
    expect(shader.uniforms[uniformNames[0]].value).toEqual([1, 0, 0, 1]);
    expect(shader.uniformDeclarations.some((d) => d.includes("vec4"))).toBe(true);
    expect(shader.fragment.body.join("\n")).toContain(uniformNames[0]);
  });
});

describe("defineNode - structural params & metadata", () => {
  const opDef = defineNode({
    type: "test-op",
    domain: "shared",
    label: "Op",
    inputs: { a: { type: "float", required: true } },
    outputs: { out: { type: "float" } },
    params: {
      op: { kind: "structural", type: "enum", options: ["neg", "abs"], default: "neg" },
      bias: { kind: "value", type: "float", default: 0 },
    },
    cost: 1,
    build: ({ inputs, params, fn }) => ({
      out: fn.add(
        params.op === "neg" ? fn.neg(inputs["a"]) : fn.call("abs", inputs["a"]),
        params.bias,
      ),
    }),
  });

  it("folds a structural param into cacheKey and keeps value params out of it", () => {
    const node = opDef.createInstance("behavior");
    const base = node.cacheKey?.();

    node.applyParams?.({ bias: 3 });
    expect(node.cacheKey?.()).toBe(base); // value edit does not move the gate

    node.applyParams?.({ op: "abs" });
    expect(node.cacheKey?.()).not.toBe(base); // structural edit does
  });

  it("describe() is JSON-serializable and carries the schema", () => {
    const meta = opDef.describe();
    expect(() => JSON.stringify(meta)).not.toThrow();
    expect(meta.type).toBe("test-op");
    expect(meta.domain).toBe("shared");
    expect(meta.params["op"]).toEqual({
      kind: "structural",
      type: "enum",
      options: ["neg", "abs"],
      default: "neg",
    });
    expect(meta.inputs).toContainEqual({
      key: "a",
      type: "float",
      label: undefined,
      required: true,
    });
  });

  it("refuses to create a render-only node for the behavior backend", () => {
    expect(() => colorDef.createInstance("behavior")).toThrow(/cannot be created/);
  });
});

describe("defineNode - descriptor-contract guards (audit-4 C4/C5/N7)", () => {
  it("C4: a required input with a default validates when unconnected", () => {
    const def = defineNode({
      type: "test-c4",
      domain: "render",
      stage: "fragment",
      label: "C4",
      inputs: { tint: { type: "vec4", required: true, default: litVec(1, 1, 1, 1) } },
      outputs: { out: { type: "vec4" } },
      params: {},
      cost: 0,
      build: ({ inputs }) => ({ out: inputs["tint"] }),
    });
    const node = def.createInstance("render") as unknown as FXRenderNode;
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map([["n", node]]),
      connections: [],
      outputBindings: [bind("albedo", "n", "out")],
    });
    const result = new FXCompilerBaseline().validate(graph, FX_PARTICLE_TARGET);
    // Without C4 the dropped default made this a spurious missing-required-input.
    expect(result.errors.some((error) => error.code === "missing-required-input")).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("C5: rejects a socket key that is not an identifier", () => {
    expect(() =>
      defineNode({
        type: "test-c5-socket",
        domain: "shared",
        label: "C5",
        inputs: { "bad key": { type: "float" } },
        outputs: { out: { type: "float" } },
        params: {},
        cost: 0,
        build: () => ({ out: lit(0) }),
      }),
    ).toThrow(/socket key/);
  });

  it("C5: cacheKey is delimiter-safe for enum options containing ':' or '='", () => {
    const def = defineNode({
      type: "test-c5-key",
      domain: "shared",
      label: "K",
      inputs: {},
      outputs: { out: { type: "float" } },
      params: {
        a: { kind: "structural", type: "enum", options: ["x", "y:z=1"], default: "x" },
        b: { kind: "structural", type: "enum", options: ["p", "q"], default: "p" },
      },
      cost: 0,
      build: () => ({ out: lit(0) }),
    });
    const n1 = def.createInstance("behavior");
    n1.applyParams?.({ a: "y:z=1", b: "p" });
    const n2 = def.createInstance("behavior");
    n2.applyParams?.({ a: "x", b: "q" });
    expect(n1.cacheKey?.()).not.toBe(n2.cacheKey?.());
    // JSON-encoded parts: a value's ':'/'=' can no longer bleed into the join.
    expect(() => JSON.parse(n1.cacheKey?.() ?? "")).not.toThrow();
  });

  it("N7: rejects a vecN value param whose default width mismatches the type", () => {
    expect(() =>
      defineNode({
        type: "test-n7",
        domain: "shared",
        label: "N7",
        inputs: {},
        outputs: { out: { type: "vec3" } },
        params: { v: { kind: "value", type: "vec3", default: [1, 2] } },
        cost: 0,
        build: ({ params }) => ({ out: params.v }),
      }),
    ).toThrow(/expected 3/);
  });
});
