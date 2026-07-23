import { describe, expect, it } from "vitest";
import type { FXConnection, FXGraphSnapshot, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../src/engine/core/compiler/FXGraphTraversal.Internal";
import { fnv1a64, structuralHash } from "../../src/engine/core/compiler/FXStructuralHash.Internal";
import { FakeBackend, FakeNode, socket } from "../helpers/fakeNodes";

function graphOf(
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

function hashOf(
  graph: FXGraph<FakeNode>,
  nodeKey?: (id: string, node: FakeNode) => string,
): string {
  const reachable = collectReachableNodeIds(graph);
  const { order } = topologicalOrder(graph, reachable);
  return structuralHash(graph, "t", order, nodeKey);
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** Builds a small diamond: p -> {b,c} -> d, with two output bindings. */
function diamond(prefix: string): FXGraph<FakeNode> {
  const io = { inputs: [socket("in")], outputs: [socket("out")] };
  return graphOf(
    {
      [`${prefix}p`]: new FakeNode({ type: "p", outputs: [socket("out")] }),
      [`${prefix}b`]: new FakeNode({ type: "b", ...io }),
      [`${prefix}c`]: new FakeNode({ type: "c", ...io }),
      [`${prefix}d`]: new FakeNode({
        type: "d",
        inputs: [socket("in"), socket("in2")],
        outputs: [socket("out")],
      }),
    },
    [
      edge(`${prefix}p`, "out", `${prefix}b`, "in"),
      edge(`${prefix}p`, "out", `${prefix}c`, "in"),
      edge(`${prefix}b`, "out", `${prefix}d`, "in"),
      edge(`${prefix}c`, "out", `${prefix}d`, "in2"),
    ],
    [
      { slot: "albedo", from: { nodeId: `${prefix}d`, socketKey: "out" } },
      { slot: "emissive", from: { nodeId: `${prefix}b`, socketKey: "out" } },
    ],
  );
}

describe("structuralHash", () => {
  // 64-bit hash: two concatenated 32-bit FNV-1a lanes rendered as 16 hex chars.
  it("matches the format /^[0-9a-f]{16}$/", () => {
    expect(hashOf(diamond("a"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is independent of connections/outputBindings array order", () => {
    const io = { inputs: [socket("in")], outputs: [socket("out")] };
    const nodes = {
      p: new FakeNode({ type: "p", outputs: [socket("out")] }),
      b: new FakeNode({ type: "b", ...io }),
    };
    const conns = [edge("p", "out", "b", "in")];
    const binds: FXOutputBinding[] = [
      { slot: "albedo", from: { nodeId: "b", socketKey: "out" } },
      { slot: "emissive", from: { nodeId: "p", socketKey: "out" } },
    ];

    const forward = hashOf(graphOf(nodes, conns, binds));
    const reversed = hashOf(graphOf(nodes, [...conns].reverse(), [...binds].reverse()));

    expect(reversed).toBe(forward);
  });

  it("is independent of the editor's node ids", () => {
    expect(hashOf(diamond("x"))).toBe(hashOf(diamond("y")));
  });

  it("changes when a reachable node's cacheKey changes", () => {
    const graph = diamond("a");
    const before = hashOf(graph);

    const node = graph.getNode("ab");
    expect(node).toBeDefined();
    node!.variant = "flipped";

    expect(hashOf(graph)).not.toBe(before);
  });

  it("changes when a reachable node's nodeKey (e.g. phase) changes", () => {
    const graph = diamond("a");
    const phaseOf = new Map<FakeNode, string>();
    const nodeKey = (_id: string, node: FakeNode): string => phaseOf.get(node) ?? "spawn";
    const before = hashOf(graph, nodeKey);

    phaseOf.set(graph.getNode("ad")!, "update");

    expect(hashOf(graph, nodeKey)).not.toBe(before);
  });

  it("ignores edits to an unreachable node", () => {
    const graph = graphOf(
      {
        good: new FakeNode({ type: "good", outputs: [socket("out")] }),
        island: new FakeNode({ type: "island", variant: "a", outputs: [socket("out")] }),
      },
      [],
      [{ slot: "albedo", from: { nodeId: "good", socketKey: "out" } }],
    );
    const before = hashOf(graph);

    graph.getNode("island")!.variant = "b";

    expect(hashOf(graph)).toBe(before);
  });

  it("hashes both surrogate halves: astral characters do not collide (P11.4, L4)", () => {
    // 😀 (U+1F600) and 😁 (U+1F601) share the high surrogate; only the low one
    // differs - a code-point iteration reading charCodeAt(0) collides them.
    expect(fnv1a64("type:😀:")).not.toBe(fnv1a64("type:😁:"));
  });

  it("a delimiter inside type/cacheKey does not alias a different split (P11.4, L9)", () => {
    // Same concatenation "a:b::" under the old `${type}:${variant}:` join.
    const x = graphOf(
      { n: new FakeNode({ type: "a", variant: "b:", outputs: [socket("out")] }) },
      [],
      [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
    );
    const y = graphOf(
      { n: new FakeNode({ type: "a:b", variant: "", outputs: [socket("out")] }) },
      [],
      [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
    );
    expect(hashOf(x)).not.toBe(hashOf(y));

    // Same concatenation "a|b" if types joined a multi-part key with "|".
    const p = graphOf(
      { n: new FakeNode({ type: "a|b", outputs: [socket("out")] }) },
      [],
      [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
    );
    const q = graphOf(
      { n: new FakeNode({ type: "a", variant: "|b", outputs: [socket("out")] }) },
      [],
      [{ slot: "albedo", from: { nodeId: "n", socketKey: "out" } }],
    );
    expect(hashOf(p)).not.toBe(hashOf(q));
  });

  it("previewHash equals the compiled artifact's hash (fake backend)", () => {
    const backend = new FakeBackend();
    const graph = diamond("a");
    expect(backend.previewHash(graph)).toBe(backend.compile(graph).hash);
  });
});
