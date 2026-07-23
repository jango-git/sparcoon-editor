import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addCatalogNode,
  addVfxMesh,
  nextIdentifier,
  pasteFragment,
  type GraphFragment,
} from "../../src/model/commands";
import { selectActiveGraphOwner, selectRenderGraph } from "../../src/model/selectors";
import type { EditorGraph } from "../../src/domain/graphModel";

const node = (id: string, type: string, x: number, y: number): EditorGraph["nodes"][string] => ({
  id,
  type,
  parameters: {},
  position: { x, y },
});

describe("pasteFragment command", () => {
  it("clones nodes and their internal edge with fresh ids, offset, originals untouched", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const fragment: GraphFragment = {
      nodes: [node("a", "constant", 0, 0), node("b", "binary-op", 100, 0)],
      connections: [
        { id: "c", from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "b", socketKey: "a" } },
      ],
      comments: [],
    };

    const before = Object.keys(selectRenderGraph(store).nodes).length;
    const { nodeIds } = pasteFragment(store, "renderGraph", fragment, { x: 48, y: 48 });
    const graph = selectRenderGraph(store);

    // Two brand-new nodes, ids unrelated to the copied "a"/"b".
    expect(nodeIds).toHaveLength(2);
    expect(nodeIds).not.toContain("a");
    expect(nodeIds).not.toContain("b");
    expect(Object.keys(graph.nodes)).toHaveLength(before + 2);

    const pastedA = graph.nodes[nodeIds[0]];
    const pastedB = graph.nodes[nodeIds[1]];
    expect(pastedA.type).toBe("constant");
    expect(pastedA.position).toEqual({ x: 48, y: 48 });
    expect(pastedB.position).toEqual({ x: 148, y: 48 });

    // The internal connection is re-minted and rewired onto the two pasted node ids.
    const edge = graph.connections.find(
      (c) => c.from.nodeId === nodeIds[0] && c.to.nodeId === nodeIds[1],
    );
    expect(edge).toBeDefined();
    expect(edge!.id).not.toBe("c");
  });

  it("drops an edge whose endpoint was not part of the fragment (outside connection)", () => {
    const store = new Store(createInitialState(), new SignalBus());
    // Only "a" is copied, but the edge references an un-copied "outside" node.
    const fragment: GraphFragment = {
      nodes: [node("a", "constant", 0, 0)],
      connections: [
        {
          id: "c",
          from: { nodeId: "a", socketKey: "out" },
          to: { nodeId: "outside", socketKey: "a" },
        },
      ],
      comments: [],
    };

    const edgesBefore = selectRenderGraph(store).connections.length;
    pasteFragment(store, "renderGraph", fragment, { x: 24, y: 24 });

    // The dangling edge is not pasted (its target was never copied).
    expect(selectRenderGraph(store).connections).toHaveLength(edgesBefore);
  });

  it("gives pasted ids that never collide with a freshly minted id", () => {
    const store = new Store(createInitialState(), new SignalBus());
    const fragment: GraphFragment = {
      nodes: [node("a", "constant", 0, 0)],
      connections: [],
      comments: [],
    };
    const { nodeIds } = pasteFragment(store, "renderGraph", fragment, { x: 0, y: 0 });
    // A subsequent mint must not reproduce the pasted id (identifier counter advanced).
    const minted = nextIdentifier("node");
    expect(nodeIds).not.toContain(minted);
    // A real add still lands cleanly, distinct from the paste.
    const added = addCatalogNode(store, "renderGraph", "constant", { x: 0, y: 0 })!;
    expect(nodeIds).not.toContain(added);
  });

  it("drops a particle-only node when pasting into a VFX mesh's render graph", () => {
    const store = new Store(createInitialState(), new SignalBus());
    addVfxMesh(store); // the active graph owner is now the mesh (render-only)
    const fragment: GraphFragment = {
      // "dissolve" reads PARTICLE_AGE - the add-node menu already hides it for a mesh owner
      // (isMeshExcludedRenderNode); paste must reject it the same way, not just node-agnostic
      // ids like "constant".
      nodes: [node("a", "dissolve", 0, 0), node("b", "constant", 100, 0)],
      connections: [
        { id: "c", from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "b", socketKey: "a" } },
      ],
      comments: [],
    };

    const before = Object.keys(selectActiveGraphOwner(store).renderGraph.nodes).length;
    const { nodeIds } = pasteFragment(store, "renderGraph", fragment, { x: 0, y: 0 });
    const graph = selectActiveGraphOwner(store).renderGraph;

    // Only the eligible node pastes; the particle-only one and its edge are dropped.
    expect(nodeIds).toHaveLength(1);
    expect(Object.keys(graph.nodes)).toHaveLength(before + 1);
    expect(graph.nodes[nodeIds[0]].type).toBe("constant");
    expect(graph.connections.some((c) => c.id !== "c" && c.to.nodeId === nodeIds[0])).toBe(false);
  });
});
