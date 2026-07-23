import { describe, expect, it } from "vitest";
import type { FXConnection, FXGraphSnapshot } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FakeNode, socket } from "../helpers/fakeNodes";

function snapshot(
  nodes: Record<string, FakeNode>,
  connections: readonly FXConnection[] = [],
): FXGraphSnapshot<FakeNode> {
  return {
    nodes: new Map(Object.entries(nodes)),
    connections,
    outputBindings: [],
  };
}

describe("FXGraph.ingest", () => {
  it("reports newly added node ids", () => {
    const graph = new FXGraph<FakeNode>();
    const a = new FakeNode({ type: "a" });
    const b = new FakeNode({ type: "b" });

    const diff = graph.ingest(snapshot({ a, b }));

    expect([...diff.addedNodeIds].sort()).toEqual(["a", "b"]);
    expect(diff.removedNodes).toEqual([]);
  });

  it("reports removed node instances", () => {
    const graph = new FXGraph<FakeNode>();
    const a = new FakeNode({ type: "a" });
    const b = new FakeNode({ type: "b" });
    graph.ingest(snapshot({ a, b }));

    const diff = graph.ingest(snapshot({ a }));

    expect(diff.addedNodeIds).toEqual([]);
    expect(diff.removedNodes).toEqual([b]);
  });

  it("returns an empty diff when the same snapshot is ingested twice", () => {
    const graph = new FXGraph<FakeNode>();
    const a = new FakeNode({ type: "a" });
    const snap = snapshot({ a });
    graph.ingest(snap);

    const diff = graph.ingest(snap);

    expect(diff.addedNodeIds).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });
});

describe("FXGraph.sourceOf", () => {
  it("returns the first of duplicate connections into one input", () => {
    const graph = new FXGraph<FakeNode>();
    const producer = new FakeNode({ type: "p", outputs: [socket("out")] });
    const other = new FakeNode({ type: "q", outputs: [socket("out")] });
    const consumer = new FakeNode({ type: "c", inputs: [socket("in")] });

    const first: FXConnection = {
      from: { nodeId: "producer", socketKey: "out" },
      to: { nodeId: "consumer", socketKey: "in" },
    };
    const second: FXConnection = {
      from: { nodeId: "other", socketKey: "out" },
      to: { nodeId: "consumer", socketKey: "in" },
    };

    graph.ingest(snapshot({ producer, other, consumer }, [first, second]));

    expect(graph.sourceOf({ nodeId: "consumer", socketKey: "in" })).toBe(first);
  });

  it("returns undefined for an unconnected input", () => {
    const graph = new FXGraph<FakeNode>();
    const consumer = new FakeNode({ type: "c", inputs: [socket("in")] });
    graph.ingest(snapshot({ consumer }));

    expect(graph.sourceOf({ nodeId: "consumer", socketKey: "in" })).toBeUndefined();
  });
});
