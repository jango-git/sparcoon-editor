import { describe, expect, it } from "vitest";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../src/engine/core/compiler/FXGraphTraversal.Internal";
import { structuralHash } from "../../src/engine/core/compiler/FXStructuralHash.Internal";
import {
  genericTypeTag,
  resolveGenerics,
} from "../../src/engine/core/compiler/FXTypeResolve.Internal";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphNode } from "../../src/engine/core/FXGraphNode";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import type { FXGLSLTypeName } from "../../src/engine/core/socket/FXValueType";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";

const CONSTRAINT: readonly FXGLSLTypeName[] = ["float", "vec2", "vec3", "vec4"];

/** A generic socket (`"T"`) with the standard numeric constraint. */
function genericSocket(key: string, required = false): FXSocketDescriptor {
  return { key, type: { generic: "T", constraint: CONSTRAINT }, required };
}

/** A concrete socket. */
function concreteSocket(key: string, type: FXGLSLTypeName): FXSocketDescriptor {
  return { key, type: resolveValueType(type) };
}

/** A minimal generic node: configurable sockets, an optional explicit `T` annotation. */
class GenericNode extends FXGraphNode {
  public readonly inputs: readonly FXSocketDescriptor[];
  public readonly outputs: readonly FXSocketDescriptor[];

  constructor(
    public readonly type: string,
    config: {
      inputs?: readonly FXSocketDescriptor[];
      outputs?: readonly FXSocketDescriptor[];
      hint?: FXGLSLTypeName;
      constraint?: readonly FXGLSLTypeName[];
    },
  ) {
    super();
    this.inputs = config.inputs ?? [];
    this.outputs = config.outputs ?? [genericSocket("out")];
    if (config.constraint !== undefined) {
      this.outputs = [{ key: "out", type: { generic: "T", constraint: config.constraint } }];
    }
    this.hint = config.hint;
  }

  private readonly hint: FXGLSLTypeName | undefined;

  public build(): void {
    // Unused: resolution tests never compile.
  }

  public override resolveGenericHint(): FXGLSLTypeName | undefined {
    return this.hint;
  }
}

function graphOf(
  nodes: Map<string, FXGraphNode>,
  connections: FXGraph["connections"],
  bindTo: string,
): FXGraph {
  const graph = new FXGraph();
  graph.ingest({
    nodes,
    connections,
    outputBindings: [{ slot: "x", from: { nodeId: bindTo, socketKey: "out" } }],
  });
  return graph;
}

function orderOf(graph: FXGraph): readonly string[] {
  return topologicalOrder(graph, collectReachableNodeIds(graph)).order;
}

