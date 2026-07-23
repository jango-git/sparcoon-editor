import type {
  GraphComment,
  GraphConnection,
  GraphNode,
  GraphPosition,
  GraphSocketReference,
} from "../../domain/graphModel";
import { isMeshExcludedRenderNode, metaFor } from "../../domain/nodePalette";
import { ROUTE_TYPE } from "../../domain/fakeNodes";
import { isSink } from "../../domain/sinks";
import { resolveGraphOwner } from "../editorState";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";
import { comments } from "./commentCommands";
import { kindForSlot, withGraph, type GraphSlot } from "./graphAccess.Internal";

/** A detached fragment of a graph - cloned nodes, their internal edges, and comments. */
export interface GraphFragment {
  readonly nodes: readonly GraphNode[];
  readonly connections: readonly GraphConnection[];
  readonly comments: readonly GraphComment[];
}

/**
 * Pastes a fragment as fresh nodes/comments (newly minted ids, so it's a structural clone, never
 * a reference to the originals), shifted by `offset`; edges with no in-fragment endpoint are dropped.
 */
export function pasteFragment(
  store: Store,
  slot: GraphSlot,
  fragment: GraphFragment,
  offset: GraphPosition,
): { readonly nodeIds: readonly string[]; readonly commentIds: readonly string[] } {
  // A VFX mesh is render-only, so a particle-only/attribute-dynamic node would only ever error
  // there; the add-node menu hides these via `isMeshExcludedRenderNode` - paste needs the same gate.
  const pastingIntoMeshRender =
    slot === "renderGraph" && resolveGraphOwner(store.getSource().scene)?.kind === "vfxMesh";
  const eligible = (node: GraphNode): boolean => {
    if (!pastingIntoMeshRender) {
      return true;
    }
    const metadata = metaFor(kindForSlot(slot), node.type);
    return metadata === undefined || !isMeshExcludedRenderNode(metadata);
  };
  // Old id => fresh id, so the copied edges can be rewired onto the pasted nodes.
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = fragment.nodes
    // A sink must never be pasted: it would mint a non-reserved id carrying a sink type - an
    // undeletable phantom sink. The copy side excludes sinks; this is the paste-side guard.
    .filter((node) => !isSink(node) && eligible(node))
    .map((node) => {
      const id = nextIdentifier(node.type === ROUTE_TYPE ? "route" : "node");
      idMap.set(node.id, id);
      return {
        ...structuredClone(node),
        id,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      };
    });
  const remap = (ref: GraphSocketReference, nodeId: string): GraphSocketReference => ({
    ...ref,
    nodeId,
  });
  // Both endpoints must resolve through idMap (an edge with a dropped endpoint is not a valid
  // fragment edge); the lookup above doubles as the has-check so control flow proves non-null.
  const connections: GraphConnection[] = fragment.connections.flatMap((connection) => {
    const fromId = idMap.get(connection.from.nodeId);
    const toId = idMap.get(connection.to.nodeId);
    if (fromId === undefined || toId === undefined) {
      return [];
    }
    return [
      {
        id: nextIdentifier("conn"),
        from: remap(connection.from, fromId),
        to: remap(connection.to, toId),
      },
    ];
  });
  const pastedComments: GraphComment[] = fragment.comments.map((comment) => ({
    ...structuredClone(comment),
    id: nextIdentifier("comment"),
    position: { x: comment.position.x + offset.x, y: comment.position.y + offset.y },
  }));

  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    nodes: { ...graph.nodes, ...Object.fromEntries(nodes.map((node) => [node.id, node])) },
    connections: [...graph.connections, ...connections],
    comments: [...comments(graph), ...pastedComments],
  }));
  store.commit(next, "structural");
  return {
    nodeIds: nodes.map((node) => node.id),
    commentIds: pastedComments.map((comment) => comment.id),
  };
}
