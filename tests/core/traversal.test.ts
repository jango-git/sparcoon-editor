import { describe, expect, it } from "vitest";
import type { FXConnection, FXGraphSnapshot, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../src/engine/core/compiler/FXGraphTraversal.Internal";
import { FakeNode, socket } from "../helpers/fakeNodes";

function build(
  nodes: Record<string, FakeNode>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXGraph<FakeNode> {
  const snapshot: FXGraphSnapshot<FakeNode> = {
    nodes: new Map(Object.entries(nodes)),
    connections,
    outputBindings,
  };
  const graph = new FXGraph<FakeNode>();
  graph.ingest(snapshot);
  return graph;
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

describe("collectReachableNodeIds", () => {
  it("includes only nodes upstream of an output binding", () => {
    const graph = build(
      {
        a: new FakeNode({ type: "a", outputs: [socket("out")] }),
        b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }),
        island: new FakeNode({ type: "island", outputs: [socket("out")] }),
      },
      [edge("a", "out", "b", "in")],
      [{ slot: "albedo", from: { nodeId: "b", socketKey: "out" } }],
    );

    const reachable = collectReachableNodeIds(graph);

    expect(reachable.has("a")).toBe(true);
    expect(reachable.has("b")).toBe(true);
    expect(reachable.has("island")).toBe(false);
  });

  it("does not recurse through a missing node but still records its id", () => {
    const graph = build(
      { b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }) },
      [edge("ghost", "out", "b", "in")],
      [{ slot: "albedo", from: { nodeId: "b", socketKey: "out" } }],
    );

    const reachable = collectReachableNodeIds(graph);

    expect(reachable.has("b")).toBe(true);
    expect(reachable.has("ghost")).toBe(true);
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies before dependents", () => {
    const graph = build(
      {
        a: new FakeNode({ type: "a", outputs: [socket("out")] }),
        b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }),
        c: new FakeNode({ type: "c", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("a", "out", "b", "in"), edge("b", "out", "c", "in")],
      [{ slot: "albedo", from: { nodeId: "c", socketKey: "out" } }],
    );
    const reachable = collectReachableNodeIds(graph);

    const { order, cycleNodeId } = topologicalOrder(graph, reachable);

    expect(cycleNodeId).toBeUndefined();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("detects a cycle and reports the node it closed on", () => {
    const graph = build(
      {
        a: new FakeNode({ type: "a", inputs: [socket("in")], outputs: [socket("out")] }),
        b: new FakeNode({ type: "b", inputs: [socket("in")], outputs: [socket("out")] }),
      },
      [edge("a", "out", "b", "in"), edge("b", "out", "a", "in")],
      [{ slot: "albedo", from: { nodeId: "b", socketKey: "out" } }],
    );
    const reachable = collectReachableNodeIds(graph);

    const { cycleNodeId } = topologicalOrder(graph, reachable);

    expect(cycleNodeId === "a" || cycleNodeId === "b").toBe(true);
  });
});
