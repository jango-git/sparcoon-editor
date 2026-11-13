/**
 * One owner's graph as the agent edits it. The handle holds only the address (owner id + graph
 * name) and re-resolves it on every call. Every write first focuses the owner, because the model's
 * graph commands edit the active owner (it is the same thing a click on the object does).
 */

import type { AttributeTypeName, EditorGraph, GraphPosition } from "../domain/graphModel";
import {
  ATTRIBUTE_TYPES,
  isMeshExcludedRenderNode,
  isSinkType,
  isTrailExcludedRenderNode,
  metaFor,
} from "../domain/nodePalette";
import {
  addAttribute,
  addCatalogNode,
  connectSockets,
  disconnectInput,
  moveNodes,
  removeAttribute,
  removeNode,
  replaceNodeParams,
  updateNodeParam,
} from "../model/commands";
import { focusOwner, parseGraphName, resolveGraph, targetGraph } from "./address.Internal";
import { copyPlainData, requireFiniteNumber, requireKnownKeys } from "./arguments.Internal";
import { describeNodeType, type NodeTypeInfo } from "./catalog";
import { AgentError } from "./errors";
import {
  placedNodeMeta,
  requireNode,
  requireParameterKeys,
  requireSocket,
} from "./references.Internal";
import type { EditSession } from "./transaction.Internal";
import { type GraphName, type GraphView, graphView, type SocketAddress } from "./views";

export interface AddNodeOptions {
  readonly params?: Readonly<Record<string, unknown>>;
  /** Graph-space position; omitted, the node is stacked below the graph's existing nodes. */
  readonly position?: GraphPosition;
}

export interface GraphHandle {
  get(): GraphView;
  /** A placed node's sockets and parameters as they are right now (sink slots, attribute slots). */
  describeNode(nodeId: string): NodeTypeInfo;
  /** Adds a node of a catalog type with its default parameters, then `params`. Returns its id. */
  addNode(type: string, options?: AddNodeOptions): string;
  removeNode(nodeId: string): void;
  /**
   * Sets parameters on a node and returns its id. Choosing a `custom-attribute` node's attribute
   * replaces the node (edges kept), so the returned id can differ from `nodeId`; pass the
   * attribute's `name` and `type` together, as the canvas's attribute picker does.
   */
  setParams(nodeId: string, patch: Readonly<Record<string, unknown>>): string;
  moveNodes(
    moves: readonly { readonly id: string; readonly x: number; readonly y: number }[],
  ): void;
  /** Wires an output into an input, replacing what fed it. Sink inputs are the graph's outputs. */
  connect(from: SocketAddress, to: SocketAddress): void;
  /** Breaks the wire feeding an input (no-op when nothing feeds it). */
  disconnect(to: SocketAddress): void;
  /** Declares a per-particle attribute (behavior graph only). */
  addAttribute(name: string, type: AttributeTypeName): void;
  removeAttribute(name: string): void;
}

/** Vertical spacing between auto-placed nodes, in graph units. */
const AUTO_PLACE_STEP = 192;
const AUTO_PLACE_ORIGIN: GraphPosition = { x: 168, y: 72 };

/** Below the lowest non-sink node, in the column of the leftmost one. */
function autoPosition(graph: EditorGraph): GraphPosition {
  const placed = Object.values(graph.nodes).filter((node) => !isSinkType(node.type));
  if (placed.length === 0) {
    return AUTO_PLACE_ORIGIN;
  }
  return {
    x: Math.min(...placed.map((node) => node.position.x)),
    y: Math.max(...placed.map((node) => node.position.y)) + AUTO_PLACE_STEP,
  };
}

function requirePosition(position: GraphPosition): GraphPosition {
  return {
    x: requireFiniteNumber("position.x", position.x),
    y: requireFiniteNumber("position.y", position.y),
  };
}

