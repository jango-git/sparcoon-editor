import { describe, expect, it } from "vitest";
import { FX_MANUAL_NODE_METAS } from "../../src/engine/nodes-std/manualNodeMetas";
import { fullBehaviorRegistry, fullRenderRegistry } from "../helpers/stdRegistry";

// The whole point of the registrars: a host merges FX_MANUAL_NODE_METAS into its palette
// and registers these - no hand-written per-type factory map. None of the surviving
// manual render nodes own a `three` resource (custom-attribute reads a varying,
// builtin-attribute reads a target input directly, timeline-value is a value uniform,
// texture binds an external sampler by name), so they register with no host resolver.
describe("manual node factory registrars", () => {
  it("registers the manual nodes with no host resolver", () => {
    const render = fullRenderRegistry();
    for (const type of [
      "custom-attribute",
      "custom-attribute-split",
      "builtin-attribute",
      "timeline-value",
      "texture",
    ]) {
      expect(render.has(type)).toBe(true);
    }
    const behavior = fullBehaviorRegistry();
    for (const type of [
      "custom-attribute",
      "custom-attribute-split",
      "builtin-attribute",
      "store-attribute",
      "timeline-value",
    ]) {
      expect(behavior.has(type)).toBe(true);
    }
  });

  it("makes every required attribute-name customParam actually required", () => {
    const metaByType = new Map(FX_MANUAL_NODE_METAS.map((m) => [m.type, m]));
    // custom-attribute (render) and store-attribute (behavior) declare name as a required
    // attribute-name customParam; the factory must reject a missing name.
    const render = fullRenderRegistry();
    const behavior = fullBehaviorRegistry();
    for (const type of ["custom-attribute", "store-attribute"]) {
      const meta = metaByType.get(type);
      const custom = meta?.customParams?.find((c) => c.kind === "attribute-name");
      expect(custom?.required).toBe(true);
      const create = (): unknown =>
        type === "custom-attribute"
          ? render.create(type, { name: "bad-name", type: "vec4" })
          : behavior.create(type, { name: "bad-name", type: "vec4" });
      expect(create).toThrow();
    }
  });
});

describe("custom-attribute factory strictness", () => {
  it("rejects a missing name rather than minting an fx_undefined buffer", () => {
    const reg = fullRenderRegistry();
    expect(() => reg.create("custom-attribute", { type: "vec4" })).toThrow();
  });

  it("rejects a malformed stage rather than silently coercing to fragment", () => {
    const reg = fullRenderRegistry();
    expect(() =>
      reg.create("custom-attribute", { name: "tint", type: "vec4", stage: "Vertex" }),
    ).toThrow();
    expect(() =>
      reg.create("custom-attribute", { name: "tint", type: "vec4", stage: 42 }),
    ).toThrow();
  });

  it("accepts the documented stages (and an absent stage defaults to fragment)", () => {
    const reg = fullRenderRegistry();
    expect(() =>
      reg.create("custom-attribute", { name: "tint", type: "vec4", stage: "vertex" }),
    ).not.toThrow();
    expect(() =>
      reg.create("custom-attribute", { name: "tint", type: "vec4", stage: "fragment" }),
    ).not.toThrow();
    expect(() => reg.create("custom-attribute", { name: "tint", type: "vec4" })).not.toThrow();
  });
});

describe("behavior manual-node phase strictness", () => {
  it("rejects a malformed phase rather than silently defaulting", () => {
    const reg = fullBehaviorRegistry();
    for (const type of ["store-attribute", "custom-attribute"]) {
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "Spawn" })).toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: 42 })).toThrow();
    }
  });

  it("accepts the documented phases (and an absent phase keeps the per-node default)", () => {
    const reg = fullBehaviorRegistry();
    for (const type of ["store-attribute", "custom-attribute"]) {
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "spawn" })).not.toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4", phase: "update" })).not.toThrow();
      expect(() => reg.create(type, { name: "tint", type: "vec4" })).not.toThrow();
    }
  });
});

describe("builtin-attribute factory (no params, no attribute-name customParam)", () => {
  it("creates successfully with no parameters at all, on both backends", () => {
    expect(() => fullRenderRegistry().create("builtin-attribute", {})).not.toThrow();
    expect(() => fullRenderRegistry().create("builtin-attribute", undefined)).not.toThrow();
    expect(() => fullBehaviorRegistry().create("builtin-attribute", {})).not.toThrow();
  });

  it("declares no attribute-name customParam - it is never driven by a name picker", () => {
    const metaByType = new Map(FX_MANUAL_NODE_METAS.map((m) => [m.type, m]));
    const meta = metaByType.get("builtin-attribute");
    expect(meta?.customParams?.some((c) => c.kind === "attribute-name")).toBeFalsy();
  });
});
