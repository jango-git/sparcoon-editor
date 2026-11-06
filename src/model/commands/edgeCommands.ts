/**
 * Socket-level edge authoring: wires an output into an input, or breaks the edge into an input,
 * choosing between a node connection and a sink output binding by what the input belongs to (see
 * `domain/graphEdges.ts`). The canvas's drag-to-wire and the agent API both go through here.
 */

import { findIncomingEdge } from "../../domain/graphEdges";
import type { GraphSocketReference } from "../../domain/graphModel";
import { isSinkType, sinkPhase } from "../../domain/nodePalette";
import type { Store } from "../store";
import { activeGraph, type GraphSlot } from "./graphAccess.Internal";
import { addConnection, removeConnection } from "./graphCommands";
import { nextIdentifier } from "./identifier";
import { addOutputBinding, removeOutputBinding } from "./routeCommands";

/**
 * Authors the edge for `output` -> `input`: an output binding when `input` is a sink slot, else a
 * node connection. Either replaces whatever fed `input` before. No-op for an unknown input node.
 */
export function connectSockets(
  store: Store,
  slot: GraphSlot,
  output: GraphSocketReference,
  input: GraphSocketReference,
): void {
  const inputNode = activeGraph(store.getSource(), slot).nodes[input.nodeId];
  if (inputNode === undefined) {
    return;
  }
  const from: GraphSocketReference = { nodeId: output.nodeId, socketKey: output.socketKey };
  if (isSinkType(inputNode.type)) {
    const phase = sinkPhase(inputNode.type);
    addOutputBinding(store, slot, {
      slot: input.socketKey,
      from,
      ...(phase !== undefined ? { phase } : {}),
    });
    return;
  }
  addConnection(store, slot, {
    id: nextIdentifier("conn"),
    from,
    to: { nodeId: input.nodeId, socketKey: input.socketKey },
  });
}

/** Breaks the single edge feeding `input` (a connection or a sink binding). No-op when unfed. */
export function disconnectInput(store: Store, slot: GraphSlot, input: GraphSocketReference): void {
  const incoming = findIncomingEdge(activeGraph(store.getSource(), slot), input);
  if (incoming === undefined) {
    return;
  }
  if (incoming.kind === "connection") {
    removeConnection(store, slot, incoming.id);
  } else {
    removeOutputBinding(store, slot, incoming.slot, incoming.phase);
  }
}
