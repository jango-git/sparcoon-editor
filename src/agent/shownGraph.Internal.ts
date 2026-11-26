/**
 * The agent's edits of a graph as drawn: `arrange()` and `comment()` measure the cards on the live
 * canvas, so the editor first shows the graph - its owner focused without an undo step (as a status
 * read does), the graph switched to - and the edit itself is the one undo step.
 */

import type { CommentMembers } from "../domain/layout/commentGather";
import type { GraphName } from "../model/graphSlots";
import type { Store } from "../model/store";
import { focusOwner, parseGraphName, resolveGraph, targetGraph } from "./address.Internal";
import { AgentError } from "./errors";
import { requireNode } from "./references.Internal";
import { runUnrecorded } from "./transaction.Internal";

/** A graph shown on the canvas, with the edits that measure its cards as drawn. */
export interface GraphOnCanvas {
  arrange(): void;
  gatherIntoComment(text: string, members: CommentMembers): string;
}

export type ShowGraph = (name: GraphName) => GraphOnCanvas;

/** Shows `ownerId`'s `graph` on the canvas. */
function showOwnerGraph(
  store: Store,
  showGraph: ShowGraph,
  ownerId: string,
  graph: string,
): GraphOnCanvas {
  const target = resolveGraph(store.getSource(), ownerId, parseGraphName(graph));
  runUnrecorded(store, (staging) => focusOwner(staging, target.owner));
  return showGraph(target.name);
}

export function arrangeOwnerGraph(
  store: Store,
  showGraph: ShowGraph,
  ownerId: string,
  graph: string,
): void {
  showOwnerGraph(store, showGraph, ownerId, graph).arrange();
}

export function commentOwnerGraph(
  store: Store,
  showGraph: ShowGraph,
  ownerId: string,
  graph: string,
  text: string,
  members: { readonly nodes?: readonly string[]; readonly comments?: readonly string[] },
): string {
  if (typeof text !== "string" || text.trim() === "") {
    throw new AgentError("invalid_argument", "A comment needs a text.");
  }
  const nodes = members.nodes ?? [];
  const comments = members.comments ?? [];
  if (nodes.length + comments.length === 0) {
    throw new AgentError("invalid_argument", "A comment needs a node or a comment to hold.");
  }
  const source = store.getSource();
  const edited = targetGraph(source, resolveGraph(source, ownerId, parseGraphName(graph)));
  for (const nodeId of nodes) {
    requireNode(edited, nodeId);
  }
  for (const commentId of comments) {
    if (!edited.comments.some((comment) => comment.id === commentId)) {
      throw new AgentError("not_found", `No comment "${commentId}" in this graph.`);
    }
  }
  return showOwnerGraph(store, showGraph, ownerId, graph).gatherIntoComment(text, {
    nodes,
    comments,
  });
}
