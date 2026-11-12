import { describe, expect, it } from "vitest";

import type { EditorGraph, GraphNode } from "../../src/domain/graphModel";
import { resolveSocketType } from "../../src/domain/graphTypeResolution";
import { GraphKind } from "../../src/domain/nodePalette";

function node(id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode {
  return { id, type, parameters, position: { x: 0, y: 0 } };
}

/** A `binary-op` fed `a` from a constant of `typeA` and `b` from one of `typeB`. */
function multiplying(typeA: string, typeB: string): EditorGraph {
  return {
    nodes: {
      a: node("a", "constant", { type: typeA }),
      b: node("b", "constant", { type: typeB }),
      op: node("op", "binary-op", { op: "multiply" }),
    },
    connections: [
      { id: "c1", from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "op", socketKey: "a" } },
      { id: "c2", from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "op", socketKey: "b" } },
    ],
    outputBindings: [],
    attributes: [],
    comments: [],
  };
}

const outputType = (graph: EditorGraph): string | undefined =>
  resolveSocketType(GraphKind.Render, "op", "out", graph, [], new Set());

describe("resolveSocketType: a generic node's T, as the engine resolves it", () => {
  it("takes the vector when a scalar comes first, so the scalar splats across it", () => {
    expect(outputType(multiplying("float", "vec3"))).toBe("vec3");
  });

  it("takes the vector when it comes first", () => {
    expect(outputType(multiplying("vec3", "float"))).toBe("vec3");
  });

  it("takes the first vector when two differ in width", () => {
    expect(outputType(multiplying("vec2", "vec4"))).toBe("vec2");
  });

  it("stays a float for two floats", () => {
    expect(outputType(multiplying("float", "float"))).toBe("float");
  });
});

describe("resolveSocketType: a generic node with nothing wired, from its inline values", () => {
  const lone = (type: string, parameters: Record<string, unknown>): EditorGraph => ({
    nodes: { op: node("op", type, parameters) },
    connections: [],
    outputBindings: [],
    attributes: [],
    comments: [],
  });

  it("takes the widest typed-in vector", () => {
    expect(outputType(lone("mix", { a: [1, 0, 0, 1], b: [0, 0, 1, 1] }))).toBe("vec4");
  });

  it("is a float when the values are numbers (the declared defaults included)", () => {
    expect(outputType(lone("binary-op", { op: "add" }))).toBe("float");
  });
});
