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
import { glslBufferAttributeName } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { attributeInputName } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { attributeVaryingName } from "../../src/engine/render/target/FXParticleRenderTarget";
import {
  PARAM_COMPONENTS,
  paramBindingName,
  paramUniformName,
} from "../../src/engine/nodes-std/paramSupport.Internal";
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
  it("accepts letters/digits with single mid-name underscores, and rejects the rest", () => {
    expect(isValidAttributeName("tint")).toBe(true);
    expect(isValidAttributeName("spawnSeed2")).toBe(true);
    expect(isValidAttributeName("Tint")).toBe(true); // uppercase lead
    expect(isValidAttributeName("2tint")).toBe(true); // digit lead
    expect(isValidAttributeName("a_b")).toBe(true); // single mid-name underscore
    expect(isValidAttributeName("_ab")).toBe(false); // leading underscore
    expect(isValidAttributeName("ab_")).toBe(false); // trailing underscore
    expect(isValidAttributeName("a__b")).toBe(false); // doubled underscore
    expect(isValidAttributeName("a-b")).toBe(false); // hyphen
    expect(isValidAttributeName("")).toBe(false);
  });

  it("assertValidAttributeName throws with context on a bad name", () => {
    expect(() => assertValidAttributeName("bad name", "store-attribute.name")).toThrow(
      /store-attribute\.name/,
    );
    expect(() => assertValidAttributeName("tint", "x")).not.toThrow();
  });

  // Every accepted name is spliced verbatim into GLSL/JS identifiers behind a fixed prefix
  // (`in_`, `p_fx_`/`a_fx_`, `ATTR_`, `u_param_`/`b_param_`) - never validated again downstream.
  // GLSL reserves identifiers containing `__` or starting with `gl_`; the grammar's "single
  // mid-name underscore only" rule exists specifically to keep every one of those splices legal.
  it("every accepted name splices into a legal, `__`-free, non-gl_ identifier everywhere it is used", () => {
    const legalIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const candidates: string[] = [];
    const alphabet = ["a", "A", "1", "_"];
    const build = (prefix: string, depth: number): void => {
      if (depth > 0) {
        candidates.push(prefix);
      }
      if (depth === 5) {
        return;
      }
      for (const char of alphabet) {
        build(prefix + char, depth + 1);
      }
    };
    build("", 0);

    const accepted = candidates.filter((name) => isValidAttributeName(name));
    expect(accepted.length).toBeGreaterThan(50); // sanity: the sweep actually exercised the grammar

    for (const name of accepted) {
      const identifiers = [
        glslBufferAttributeName(name), // behavior GPU kernel's `in_<name>`
        attributeInputName(name), // behavior kernel's `ATTR_<name>` target input
        attributeVaryingName(name), // render varying `p_fx_<name>`
        `a_fx_${name}`, // material-adapter's mirrored BufferAttribute name convention
        paramUniformName(name), // timeline-value/texture uniform `u_param_<name>`
        ...PARAM_COMPONENTS.map((component) => `${paramBindingName(name)}_${component}`),
      ];
      for (const identifier of identifiers) {
        expect(identifier).toMatch(legalIdentifier);
        expect(identifier).not.toMatch(/__/);
        expect(identifier.startsWith("gl_")).toBe(false);
      }
    }
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
    // e.g. a custom-attribute node left over after its declaration was removed elsewhere.
    const declared = new Map<string, string>();
    const errors = collectUndeclaredAttributeErrors([{ name: "tint", type: VEC4 }], declared);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("undeclared-attribute");
    expect(errors[0].params).toEqual({ name: "tint" });
  });

  it("flags a request whose type disagrees with the declared type", () => {
    // e.g. a custom-attribute node left over after its declaration was retyped elsewhere.
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
