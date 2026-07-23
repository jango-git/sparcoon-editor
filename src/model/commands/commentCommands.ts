// Comments annotate a region of the graph and never compile, so every edit on them (create, move,
// resize, rename, delete) commits `"view"`: saved and undoable, but never reaches the library.

import type { EditorGraph, GraphComment, GraphPosition, GraphSize } from "../../domain/graphModel";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";
import { withGraph, type GraphSlot } from "./graphAccess.Internal";

/** The current graph's comment list (loadState normalizes an older document's missing field). */
export function comments(graph: EditorGraph): readonly GraphComment[] {
  return graph.comments;
}

/** Adds a comment box, returning its new id. */
export function addComment(
  store: Store,
  slot: GraphSlot,
  position: GraphPosition,
  size: GraphSize,
  text = "Comment",
): string {
  const comment: GraphComment = { id: nextIdentifier("comment"), text, position, size };
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    comments: [...comments(graph), comment],
  }));
  store.commit(next, "view");
  return comment.id;
}

/**
 * Moves a comment and, in the same commit, the nodes/comments it carries along (its enclosed
 * objects) - one history step for the whole drag. No-op if nothing applicable.
 */
export function moveCommentGroup(
  store: Store,
  slot: GraphSlot,
  commentMoves: readonly { readonly id: string; readonly position: GraphPosition }[],
  nodeMoves: readonly { readonly nodeId: string; readonly position: GraphPosition }[] = [],
): void {
  if (commentMoves.length === 0 && nodeMoves.length === 0) {
    return;
  }
  const commentPositions = new Map(commentMoves.map((move) => [move.id, move.position]));
  const nodePositions = new Map(nodeMoves.map((move) => [move.nodeId, move.position]));
  const next = withGraph(store.getSource(), slot, (graph) => {
    const nodes = { ...graph.nodes };
    for (const [id, position] of nodePositions) {
      const existing = nodes[id];
      if (existing !== undefined) {
        nodes[id] = { ...existing, position };
      }
    }
    return {
      ...graph,
      nodes,
      comments: comments(graph).map((comment) => {
        const position = commentPositions.get(comment.id);
        return position !== undefined ? { ...comment, position } : comment;
      }),
    };
  });
  store.commit(next, "view");
}

/** Resizes a comment (and optionally repositions its top-left, for corner drags). */
export function resizeComment(
  store: Store,
  slot: GraphSlot,
  id: string,
  size: GraphSize,
  position?: GraphPosition,
): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    comments: comments(graph).map((comment) =>
      comment.id === id
        ? { ...comment, size, ...(position !== undefined ? { position } : {}) }
        : comment,
    ),
  }));
  store.commit(next, "view");
}

/** Renames a comment's header text (multi-line allowed). */
export function renameComment(store: Store, slot: GraphSlot, id: string, text: string): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    comments: comments(graph).map((comment) =>
      comment.id === id ? { ...comment, text } : comment,
    ),
  }));
  store.commit(next, "view");
}

export function removeComment(store: Store, slot: GraphSlot, id: string): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    comments: comments(graph).filter((comment) => comment.id !== id),
  }));
  store.commit(next, "view");
}
