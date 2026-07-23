import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addComment,
  moveCommentGroup,
  removeComment,
  renameComment,
  resizeComment,
  addCatalogNode,
} from "../../src/model/commands";
import { selectRenderGraph } from "../../src/model/selectors";
import { serializeGraph } from "../../src/domain/serialize";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

/** Counts the structural vs view-only signals a body emits. */
function countSignals(signals: SignalBus, body: () => void): { structural: number; view: number } {
  let structural = 0;
  let view = 0;
  signals.on("sourceStructureChanged", () => (structural += 1));
  signals.on("sourceViewChanged", () => (view += 1));
  body();
  return { structural, view };
}

describe("comment commands", () => {
  it("adds, renames, moves, resizes and removes a comment", () => {
    const store = freshStore();
    const id = addComment(store, "renderGraph", { x: 24, y: 24 }, { width: 120, height: 96 });

    let comment = selectRenderGraph(store).comments.find((c) => c.id === id);
    expect(comment).toMatchObject({
      text: "Comment",
      position: { x: 24, y: 24 },
      size: { width: 120, height: 96 },
    });

    renameComment(store, "renderGraph", id, "Forces");
    resizeComment(store, "renderGraph", id, { width: 200, height: 150 }, { x: 48, y: 24 });
    moveCommentGroup(store, "renderGraph", [{ id, position: { x: 72, y: 48 } }]);

    comment = selectRenderGraph(store).comments.find((c) => c.id === id);
    expect(comment).toMatchObject({
      text: "Forces",
      position: { x: 72, y: 48 },
      size: { width: 200, height: 150 },
    });

    removeComment(store, "renderGraph", id);
    expect(selectRenderGraph(store).comments).toHaveLength(0);
  });

  it("commits every comment edit as view-only (never recompiles)", () => {
    const bus = new SignalBus();
    const store = new Store(createInitialState(), bus);
    const { structural, view } = countSignals(bus, () => {
      const id = addComment(store, "renderGraph", { x: 0, y: 0 }, { width: 96, height: 72 });
      renameComment(store, "renderGraph", id, "Note");
      resizeComment(store, "renderGraph", id, { width: 120, height: 96 });
      moveCommentGroup(store, "renderGraph", [{ id, position: { x: 24, y: 0 } }]);
      removeComment(store, "renderGraph", id);
    });
    expect(structural).toBe(0);
    expect(view).toBe(5);
  });

  it("moveCommentGroup carries enclosed nodes in one commit", () => {
    const store = freshStore();
    const nodeId = addCatalogNode(store, "renderGraph", "constant", { x: 40, y: 40 })!;
    const commentId = addComment(store, "renderGraph", { x: 0, y: 0 }, { width: 200, height: 200 });

    moveCommentGroup(
      store,
      "renderGraph",
      [{ id: commentId, position: { x: 100, y: 100 } }],
      [{ nodeId, position: { x: 140, y: 140 } }],
    );

    const graph = selectRenderGraph(store);
    expect(graph.comments.find((c) => c.id === commentId)?.position).toEqual({ x: 100, y: 100 });
    expect(graph.nodes[nodeId].position).toEqual({ x: 140, y: 140 });
  });

  it("comments never reach the compiled snapshot", () => {
    const store = freshStore();
    const before = serializeGraph(selectRenderGraph(store));
    addComment(store, "renderGraph", { x: 0, y: 0 }, { width: 96, height: 72 });
    const after = serializeGraph(selectRenderGraph(store));
    // A comment adds no nodes, connections or bindings - the snapshot is byte-for-byte the same.
    expect(after).toEqual(before);
  });
});