export function createGraphHandle(
  session: EditSession,
  ownerId: string,
  graphName: string,
): GraphHandle {
  const graph: GraphName = parseGraphName(graphName);
  // Fail fast on a bad address; every call still re-resolves (the owner may go away later).
  resolveGraph(session.source(), ownerId, graph);

  const requireBehavior = (): void => {
    if (graph !== "behavior") {
      throw new AgentError("invalid_argument", "Attributes live on the behavior graph.");
    }
  };

  return {
    get: () => graphView(session.source(), resolveGraph(session.source(), ownerId, graph)),

    describeNode: (nodeId): NodeTypeInfo => {
      const source = session.source();
      const target = resolveGraph(source, ownerId, graph);
      const authored = targetGraph(source, target);
      return describeNodeType(
        placedNodeMeta(source, target, authored, requireNode(authored, nodeId)),
      );
    },

    addNode: (type, options = {}) =>
      session.mutate((store) => {
        const target = resolveGraph(store.getSource(), ownerId, graph);
        const metadata = metaFor(target.kind, type);
        if (metadata === undefined) {
          throw new AgentError("not_found", `No node type "${type}" in the ${graph} graph.`);
        }
        if (target.host === "mesh" && isMeshExcludedRenderNode(metadata)) {
          throw new AgentError("invalid_argument", `Node type "${type}" needs a particle host.`);
        }
        if (target.host === "trail" && isTrailExcludedRenderNode(metadata)) {
          throw new AgentError(
            "invalid_argument",
            `Node type "${type}" reads a surface normal, which a trail does not have.`,
          );
        }
        requireKnownKeys("options", options, ["params", "position"]);
        const params = copyPlainData("params", options.params ?? {});
        const position =
          options.position !== undefined
            ? requirePosition(options.position)
            : autoPosition(targetGraph(store.getSource(), target));
        requireParameterKeys(metadata, params);
        focusOwner(store, target.owner);
        const id = addCatalogNode(store, target.slot, type, position);
        if (id === undefined) {
          throw new AgentError("rejected", `Node type "${type}" could not be added.`);
        }
        // A node created in this same transaction never reached the engine under its id, so even
        // an attribute choice can be set in place here.
        for (const [key, value] of Object.entries(params)) {
          updateNodeParam(store, target.slot, id, key, value);
        }
        return id;
      }),

    removeNode: (nodeId) =>
      session.mutate((store) => {
        const target = resolveGraph(store.getSource(), ownerId, graph);
        const node = requireNode(targetGraph(store.getSource(), target), nodeId);
        if (isSinkType(node.type)) {
          throw new AgentError("rejected", `Node "${nodeId}" is a sink and cannot be removed.`);
        }
        focusOwner(store, target.owner);
        removeNode(store, target.slot, nodeId);
      }),

    setParams: (nodeId, requested) =>
      session.mutate((store) => {
        const patch = copyPlainData("patch", requested);
        const source = store.getSource();
        const target = resolveGraph(source, ownerId, graph);
        const authored = targetGraph(source, target);
        const node = requireNode(authored, nodeId);
        const metadata = placedNodeMeta(source, target, authored, node);
        requireParameterKeys(metadata, patch);
        focusOwner(store, target.owner);
        // Same policy as the canvas's attribute picker: the attribute choice can't change under a
        // stable id, so it replaces the node - for an inherited attribute, its source and type too.
        const pickers = (metadata.customParams ?? []).filter(
          (parameter) => parameter.kind === "attribute-name" || parameter.kind === "inherit-source",
        );
        const attributeKeys = [
          ...pickers.map((parameter) => parameter.key),
          ...(pickers.some((parameter) => parameter.kind === "inherit-source")
            ? Object.entries(metadata.params)
                .filter(([, parameter]) => parameter.kind === "structural")
                .map(([key]) => key)
            : []),
        ];
        if (attributeKeys.some((key) => key in patch)) {
          const newId = replaceNodeParams(store, target.slot, nodeId, patch);
          if (newId === undefined) {
            throw new AgentError("rejected", `Node "${nodeId}" could not be updated.`);
          }
          return newId;
        }
        for (const [key, value] of Object.entries(patch)) {
          updateNodeParam(store, target.slot, nodeId, key, value);
        }
        return nodeId;
      }),

    moveNodes: (moves) =>
      session.mutate((store) => {
        const target = resolveGraph(store.getSource(), ownerId, graph);
        const authored = targetGraph(store.getSource(), target);
        const checked = moves.map((move) => ({
          nodeId: requireNode(authored, move.id).id,
          position: requirePosition(move),
        }));
        focusOwner(store, target.owner);
        moveNodes(store, target.slot, checked);
      }),

    connect: (from, to) =>
      session.mutate((store) => {
        const source = store.getSource();
        const target = resolveGraph(source, ownerId, graph);
        const authored = targetGraph(source, target);
        const output = requireSocket(source, target, authored, from, "output");
        const input = requireSocket(source, target, authored, to, "input");
        focusOwner(store, target.owner);
        connectSockets(store, target.slot, output, input);
      }),

    disconnect: (to) =>
      session.mutate((store) => {
        const source = store.getSource();
        const target = resolveGraph(source, ownerId, graph);
        const input = requireSocket(source, target, targetGraph(source, target), to, "input");
        focusOwner(store, target.owner);
        disconnectInput(store, target.slot, input);
      }),

    addAttribute: (name, type) =>
      session.mutate((store) => {
        requireBehavior();
        if (!ATTRIBUTE_TYPES.includes(type)) {
          throw new AgentError(
            "invalid_argument",
            `Attribute type must be one of ${ATTRIBUTE_TYPES.join(", ")}.`,
          );
        }
        const target = resolveGraph(store.getSource(), ownerId, graph);
        focusOwner(store, target.owner);
        if (!addAttribute(store, target.slot, name, type)) {
          throw new AgentError(
            "rejected",
            `Attribute "${name}" was not added (invalid, reserved or already declared).`,
          );
        }
      }),

    removeAttribute: (name) =>
      session.mutate((store) => {
        requireBehavior();
        const target = resolveGraph(store.getSource(), ownerId, graph);
        if (
          !targetGraph(store.getSource(), target).attributes.some(
            (attribute) => attribute.name === name,
          )
        ) {
          throw new AgentError("not_found", `No attribute "${name}" on this graph.`);
        }
        focusOwner(store, target.owner);
        removeAttribute(store, target.slot, name);
      }),
  };
}
