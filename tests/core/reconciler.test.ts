import { describe, expect, it } from "vitest";

import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { FX_SNAPSHOT_VERSION } from "../../src/engine/core/live/FXSnapshotData";
import type { FakeNode } from "../helpers/fakeNodes";
import { makeRegistry, socket } from "../helpers/fakeNodes";

function data(
  nodes: Record<string, { type: string; params?: Record<string, unknown> }>,
  connections: readonly FXConnection[] = [],
  outputBindings: readonly FXOutputBinding[] = [],
): FXGraphSnapshotData {
  return { version: 2, nodes, connections, outputBindings };
}

const TYPES = [
  { type: "a", outputs: [socket("out")] },
  { type: "t1", outputs: [socket("out")] },
  { type: "t2", outputs: [socket("out")] },
  { type: "keep", inputs: [socket("in")], outputs: [socket("out")] },
  { type: "src", outputs: [socket("out")] },
];

function setup(): {
  graph: FXGraph<FakeNode>;
  reconciler: FXGraphReconciler<FakeNode>;
  created: FakeNode[];
} {
  const { registry, created } = makeRegistry(TYPES);
  return { graph: new FXGraph<FakeNode>(), reconciler: new FXGraphReconciler(registry), created };
}

describe("FXGraphReconciler", () => {
  it("reuses an instance by id and applies new params to it", () => {
    const { graph, reconciler } = setup();
    reconciler.reconcile(graph, data({ n1: { type: "a" } }));
    const instance = graph.getNode("n1");
    expect(instance).toBeDefined();
    expect(instance!.applyParamsCount).toBe(0);

    reconciler.reconcile(graph, data({ n1: { type: "a", params: { k: 1 } } }));

    expect(graph.getNode("n1")).toBe(instance);
    expect(instance!.applyParamsCount).toBe(1);
    expect(instance!.lastParams).toEqual({ k: 1 });
  });

  it("replaces on a same-id type change: old discarded, new prepared", () => {
    const { graph, reconciler } = setup();
    reconciler.reconcile(graph, data({ n1: { type: "t1" } }));
    const old = graph.getNode("n1");
    expect(old!.type).toBe("t1");

    const result = reconciler.reconcile(graph, data({ n1: { type: "t2" } }));

    expect(result.discarded).toContain(old);
    expect(old!.destroyCount).toBe(0);
    const replacement = graph.getNode("n1");
    expect(replacement!.type).toBe("t2");
    expect(replacement!.prepareCount).toBe(1);
  });

  it("prepares newly added nodes and discards removed ones", () => {
    const { graph, reconciler } = setup();
    const added = reconciler.reconcile(graph, data({ n1: { type: "a" } }));
    expect(added.diff.addedNodeIds).toEqual(["n1"]);
    const node = graph.getNode("n1");
    expect(node!.prepareCount).toBe(1);

    const removed = reconciler.reconcile(graph, data({}));

    expect(removed.discarded).toContain(node);
  });

  it("errors (without throwing) on a snapshot version newer than this build, mutating nothing", () => {
    const { graph, reconciler, created } = setup();
    reconciler.reconcile(graph, data({ n1: { type: "a" } }));
    const resident = graph.getNode("n1");
    const bad = {
      version: FX_SNAPSHOT_VERSION + 1,
      nodes: { n2: { type: "a" } },
      connections: [],
      outputBindings: [],
    } as unknown as FXGraphSnapshotData;

    let result: ReturnType<typeof reconciler.reconcile> | undefined;
    expect(() => {
      result = reconciler.reconcile(graph, bad);
    }).not.toThrow();
    expect(result?.errors).toHaveLength(1);
    expect(result?.errors[0]?.code).toBe("unsupported-snapshot-version");
    expect(result?.discarded).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(graph.getNode("n1")).toBe(resident);
    expect(graph.getNode("n2")).toBeUndefined();
  });

  it("leaves the graph untouched on a failed run and discards only the instances it minted", () => {
    const { graph, reconciler } = setup();
    reconciler.reconcile(graph, data({ n1: { type: "a" } }));
    const resident = graph.getNode("n1");

    const result = reconciler.reconcile(
      graph,
      data({ n1: { type: "a" }, n2: { type: "t1" }, x: { type: "no-such-node" } }),
    );

    expect(result.errors.map((error) => [error.code, error.nodeId])).toEqual([
      ["unknown-node-type", "x"],
    ]);
    const minted = result.discarded;
    expect(minted).toHaveLength(1);
    expect(minted[0]?.type).toBe("t1");
    expect(result.freshIds).toEqual([]);
    expect(graph.getNode("n1")).toBe(resident);
    expect(graph.getNode("n2")).toBeUndefined();
  });

  it("rewires connections and output bindings in place, keeping every instance", () => {
    const { graph, reconciler } = setup();
    const nodes = { s1: { type: "src" }, s2: { type: "src" }, k: { type: "keep" } };
    reconciler.reconcile(
      graph,
      data(
        nodes,
        [{ from: { nodeId: "s1", socketKey: "out" }, to: { nodeId: "k", socketKey: "in" } }],
        [{ slot: "albedo", from: { nodeId: "k", socketKey: "out" } }],
      ),
    );
    const before = [...graph.nodes];

    const result = reconciler.reconcile(
      graph,
      data(
        nodes,
        [{ from: { nodeId: "s2", socketKey: "out" }, to: { nodeId: "k", socketKey: "in" } }],
        [{ slot: "emissive", from: { nodeId: "s1", socketKey: "out" } }],
      ),
    );

    expect(result.errors).toEqual([]);
    expect(result.discarded).toEqual([]);
    expect(result.freshIds).toEqual([]);
    for (const [id, node] of before) {
      expect(graph.getNode(id), id).toBe(node);
    }
    expect(graph.sourceOf({ nodeId: "k", socketKey: "in" })?.from.nodeId).toBe("s2");
    expect(graph.outputBindings).toEqual([
      { slot: "emissive", from: { nodeId: "s1", socketKey: "out" } },
    ]);
  });

  it("keeps a node resident when it only loses its connections", () => {
    const { graph, reconciler } = setup();
    const connected = data({ s: { type: "src" }, k: { type: "keep" } }, [
      { from: { nodeId: "s", socketKey: "out" }, to: { nodeId: "k", socketKey: "in" } },
    ]);
    reconciler.reconcile(graph, connected);
    const keep = graph.getNode("k");

    const result = reconciler.reconcile(graph, data({ s: { type: "src" }, k: { type: "keep" } }));

    expect(result.discarded).not.toContain(keep);
    expect(graph.getNode("k")).toBe(keep);
    expect(graph.sourceOf({ nodeId: "k", socketKey: "in" })).toBeUndefined();
  });
});
