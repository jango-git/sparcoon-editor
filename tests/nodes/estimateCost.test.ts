import { describe, expect, it } from "vitest";
import type { FXNodeDefinition } from "../../src/engine/core/nodes/defineNode";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import { FX_MANUAL_NODE_METAS } from "../../src/engine/nodes-std/manualNodeMetas";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";

function backendOf(def: FXNodeDefinition): "render" | "behavior" {
  return def.domain === "render" ? "render" : "behavior";
}

describe("node cost estimate (FXGraphNode.estimateCost / FXNodeMeta.cost)", () => {
  it("every standard node describes a finite, non-negative baseline cost", () => {
    for (const def of FX_STANDARD_NODES) {
      const cost = def.describe().cost;
      expect(cost, `${def.type} has no cost`).toBeTypeOf("number");
      expect(Number.isFinite(cost), `${def.type}.cost is not finite`).toBe(true);
      expect(cost! >= 0, `${def.type}.cost is negative`).toBe(true);
    }
  });

  it("every standard node instance estimates a finite, non-negative cost at every type its own constraint allows", () => {
    for (const def of FX_STANDARD_NODES) {
      const node = def.createInstance(backendOf(def));
      const constraint = def.describe().generic?.constraint;
      // A non-generic node ignores resolvedT (float is a harmless probe); a generic node's `T`
      // can only ever resolve within its own constraint - never query it outside that (e.g.
      // `noise` never resolves to `float`), matching what real graph resolution would produce.
      const types = (constraint ?? ["float"]).map((id) => FX_VALUE_TYPES[id]);
      for (const type of types) {
        const cost = node.estimateCost?.(type);
        expect(cost, `${def.type}.estimateCost(${type.id})`).toBeTypeOf("number");
        expect(Number.isFinite(cost), `${def.type}.estimateCost(${type.id}) is not finite`).toBe(
          true,
        );
        expect(cost! >= 0, `${def.type}.estimateCost(${type.id}) is negative`).toBe(true);
      }
    }
  });

  it("every manual node meta describes a finite, non-negative baseline cost", () => {
    for (const meta of FX_MANUAL_NODE_METAS) {
      expect(meta.cost, `${meta.type} has no cost`).toBeTypeOf("number");
      expect(Number.isFinite(meta.cost), `${meta.type}.cost is not finite`).toBe(true);
      expect(meta.cost! >= 0, `${meta.type}.cost is negative`).toBe(true);
    }
  });

  function def(type: string): FXNodeDefinition {
    const found = FX_STANDARD_NODES.find((d) => d.type === type);
    if (found === undefined) {
      throw new Error(`no descriptor "${type}"`);
    }
    return found;
  }

  it("constant(float) costs 0 - a compile-time literal, no runtime op", () => {
    const node = def("constant").createInstance("behavior", { type: "float" });
    expect(node.estimateCost?.(FX_VALUE_TYPES.float)).toBe(0);
    expect(def("constant").describe().cost).toBe(0);
  });

  it("binary-op 'add' on float costs 1 - one scalar ALU op", () => {
    const node = def("binary-op").createInstance("behavior", { op: "add" });
    expect(node.estimateCost?.(FX_VALUE_TYPES.float)).toBe(1);
    // The palette baseline is evaluated at the same (narrowest, float) case.
    expect(def("binary-op").describe().cost).toBe(1);
  });

  it("binary-op 'add' scales with the resolved width - vec3 costs 3x float", () => {
    const node = def("binary-op").createInstance("behavior", { op: "add" });
    expect(node.estimateCost?.(FX_VALUE_TYPES.vec3)).toBe(3);
    expect(node.estimateCost?.(FX_VALUE_TYPES.vec4)).toBe(4);
  });

  it("binary-op cost varies by the chosen operation, not just width", () => {
    const add = def("binary-op").createInstance("behavior", { op: "add" });
    const power = def("binary-op").createInstance("behavior", { op: "power" });
    const cross = def("binary-op").createInstance("behavior", { op: "cross" });
    expect(power.estimateCost?.(FX_VALUE_TYPES.float)).toBeGreaterThan(
      add.estimateCost?.(FX_VALUE_TYPES.float) ?? 0,
    );
    // cross is a fixed vec3-shaped cost, independent of the (matched) resolved width.
    expect(cross.estimateCost?.(FX_VALUE_TYPES.vec3)).toBe(9);
  });

  it("add-scaled-vector (a + b*scale) costs 2 per component - a multiply + an add", () => {
    const node = def("add-scaled-vector").createInstance("behavior");
    expect(node.estimateCost?.(FX_VALUE_TYPES.vec3)).toBe(6);
  });

  it("a node with no generic socket ignores the resolvedT argument", () => {
    const node = def("drag").createInstance("behavior");
    const atFloat = node.estimateCost?.(FX_VALUE_TYPES.float);
    const atVec4 = node.estimateCost?.(FX_VALUE_TYPES.vec4);
    expect(atFloat).toBe(atVec4);
  });

  it("noise cost scales with the octave count (a value visible on the params bag)", () => {
    const one = def("noise").createInstance("behavior", { octaves: "1" });
    const six = def("noise").createInstance("behavior", { octaves: "6" });
    expect(six.estimateCost?.(FX_VALUE_TYPES.vec3)).toBeGreaterThan(
      one.estimateCost?.(FX_VALUE_TYPES.vec3) ?? 0,
    );
  });

  it("matrix inverse cost grows with matrix dimension (mat2 < mat3 < mat4)", () => {
    const node = def("inverse").createInstance("render");
    const mat2 = node.estimateCost?.(FX_VALUE_TYPES.mat2) ?? 0;
    const mat3 = node.estimateCost?.(FX_VALUE_TYPES.mat3) ?? 0;
    const mat4 = node.estimateCost?.(FX_VALUE_TYPES.mat4) ?? 0;
    expect(mat2).toBeLessThan(mat3);
    expect(mat3).toBeLessThan(mat4);
  });
});
