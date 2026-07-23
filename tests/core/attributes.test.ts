import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import {
  collectAttributeRequests,
  collectUndeclaredAttributeErrors,
  mergeAttributeCollections,
} from "../../src/engine/core/compiler/collectAttributeRequests";
import {
  assertValidAttributeName,
  isValidAttributeName,
} from "../../src/engine/core/socket/FXAttribute";
import type { FXAttributeRequest } from "../../src/engine/core/socket/FXAttribute";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FakeNode, socket } from "../helpers/fakeNodes";

const VEC4 = FX_VALUE_TYPES.vec4;
const FLOAT = FX_VALUE_TYPES.float;

/** A FakeNode with an output `out` (so it can be bound) reserving `request`. */
function attrNode(type: string, request?: FXAttributeRequest): FakeNode {
  return new FakeNode({ type, outputs: [socket("out")], attributeRequest: request });
}

/** Builds a graph and binds `boundIds`' `out` sockets so those nodes are reachable. */
function graphWith(
  nodes: Record<string, FakeNode>,
  boundIds: readonly string[],
): FXGraph<FakeNode> {
  const graph = new FXGraph<FakeNode>();
  graph.ingest({
    nodes: new Map(Object.entries(nodes)),
    connections: [],
    outputBindings: boundIds.map((id, i) => ({
      slot: `s${i.toString()}`,
      from: { nodeId: id, socketKey: "out" },
    })),
  });
  return graph;
}

describe("attribute name validation", () => {
  it("accepts lower-camel names and rejects the rest", () => {
    expect(isValidAttributeName("tint")).toBe(true);
    expect(isValidAttributeName("spawnSeed2")).toBe(true);
    expect(isValidAttributeName("Tint")).toBe(false); // uppercase lead
    expect(isValidAttributeName("2tint")).toBe(false); // digit lead
    expect(isValidAttributeName("a_b")).toBe(false); // underscore
    expect(isValidAttributeName("")).toBe(false);
  });

  it("assertValidAttributeName throws with context on a bad name", () => {
    expect(() => assertValidAttributeName("bad name", "store-attribute.name")).toThrow(
      /store-attribute\.name/,
    );
    expect(() => assertValidAttributeName("tint", "x")).not.toThrow();
  });
});

describe("collectAttributeRequests", () => {
  it("merges duplicate same-typed requests into one, ordered by name", () => {
    const graph = graphWith(
      {
        seed: attrNode("store", { name: "seed", type: FLOAT }),
        a: attrNode("store", { name: "tint", type: VEC4 }),
        b: attrNode("read", { name: "tint", type: VEC4 }),
      },
      ["seed", "a", "b"],
    );

    const { requests, errors } = collectAttributeRequests(graph);
    expect(errors).toHaveLength(0);
    expect(requests.map((r) => r.name)).toEqual(["seed", "tint"]);
    expect(requests.map((r) => r.type.glslTypeName)).toEqual(["float", "vec4"]);
  });

  it("does not collect an unreachable node's attribute", () => {
    const graph = graphWith(
      {
        a: attrNode("store", { name: "tint", type: VEC4 }),
        ghost: attrNode("store", { name: "ghost", type: FLOAT }),
      },
      ["a"], // ghost left unbound -> unreachable
    );

    const { requests } = collectAttributeRequests(graph);
    expect(requests.map((r) => r.name)).toEqual(["tint"]);
  });

  it("reports attribute-type-conflict when one name has two types", () => {
    const graph = graphWith(
      {
        a: attrNode("store", { name: "tint", type: VEC4 }),
        c: attrNode("read", { name: "tint", type: FLOAT }),
      },
      ["a", "c"],
    );

    const { requests, errors } = collectAttributeRequests(graph);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("attribute-type-conflict");
    expect(requests).toHaveLength(1); // first-seen kept, compilation can proceed
  });

  it("ignores nodes without an attribute request", () => {
    const graph = graphWith({ plain: attrNode("noop") }, ["plain"]);
    expect(collectAttributeRequests(graph).requests).toHaveLength(0);
  });
});

describe("mergeAttributeCollections", () => {
  it("unions the two sides and flags a cross-graph type conflict", () => {
    const behavior = { requests: [{ name: "tint", type: VEC4 }], errors: [] };
    const render = { requests: [{ name: "tint", type: FLOAT }], errors: [] };

    const merged = mergeAttributeCollections(behavior, render);
    expect(merged.requests).toHaveLength(1);
    expect(merged.errors.map((e) => e.code)).toEqual(["attribute-type-conflict"]);
  });

  it("carries through per-graph errors and dedups agreeing names", () => {
    const behavior = { requests: [{ name: "tint", type: VEC4 }], errors: [] };
    const render = {
      requests: [
        { name: "tint", type: VEC4 },
        { name: "seed", type: FLOAT },
      ],
      errors: [],
    };

    const merged = mergeAttributeCollections(behavior, render);
    expect(merged.errors).toHaveLength(0);
    expect(merged.requests.map((r) => r.name)).toEqual(["seed", "tint"]);
  });
});

describe("collectUndeclaredAttributeErrors", () => {
  it("passes a request matching a declared name and type", () => {
    const declared = new Map([["tint", "vec4"]]);
    const errors = collectUndeclaredAttributeErrors([{ name: "tint", type: VEC4 }], declared);
    expect(errors).toHaveLength(0);
  });

  it("flags a request naming an attribute absent from the declared list", () => {
    // e.g. a read-attribute node left over after its declaration was removed elsewhere.
    const declared = new Map<string, string>();
    const errors = collectUndeclaredAttributeErrors([{ name: "tint", type: VEC4 }], declared);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("undeclared-attribute");
    expect(errors[0].params).toEqual({ name: "tint" });
  });

  it("flags a request whose type disagrees with the declared type", () => {
    // e.g. a read-attribute node left over after its declaration was retyped elsewhere.
    const declared = new Map([["tint", "vec4"]]);
    const errors = collectUndeclaredAttributeErrors([{ name: "tint", type: FLOAT }], declared);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("undeclared-attribute");
    expect(errors[0].params).toEqual({
      name: "tint",
      declaredType: "vec4",
      requestedType: "float",
    });
  });

  it("checks every request independently, in order", () => {
    const declared = new Map([["tint", "vec4"]]);
    const errors = collectUndeclaredAttributeErrors(
      [
        { name: "tint", type: VEC4 },
        { name: "ghost", type: FLOAT },
      ],
      declared,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].params?.["name"]).toBe("ghost");
  });
});
