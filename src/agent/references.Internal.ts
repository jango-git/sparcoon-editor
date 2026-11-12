/**
 * Reference checks for agent edits: does the node exist, does it have that socket, does it take
 * that parameter key. The model commands silently skip an edit whose target is missing, so these
 * checks are what turn a typo into an error. Values are not checked here; the engine validates
 * parameter values and wire types and reports problems through the compile status.
 */

import type { EditorGraph, GraphNode, GraphSocketReference } from "../domain/graphModel";
import { nodeFamily } from "../domain/nodeFamilies";
import { type FXNodeMeta, type FXSocketMeta, metaForNode } from "../domain/nodePalette";
import type { SourceState } from "../model/editorState";
import type { GraphTarget } from "./address.Internal";
import { AgentError } from "./errors";
import type { SocketAddress } from "./views";

export function requireNode(graph: EditorGraph, nodeId: string): GraphNode {
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    throw new AgentError("not_found", `No node "${nodeId}" in this graph.`);
  }
  return node;
}

/** A placed node's metadata, shaped as the canvas shapes it (sink slots, host, mesh assets). */
export function placedNodeMeta(
  source: SourceState,
  target: GraphTarget,
  graph: EditorGraph,
  node: GraphNode,
): FXNodeMeta {
  const metadata = metaForNode(
    target.kind,
    node,
    graph.attributes,
    target.host,
    source.meshAssets.map((asset) => asset.name),
  );
  if (metadata === undefined) {
    throw new AgentError("not_found", `Node "${node.id}" has unknown type "${node.type}".`);
  }
  return metadata;
}

/**
 * Every socket a node of `metadata`'s type can expose on `side`. A family facade (combine/split)
 * reshapes its sockets by resolved type, so it accepts the keys of any of its variants.
 */
function socketsOf(metadata: FXNodeMeta, side: "input" | "output"): readonly FXSocketMeta[] {
  const own = side === "input" ? metadata.inputs : metadata.outputs;
  const family = nodeFamily(metadata.type);
  if (family === undefined) {
    return own;
  }
  const variants = [undefined, ...family.options].map((option) => family.sockets(option));
  return [
    ...own,
    ...variants.flatMap((variant) => (side === "input" ? variant.inputs : variant.outputs)),
  ];
}

/** Resolves `address` to a socket reference, checking the node exists and has that socket. */
export function requireSocket(
  source: SourceState,
  target: GraphTarget,
  graph: EditorGraph,
  address: SocketAddress,
  side: "input" | "output",
): GraphSocketReference {
  const node = requireNode(graph, address.node);
  const sockets = socketsOf(placedNodeMeta(source, target, graph, node), side);
  if (!sockets.some((socket) => socket.key === address.socket)) {
    const known = [...new Set(sockets.map((socket) => socket.key))].join(", ");
    throw new AgentError(
      "not_found",
      `Node "${node.id}" (${node.type}) has no ${side} "${address.socket}". Known: ${known || "none"}.`,
    );
  }
  return { nodeId: node.id, socketKey: address.socket };
}

/**
 * The parameter keys a node of `metadata`'s type stores: its schema params, its custom params
 * (texture, gradient, names), the inline values of its editable input sockets, and the
 * synthesized `stage`/`phase` of a node that leaves either to a param (`"param"` in its metadata).
 */
function parameterKeysOf(metadata: FXNodeMeta): ReadonlySet<string> {
  return new Set([
    ...Object.keys(metadata.params),
    ...(metadata.stage === "param" ? ["stage"] : []),
    ...(metadata.phase === "param" ? ["phase"] : []),
    ...(metadata.customParams ?? []).map((parameter) => parameter.key),
    ...socketsOf(metadata, "input")
      .filter((socket) => socket.control !== undefined)
      .map((socket) => socket.key),
  ]);
}

/** Checks every key of `patch` is a parameter a node of `metadata`'s type stores. */
export function requireParameterKeys(
  metadata: FXNodeMeta,
  patch: Readonly<Record<string, unknown>>,
): void {
  const keys = parameterKeysOf(metadata);
  const unknown = Object.keys(patch).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    throw new AgentError(
      "invalid_argument",
      `Node type "${metadata.type}" has no parameter ${unknown.map((key) => `"${key}"`).join(", ")}. ` +
        `Known: ${[...keys].join(", ") || "none"}.`,
    );
  }
}
