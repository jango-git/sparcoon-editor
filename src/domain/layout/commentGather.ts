/**
 * Gathers cards and comments into a new comment. They move below everything else, side by side,
 * and the comment is framed round them, so it holds exactly them (`commentTree.ts`) wherever they
 * stood before. A gathered comment moves with what it holds. Arrange then lays them out.
 */

import type { EditorGraph, GraphComment, GraphNode, GraphSize } from "../graphModel";
import { type Box, COMMENT_PADDING_CELLS, commentFrame, encloses } from "./commentTree";

export interface CommentMembers {
  readonly nodes: readonly string[];
  readonly comments: readonly string[];
}

export interface GatherGeometry {
  readonly grid: number;
  /** A node's size on the canvas. */
  readonly sizeOf: (nodeId: string) => GraphSize;
}

export function gatherIntoComment(
  graph: EditorGraph,
  members: CommentMembers,
  comment: Pick<GraphComment, "id" | "text">,
  geometry: GatherGeometry,
): EditorGraph {
  const { grid, sizeOf } = geometry;
  const gap = COMMENT_PADDING_CELLS * grid;
  const boxOf = (node: GraphNode): Box => ({ ...node.position, ...sizeOf(node.id) });
  const commentBox = (target: GraphComment): Box => ({ ...target.position, ...target.size });
  const boxes = [...Object.values(graph.nodes).map(boxOf), ...graph.comments.map(commentBox)];
  const left = boxes.length === 0 ? 0 : Math.min(...boxes.map((box) => box.x));
  const below = boxes.length === 0 ? 0 : Math.max(...boxes.map((box) => box.y + box.height));
  const top = Math.ceil((below + 2 * gap + grid) / grid) * grid;

  const nodes = { ...graph.nodes };
  const frames = new Map(graph.comments.map((target) => [target.id, target]));
  let x = Math.floor(left / grid) * grid;
  const placed: Box[] = [];
  const moved = new Set<string>();
  const shiftNode = (id: string, dx: number, dy: number): void => {
    const node = nodes[id];
    if (node !== undefined && !moved.has(id)) {
      moved.add(id);
      nodes[id] = { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } };
    }
  };
  for (const id of members.nodes) {
    const node = graph.nodes[id];
    if (node === undefined) {
      continue;
    }
    const size = sizeOf(id);
    shiftNode(id, x - node.position.x, top - node.position.y);
    placed.push({ x, y: top, ...size });
    x += Math.ceil(size.width / grid) * grid + gap;
  }
  for (const id of members.comments) {
    const target = frames.get(id);
    if (target === undefined) {
      continue;
    }
    const dx = x - target.position.x;
    const dy = top - target.position.y;
    for (const node of Object.values(graph.nodes)) {
      if (encloses(target, boxOf(node))) {
        shiftNode(node.id, dx, dy);
      }
    }
    for (const inner of graph.comments) {
      if (inner === target || encloses(target, commentBox(inner))) {
        frames.set(inner.id, {
          ...inner,
          position: { x: inner.position.x + dx, y: inner.position.y + dy },
        });
      }
    }
    placed.push({ x, y: top, ...target.size });
    x += target.size.width + gap;
  }
  if (placed.length === 0) {
    return graph;
  }

  const frame = commentFrame(
    {
      left: Math.min(...placed.map((box) => box.x)),
      top,
      right: Math.max(...placed.map((box) => box.x + box.width)),
      bottom: Math.max(...placed.map((box) => box.y + box.height)),
    },
    grid,
    grid,
  );
  return {
    ...graph,
    nodes,
    comments: [...frames.values(), { ...comment, ...frame }],
  };
}
