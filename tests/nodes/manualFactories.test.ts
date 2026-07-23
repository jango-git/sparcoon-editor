import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import { FX_MANUAL_NODE_METAS } from "../../src/engine/nodes-std/manualNodeMetas";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";

// The whole point of the registrars: a host merges FX_MANUAL_NODE_METAS into its palette
// and registers these - no hand-written per-type factory map (M3). None of the surviving
// manual render nodes own a `three` resource (read-attribute reads a varying, timeline-value is
// a value uniform, texture binds an external sampler by name), so they register with no
// host resolver.
function renderReg(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  registerManualRenderNodes(r);
  return r;
}

function behaviorReg(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  registerManualBehaviorNodes(r);
  return r;
}

describe("manual node factory registrars (M3)", () => {
  it("registers the manual nodes with no host resolver", () => {
    const render = renderReg();
    for (const type of ["read-attribute", "timeline-value", "texture"]) {
      expect(render.has(type)).toBe(true);
    }
    const behavior = behaviorReg();
    for (const type of ["read-attribute", "store-attribute", "timeline-value"]) {
      expect(behavior.has(type)).toBe(true);
    }
  });

  it("makes every required attribute-name customParam actually required", () => {
    const metaByType = new Map(FX_MANUAL_NODE_METAS.map((m) => [m.type, m]));
    // read-attribute (render) and store-attribute (behavior) declare name as a required
    // attribute-name customParam; the factory must reject a missing name.
    const render = renderReg();
    const behavior = behaviorReg();
    for (const type of ["read-attribute", "store-attribute"]) {
      const meta = metaByType.get(type);
      const custom = meta?.customParams?.find((c) => c.kind === "attribute-name");
      expect(custom?.required).toBe(true);
      const reg =
        type === "read-attribute" ? render : (behavior as unknown as FXNodeRegistry<FXRenderNode>);
      expect(() => reg.create(type, { name: "1bad", type: "vec4" })).toThrow();
    }
  });
});

describe("read-attribute factory strictness (audit-4 N5)", () => {
  it("rejects a missing name rather than minting an fx_undefined buffer", () => {
    const reg = renderReg();
    expect(() => reg.create("read-attribute", { type: "vec4" })).toThrow();
  });

  it("rejects a malformed stage rather than silently coercing to fragment", () => {
    const reg = renderReg();
    expect(() =>
      reg.create("read-attribute", { name: "tint", type: "vec4", stage: "Vertex" }),
    ).toThrow();
    expect(() => reg.create("read-attribute", { name: "tint", type: "vec4", stage: 42 })).toThrow();
  });

  it("accepts the documented stages (and an absent stage defaults to fragment)", () => {
    const reg = renderReg();
    expect(() =>
      reg.create("read-attribute", { name: "tint", type: "vec4", stage: "vertex" }),
    ).not.toThrow();
    expect(() =>
      reg.create("read-attribute", { name: "tint", type: "vec4", stage: "fragment" }),
    ).not.toThrow();
    expect(() => reg.create("read-attribute", { name: "tint", type: "vec4" })).not.toThrow();
  });
});

describe("behavior manual-node phase strictness (audit-4 N5)", () => {
  it("rejects a malformed phase rather than silently defaulting", () => {
    const reg = behaviorReg();
    for (const type of ["store-attribute", "read-attribute"]) {
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "Spawn" })).toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: 42 })).toThrow();
    }
  });

  it("accepts the documented phases (and an absent phase keeps the per-node default)", () => {
    const reg = behaviorReg();
    for (const type of ["store-attribute", "read-attribute"]) {
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "spawn" })).not.toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "update" })).not.toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4" })).not.toThrow();
    }
  });
});