describe("resolveGenerics", () => {
  it("unifies a chain of generic nodes from an annotated source", () => {
    const nodes = new Map<string, FXGraphNode>([
      ["src", new GenericNode("constant", { hint: "vec3" })],
      [
        "op",
        new GenericNode("binary-op", {
          inputs: [genericSocket("a", true), genericSocket("b", true)],
        }),
      ],
    ]);
    const graph = graphOf(
      nodes,
      [
        { from: { nodeId: "src", socketKey: "out" }, to: { nodeId: "op", socketKey: "a" } },
        { from: { nodeId: "src", socketKey: "out" }, to: { nodeId: "op", socketKey: "b" } },
      ],
      "op",
    );

    const { types, errors } = resolveGenerics(graph, orderOf(graph));
    expect(errors).toHaveLength(0);
    expect(types.get("src")?.glslTypeName).toBe("vec3");
    expect(types.get("op")?.glslTypeName).toBe("vec3");
  });

  it("resolves to the first input's type when generic numeric inputs differ in width", () => {
    // Differing numeric widths are no longer a conflict: `T` takes the first
    // connected generic input's type, and the rest are coerced to it at readInput.
    const nodes = new Map<string, FXGraphNode>([
      ["a", new GenericNode("constant", { hint: "float" })],
      ["b", new GenericNode("constant", { hint: "vec3" })],
      [
        "op",
        new GenericNode("binary-op", {
          inputs: [genericSocket("a", true), genericSocket("b", true)],
        }),
      ],
    ]);
    const graph = graphOf(
      nodes,
      [
        { from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "op", socketKey: "a" } },
        { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "op", socketKey: "b" } },
      ],
      "op",
    );

    const { types, errors } = resolveGenerics(graph, orderOf(graph));
    expect(errors).toHaveLength(0);
    expect(types.get("op")?.glslTypeName).toBe("float");
  });

  it("reports a conflict when a generic input mixes a numeric and an opaque type", () => {
    // A numeric width paired with an opaque type (sampler) has no coercion, so it is
    // still a genuine conflict. The op carries both types on a widened constraint.
    const constraint: readonly FXGLSLTypeName[] = ["float", "sampler2D"];
    const nodes = new Map<string, FXGraphNode>([
      ["a", new GenericNode("constant", { hint: "float", constraint })],
      ["b", new GenericNode("constant", { hint: "sampler2D", constraint })],
      [
        "op",
        new GenericNode("binary-op", {
          inputs: [
            { key: "a", type: { generic: "T", constraint }, required: true },
            { key: "b", type: { generic: "T", constraint }, required: true },
          ],
          constraint,
        }),
      ],
    ]);
    const graph = graphOf(
      nodes,
      [
        { from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "op", socketKey: "a" } },
        { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "op", socketKey: "b" } },
      ],
      "op",
    );

    const { errors } = resolveGenerics(graph, orderOf(graph));
    expect(errors.some((e) => e.code === "generic-type-conflict" && e.nodeId === "op")).toBe(true);
  });

  it("reports unresolved when a generic node has neither input nor annotation", () => {
    const nodes = new Map<string, FXGraphNode>([["op", new GenericNode("constant", {})]]);
    const graph = graphOf(nodes, [], "op");

    const { errors, types } = resolveGenerics(graph, orderOf(graph));
    expect(errors.some((e) => e.code === "generic-type-unresolved" && e.nodeId === "op")).toBe(
      true,
    );
    expect(types.has("op")).toBe(false);
  });

  it("reports a conflict when the resolved type is outside the constraint", () => {
    const nodes = new Map<string, FXGraphNode>([
      ["src", new GenericNode("constant", { hint: "vec3" })],
      [
        "op",
        new GenericNode("length", {
          inputs: [{ key: "v", type: { generic: "T", constraint: ["float"] }, required: true }],
          constraint: ["float"],
        }),
      ],
    ]);
    const graph = graphOf(
      nodes,
      [{ from: { nodeId: "src", socketKey: "out" }, to: { nodeId: "op", socketKey: "v" } }],
      "op",
    );

    const { errors } = resolveGenerics(graph, orderOf(graph));
    expect(errors.some((e) => e.code === "generic-type-conflict")).toBe(true);
  });

  it("resolves a generic input fed by a concrete producer", () => {
    const nodes = new Map<string, FXGraphNode>([
      ["c", new GenericNode("source", { outputs: [concreteSocket("out", "vec2")] })],
      ["op", new GenericNode("unary-op", { inputs: [genericSocket("x", true)] })],
    ]);
    const graph = graphOf(
      nodes,
      [{ from: { nodeId: "c", socketKey: "out" }, to: { nodeId: "op", socketKey: "x" } }],
      "op",
    );

    const { types, errors } = resolveGenerics(graph, orderOf(graph));
    expect(errors).toHaveLength(0);
    expect(types.get("op")?.glslTypeName).toBe("vec2");
  });

  it("leaves non-generic graphs absent from the resolution and empty-tagged", () => {
    const nodes = new Map<string, FXGraphNode>([
      ["c", new GenericNode("source", { outputs: [concreteSocket("out", "float")] })],
    ]);
    const graph = graphOf(nodes, [], "c");
    const { types } = resolveGenerics(graph, orderOf(graph));
    expect(types.size).toBe(0);
    expect(genericTypeTag(types, "c")).toBe("");
  });
});

describe("genericTypeTag in the structural hash", () => {
  function hashWith(hint: FXGLSLTypeName): string {
    const nodes = new Map<string, FXGraphNode>([
      ["src", new GenericNode("constant", { hint })],
      ["op", new GenericNode("mix", { inputs: [genericSocket("a", true)] })],
    ]);
    const graph = graphOf(
      nodes,
      [{ from: { nodeId: "src", socketKey: "out" }, to: { nodeId: "op", socketKey: "a" } }],
      "op",
    );
    const order = orderOf(graph);
    const { types } = resolveGenerics(graph, order);
    return structuralHash(graph, "t", order, (id) => genericTypeTag(types, id));
  }

  it("distinguishes mix<float> from mix<vec3>", () => {
    expect(hashWith("float")).not.toBe(hashWith("vec3"));
  });
});
