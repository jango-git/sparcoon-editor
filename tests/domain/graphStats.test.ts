import { describe, expect, it } from "vitest";

import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { computeGraphStats, computeNodeCosts, computeSinkCost } from "../../src/domain/graphStats";
import { GraphKind } from "../../src/domain/nodePalette";

function makeNode(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
): EditorGraph["nodes"][string] {
  return { id, type, parameters, position: { x: 0, y: 0 } };
}

/** `a + b` over two constants of `type`, bound to albedo, plus an unconnected `orphan`. */
function addGraph(type: "float" | "vec3"): EditorGraph {
  const value = (n: number): number | number[] => (type === "float" ? n : [n, n, n]);
  return {
    ...createEmptyGraph(),
    nodes: {
      a: makeNode("a", "constant", { type, value: value(1) }),
      b: makeNode("b", "constant", { type, value: value(2) }),
      add: makeNode("add", "binary-op", { op: "add" }),
      orphan: makeNode("orphan", "constant"),
    },
    connections: [
      { id: "c1", from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "add", socketKey: "a" } },
      { id: "c2", from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "add", socketKey: "b" } },
    ],
    outputBindings: [{ slot: "albedo", from: { nodeId: "add", socketKey: "out" } }],
  };
}

// Costs are in "one scalar float ALU op" units, a vecN op costing N times a float one
// (FXGraphNode.estimateCost): a constant is a literal (0), `add` is 1 per component.

describe("computeGraphStats", () => {
  it("counts only reachable nodes and sums their cost, excluding an unconnected extra node", () => {
    const stats = computeGraphStats(GraphKind.Render, addGraph("vec3"));
    // a, b, add are reachable; the unconnected "orphan" constant is not.
    expect(stats.nodeCount).toBe(3);
    // constant = 0 (x2) + binary-op "add" on a resolved vec3 = 3.
    expect(stats.cost).toBe(3);
  });

  it("returns zero stats for a graph with nothing wired to an output", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: { a: makeNode("a", "constant") },
    };
    const stats = computeGraphStats(GraphKind.Render, graph);
    expect(stats.nodeCount).toBe(0);
    expect(stats.cost).toBe(0);
  });

  it("scales cost with the actually-connected width (float chain costs less than a vec3 one)", () => {
    const floatCost = computeGraphStats(GraphKind.Render, addGraph("float")).cost;
    const vec3Cost = computeGraphStats(GraphKind.Render, addGraph("vec3")).cost;
    expect(floatCost).toBe(1); // binary-op "add" on float = 1
    expect(floatCost).toBeLessThan(vec3Cost);
  });
});

describe("computeNodeCosts", () => {
  it("prices every node regardless of reachability - unlike computeGraphStats' reachable-only sum", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: {
        a: makeNode("a", "constant", { type: "vec3", value: [1, 2, 3] }),
        add: makeNode("add", "binary-op", { op: "add" }),
      },
      connections: [
        {
          id: "c1",
          from: { nodeId: "a", socketKey: "out" },
          to: { nodeId: "add", socketKey: "a" },
        },
      ],
      // Nothing binds "add" to an output - it is unreachable, but the badge should still price it.
      outputBindings: [],
    };

    expect(computeGraphStats(GraphKind.Render, graph).nodeCount).toBe(0);

    const costs = computeNodeCosts(GraphKind.Render, graph);
    expect(costs.get("a")).toBe(0); // constant
    // "b" is unconnected, but "a" pins T to vec3 via the wired-in width - the badge follows it.
    expect(costs.get("add")).toBe(3);
  });

  it("updates a node's own badge when its structural param changes (op affects cost)", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: { add: makeNode("add", "binary-op", { op: "add" }) },
    };
    const power: EditorGraph = {
      ...graph,
      nodes: { add: makeNode("add", "binary-op", { op: "power" }) },
    };
    const addCost = computeNodeCosts(GraphKind.Render, graph).get("add");
    const powerCost = computeNodeCosts(GraphKind.Render, power).get("add");
    expect(powerCost).toBeGreaterThan(addCost ?? 0);
  });

  it("omits a sink node from the cost map (never registered as a real engine node)", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: { out: makeNode("out", "$out") },
    };
    expect(computeNodeCosts(GraphKind.Render, graph).has("out")).toBe(false);
  });
});

describe("computeSinkCost", () => {
  it("prices only one behavior phase's reachable nodes, ignoring the other phase's bindings", () => {
    const graph: EditorGraph = {
      ...createEmptyGraph(),
      nodes: {
        spawnA: makeNode("spawnA", "constant", { type: "float", value: 1 }),
        updateA: makeNode("updateA", "constant", { type: "float", value: 2 }),
        updateB: makeNode("updateB", "constant", { type: "float", value: 3 }),
        updateAdd: makeNode("updateAdd", "binary-op", { op: "add" }),
      },
      connections: [
        {
          id: "c1",
          from: { nodeId: "updateA", socketKey: "out" },
          to: { nodeId: "updateAdd", socketKey: "a" },
        },
        {
          id: "c2",
          from: { nodeId: "updateB", socketKey: "out" },
          to: { nodeId: "updateAdd", socketKey: "b" },
        },
      ],
      outputBindings: [
        { slot: "position", from: { nodeId: "spawnA", socketKey: "out" }, phase: "spawn" },
        { slot: "position", from: { nodeId: "updateAdd", socketKey: "out" }, phase: "update" },
      ],
    };

    // spawn reaches only "spawnA" (a bare constant = 0 cost) - "update"'s chain is not counted in.
    expect(computeSinkCost(GraphKind.Behavior, graph, "spawn")).toBe(0);
    // update reaches updateA + updateB + updateAdd: 0 + 0 + 1 (float "add") = 1.
    expect(computeSinkCost(GraphKind.Behavior, graph, "update")).toBe(1);
  });
});
