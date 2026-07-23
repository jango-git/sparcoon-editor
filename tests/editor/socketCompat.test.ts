import { describe, expect, it } from "vitest";
import {
  acceptedGenericTypesForMeta,
  inputAcceptsSource,
  socketsCompatible,
  typesConnectable,
} from "../../src/ui/graph/socketCompat";
import type { SocketRef } from "../../src/ui/graph/nodeView";
import { GraphKind, metaFor } from "../../src/domain/nodePalette";

const VECTORS_AND_MATS = ["vec2", "vec3", "vec4", "mat2", "mat3", "mat4"];

function metaOf(type: string) {
  const meta = metaFor(GraphKind.Render, type);
  if (meta === undefined) {
    throw new Error(`missing meta for ${type}`);
  }
  return meta;
}

describe("typesConnectable (concrete-type rule)", () => {
  it("connects any numeric width to any other (coerceNumeric pads/truncates/splats)", () => {
    expect(typesConnectable("float", "vec3")).toBe(true);
    expect(typesConnectable("vec4", "vec2")).toBe(true);
    expect(typesConnectable("vec3", "vec3")).toBe(true);
  });
  it("requires an exact match for matrices / opaque types (no numeric interconvert)", () => {
    expect(typesConnectable("mat3", "mat3")).toBe(true);
    expect(typesConnectable("mat3", "vec3")).toBe(false);
    expect(typesConnectable("mat3", "mat4")).toBe(false);
    expect(typesConnectable("sampler2D", "vec4")).toBe(false);
  });
});

describe("inputAcceptsSource (constraint-aware)", () => {
  const NUMERIC = ["float", "vec2", "vec3", "vec4"];
  const VECTORS = ["vec2", "vec3", "vec4"];
  const MATRICES = ["mat2", "mat3", "mat4"];

  it("a concrete input coerces numerically, ignoring the accepted set", () => {
    expect(inputAcceptsSource("float", "vec3", undefined)).toBe(true);
    expect(inputAcceptsSource("mat3", "vec3", undefined)).toBe(false);
  });

  it("rejects a float into a vector-only generic input (the split bug)", () => {
    expect(inputAcceptsSource("float", "T", VECTORS)).toBe(false);
    expect(inputAcceptsSource("float", "T", VECTORS_AND_MATS)).toBe(false);
  });

  it("accepts a vector / matrix into a generic input that lists it", () => {
    expect(inputAcceptsSource("vec3", "T", VECTORS)).toBe(true);
    expect(inputAcceptsSource("mat3", "T", VECTORS_AND_MATS)).toBe(true);
    expect(inputAcceptsSource("float", "T", NUMERIC)).toBe(true);
  });

  it("rejects cross-family drops (vec into matrix-only, matrix into numeric-only)", () => {
    expect(inputAcceptsSource("vec3", "T", MATRICES)).toBe(false);
    expect(inputAcceptsSource("mat3", "T", NUMERIC)).toBe(false);
    expect(inputAcceptsSource("sampler2D", "T", NUMERIC)).toBe(false);
  });

  it("stays permissive for a pass-through (any) or an unresolvable node (undefined)", () => {
    expect(inputAcceptsSource("mat3", "T", "any")).toBe(true);
    expect(inputAcceptsSource("float", "T", "any")).toBe(true);
    expect(inputAcceptsSource("mat3", "T", undefined)).toBe(true);
  });
});

describe("acceptedGenericTypesForMeta", () => {
  it("returns the family options for a facade (split/combine include matrices)", () => {
    expect(acceptedGenericTypesForMeta(metaOf("split"))).toEqual(VECTORS_AND_MATS);
    expect(acceptedGenericTypesForMeta(metaOf("combine"))).toEqual(VECTORS_AND_MATS);
  });
  it("returns the engine constraint for an ordinary generic node", () => {
    expect(acceptedGenericTypesForMeta(metaOf("binary-op"))).toEqual([
      "float",
      "vec2",
      "vec3",
      "vec4",
    ]);
    expect(acceptedGenericTypesForMeta(metaOf("transpose"))).toEqual(["mat2", "mat3", "mat4"]);
  });
  it("returns undefined for a non-generic node", () => {
    expect(acceptedGenericTypesForMeta(metaOf("world-matrix"))).toBeUndefined();
  });
});

describe("socketsCompatible (side/node + accepted set)", () => {
  const ref = (
    nodeId: string,
    socketKey: string,
    side: "input" | "output",
    type: string,
  ): SocketRef => ({
    nodeId,
    socketKey,
    side,
    type,
  });

  it("rejects same-side or same-node wiring", () => {
    expect(
      socketsCompatible(ref("a", "out", "output", "vec3"), ref("b", "out2", "output", "vec3")),
    ).toBe(false);
    expect(
      socketsCompatible(ref("a", "out", "output", "vec3"), ref("a", "in", "input", "vec3")),
    ).toBe(false);
  });

  it("gates a generic input by its accepted set (either drag direction)", () => {
    const floatOut = ref("p", "out", "output", "float");
    const splitIn = ref("s", "v", "input", "T");
    expect(socketsCompatible(floatOut, splitIn, VECTORS_AND_MATS)).toBe(false); // float -> split.v rejected
    expect(socketsCompatible(splitIn, floatOut, VECTORS_AND_MATS)).toBe(false); // reversed drag, same verdict
    const vec3Out = ref("p", "out", "output", "vec3");
    expect(socketsCompatible(vec3Out, splitIn, VECTORS_AND_MATS)).toBe(true); // vec3 -> split.v accepted
  });
});
