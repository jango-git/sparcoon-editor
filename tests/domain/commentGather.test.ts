import { describe, expect, it } from "vitest";

import { createEmptyGraph, type EditorGraph } from "../../src/domain/graphModel";
import { gatherIntoComment } from "../../src/domain/layout/commentGather";
import { cardsIn, commentTree } from "../../src/domain/layout/commentTree";

const SIZE = { width: 144, height: 72 };

function withNodes(ids: readonly string[]): EditorGraph {
  const graph = createEmptyGraph();
  const nodes = { ...graph.nodes };
  ids.forEach((id, index) => {
    nodes[id] = { id, type: "remap", parameters: {}, position: { x: 0, y: index * 24 } };
  });
  return { ...graph, nodes };
}

function heldBy(graph: EditorGraph): Record<string, string[]> {
  const tree = commentTree(
    graph.comments,
    Object.values(graph.nodes).map((node) => ({ id: node.id, box: { ...node.position, ...SIZE } })),
    [],
  );
  const held: Record<string, string[]> = {};
  const visit = (level: typeof tree): void => {
    for (const block of level.blocks) {
      held[block.comment.id] = cardsIn(block).sort();
      visit(block);
    }
  };
  visit(tree);
  return held;
}

describe("gatherIntoComment", () => {
  it("frames exactly the given nodes, however they overlapped the others", () => {
    const graph = gatherIntoComment(
      withNodes(["a", "b", "c", "d"]),
      { nodes: ["b", "d"], comments: [] },
      { id: "pair", text: "Pair" },
      { grid: 24, sizeOf: () => SIZE },
    );
    expect(heldBy(graph)).toEqual({ pair: ["b", "d"] });
  });

  it("nests a gathered comment with what it holds", () => {
    const inner = gatherIntoComment(
      withNodes(["a", "b", "c", "d"]),
      { nodes: ["a", "b"], comments: [] },
      { id: "inner", text: "Inner" },
      { grid: 24, sizeOf: () => SIZE },
    );
    const outer = gatherIntoComment(
      inner,
      { nodes: ["c"], comments: ["inner"] },
      { id: "outer", text: "Outer" },
      { grid: 24, sizeOf: () => SIZE },
    );
    expect(heldBy(outer)).toEqual({ inner: ["a", "b"], outer: ["a", "b", "c"] });
  });
});
