/**
 * The unified edge view over an authored graph: an input socket is fed either by a node-to-node
 * {@link GraphConnection} or - when the input belongs to a reserved sink - by a
 * {@link GraphOutputBinding}. Everything that needs "the edge into this input" (the canvas, the
 * agent API, the edge commands) resolves it here, so the connection/binding split has one owner.
 */

import { incomingConnection, type EditorGraph, type GraphSocketReference } from "./graphModel";
import { GraphKind } from "./nodePalette";
import { isSinkType, RENDER_SINK_ID, sinkPhase, SPAWN_SINK_ID, UPDATE_SINK_ID } from "./sinkMeta";

/** The edge feeding one input socket: a node connection (by id) or a sink output binding. */
export type IncomingEdge =
  | { readonly kind: "connection"; readonly id: string; readonly from: GraphSocketReference }
  | {
      readonly kind: "binding";
      readonly slot: string;
      readonly phase: "spawn" | "update" | undefined;
      readonly from: GraphSocketReference;
    };

/** The edge feeding `input` (a sink binding or a node connection), if any. */
export function findIncomingEdge(
  graph: EditorGraph,
  input: GraphSocketReference,
): IncomingEdge | undefined {
  const node = graph.nodes[input.nodeId];
  if (node === undefined) {
    return undefined;
  }
  if (isSinkType(node.type)) {
    const phase = sinkPhase(node.type);
    const binding = graph.outputBindings.find(
      (candidate) => candidate.slot === input.socketKey && candidate.phase === phase,
    );
    return binding === undefined
      ? undefined
      : { kind: "binding", slot: binding.slot, phase, from: binding.from };
  }
  const connection = incomingConnection(graph, input.nodeId, input.socketKey);
  return connection === undefined
    ? undefined
    : { kind: "connection", id: connection.id, from: connection.from };
}

/** The reserved sink node id an output binding targets (by phase) in a graph of `kind`. */
export function bindingSinkId(
  kind: GraphKind,
  binding: { readonly phase?: "spawn" | "update" | undefined },
): string {
  if (kind === GraphKind.Render) {
    return RENDER_SINK_ID;
  }
  return binding.phase === "spawn" ? SPAWN_SINK_ID : UPDATE_SINK_ID;
}
