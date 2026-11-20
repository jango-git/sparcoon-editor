/** Node and connection edits on the authored graphs. */

import type { GraphConnection, GraphNode, GraphPosition } from "../../domain/graphModel";
import { nodeFamily, pruneStaleFamilyComponents } from "../../domain/nodeFamilies";
import { defaultParametersFor, metaFor, TIMELINE_VALUE_TYPE } from "../../domain/nodePalette";
import { isSink } from "../../domain/sinks";
import { volumeDescriptionPatch } from "../assetDescription";
import { emitterGraphs, meshGraphs, resolveGraphOwner, type SourceState } from "../editorState";
import type { Store } from "../store";
import { withPrunedTimelineValues, withRenamedTimelineValue } from "../timelineValues";
import {
  activeGraph,
  bindingMatches,
  type GraphSlot,
  kindForSlot,
  withGraph,
} from "./graphAccess.Internal";
import { nextIdentifier } from "./identifier";

/**
 * Creates a node of a catalog `type` at `position` with its default parameters and
 * adds it to the graph. Returns the new node id, or `undefined` for an unknown type.
 */
export function addCatalogNode(
  store: Store,
  slot: GraphSlot,
  type: string,
  position: GraphPosition,
): string | undefined {
  const metadata = metaFor(kindForSlot(slot), type);
  if (metadata === undefined) {
    return undefined;
  }
  const node: GraphNode = {
    id: nextIdentifier("node"),
    type,
    parameters: structuredClone(defaultParametersFor(metadata)),
    position,
  };
  addNode(store, slot, node);
  return node.id;
}

export function updateNodeParam(
  store: Store,
  slot: GraphSlot,
  nodeId: string,
  key: string,
  value: unknown,
  live = false,
): void {
  updateNodeParams(store, slot, nodeId, { [key]: value }, live);
}

/**
 * Sets node parameters in one structural edit. Picking a volume asset also sets the inputs it
 * describes (see {@link volumeDescriptionPatch}) unless the patch sets them.
 *
 * `live: true` applies the edit through {@link Store.commitLive}, without an undo entry, so a drag
 * gesture costs one entry (its final non-live call).
 */
export function updateNodeParams(
  store: Store,
  slot: GraphSlot,
  nodeId: string,
  patch: Readonly<Record<string, unknown>>,
  live = false,
): void {
  const source = store.getSource();
  const before = activeGraph(source, slot).nodes[nodeId];
  const applied =
    before === undefined
      ? patch
      : { ...volumeDescriptionPatch(source, kindForSlot(slot), before, patch), ...patch };
  const next = withGraph(source, slot, (graph) => {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      return graph;
    }
    let parameters: Record<string, unknown> = { ...node.parameters, ...applied };
    // A family facade (combine) reshapes its pins when its `type` changes; drop any component
    // value that no longer fits the new pin shape so the pin reverts to its default rather than
    // showing a coerced stale value the compiler would discard.
    const family = nodeFamily(node.type);
    if (family?.typeParamKey !== undefined && family.typeParamKey in applied) {
      parameters = pruneStaleFamilyComponents(family, parameters);
    }
    const updated: GraphNode = { ...node, parameters };
    return { ...graph, nodes: { ...graph.nodes, [nodeId]: updated } };
  });
  const migrated = migrateRenamedValue(next, before, "name", applied["name"]);
  if (live) {
    store.commitLive(migrated, "structural");
  } else {
    store.commit(migrated, "structural");
  }
}

export function addNode(store: Store, slot: GraphSlot, node: GraphNode): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    nodes: { ...graph.nodes, [node.id]: node },
  }));
  store.commit(next, "structural");
}

export function removeNode(store: Store, slot: GraphSlot, nodeId: string): void {
  // Sinks are permanent - never removed, even if a caller selects and deletes one.
  if (isSink(activeGraph(store.getSource(), slot).nodes[nodeId])) {
    return;
  }
  const next = withGraph(store.getSource(), slot, (graph) => {
    const nodes = { ...graph.nodes };
    delete nodes[nodeId];
    return {
      ...graph,
      nodes,
      connections: graph.connections.filter(
        (connection) => connection.from.nodeId !== nodeId && connection.to.nodeId !== nodeId,
      ),
      outputBindings: graph.outputBindings.filter((binding) => binding.from.nodeId !== nodeId),
    };
  });
  store.commit(withPrunedTimelineValues(next), "structural");
}

/** {@link withRenamedTimelineValue} on the active graph owner, whose graphs `source` already renamed. */
function withRenamedOwnerValue(source: SourceState, oldName: string, newName: string): SourceState {
  const owner = resolveGraphOwner(source.scene);
  if (owner === undefined) {
    return source;
  }
  const { scene } = source;
  if (owner.kind === "vfxMesh") {
    const meshes = scene.meshes.map((mesh) =>
      mesh.id === owner.id
        ? withRenamedTimelineValue(mesh, meshGraphs(mesh), oldName, newName)
        : mesh,
    );
    return { ...source, scene: { ...scene, meshes } };
  }
  const emitters = scene.emitters.map((emitter) =>
    emitter.id === owner.id
      ? withRenamedTimelineValue(emitter, emitterGraphs(emitter), oldName, newName)
      : emitter,
  );
  return { ...source, scene: { ...scene, emitters } };
}

/**
 * Carries a renamed `timeline-value` node's keyframes and live flag to its new `name` (both are keyed
 * by name) and drops what no node declares any more. No-op for any other node/key, e.g. `texture`'s `name`.
 */
function migrateRenamedValue(
  source: SourceState,
  before: GraphNode | undefined,
  key: string,
  value: unknown,
): SourceState {
  if (
    before?.type !== TIMELINE_VALUE_TYPE ||
    key !== "name" ||
    typeof before.parameters["name"] !== "string" ||
    typeof value !== "string"
  ) {
    return source;
  }
  return withPrunedTimelineValues(withRenamedOwnerValue(source, before.parameters["name"], value));
}

/**
 * Replaces a node with a fresh-id copy carrying `patch`ed params, remapping its edges - used when
 * a param (e.g. `custom-attribute`'s attribute) can't change in place under a stable id. Returns the new id.
 */
export function replaceNodeParams(
  store: Store,
  slot: GraphSlot,
  nodeId: string,
  patch: Readonly<Record<string, unknown>>,
): string | undefined {
  const source = store.getSource();
  const existing = activeGraph(source, slot).nodes[nodeId];
  if (existing === undefined || isSink(existing)) {
    return undefined;
  }
  const newId = nextIdentifier("node");
  const replacement: GraphNode = {
    ...existing,
    id: newId,
    parameters: { ...existing.parameters, ...patch },
  };
  const remapRef = <T extends { nodeId: string }>(ref: T): T =>
    ref.nodeId === nodeId ? { ...ref, nodeId: newId } : ref;
  const next = withGraph(source, slot, (graph) => {
    const nodes = { ...graph.nodes };
    delete nodes[nodeId];
    nodes[newId] = replacement;
    return {
      ...graph,
      nodes,
      connections: graph.connections.map((connection) => ({
        ...connection,
        from: remapRef(connection.from),
        to: remapRef(connection.to),
      })),
      outputBindings: graph.outputBindings.map((binding) => ({
        ...binding,
        from: remapRef(binding.from),
      })),
    };
  });
  store.commit(migrateRenamedValue(next, existing, "name", patch["name"]), "structural");
  return newId;
}

/**
 * Moves several nodes in a single commit - one history step for a whole group drag.
 * Nodes no longer in the graph are skipped; a no-op (nothing applicable) commits nothing.
 */
export function moveNodes(
  store: Store,
  slot: GraphSlot,
  moves: readonly { readonly nodeId: string; readonly position: GraphPosition }[],
): void {
  const source = store.getSource();
  const graph = activeGraph(source, slot);
  const applicable = moves.filter((move) => graph.nodes[move.nodeId] !== undefined);
  if (applicable.length === 0) {
    return;
  }
  const next = withGraph(source, slot, (target) => {
    const nodes = { ...target.nodes };
    for (const move of applicable) {
      const existing = nodes[move.nodeId];
      if (existing !== undefined) {
        nodes[move.nodeId] = { ...existing, position: move.position };
      }
    }
    return { ...target, nodes };
  });
  store.commit(next, "view");
}

/**
 * Wires an output socket into a node's input socket. An input holds at most one edge, so
 * any existing connection into the same `to` socket is replaced (drag-to-reconnect).
 */
export function addConnection(store: Store, slot: GraphSlot, connection: GraphConnection): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    connections: [
      ...graph.connections.filter(
        (existing) =>
          existing.to.nodeId !== connection.to.nodeId ||
          existing.to.socketKey !== connection.to.socketKey,
      ),
      connection,
    ],
  }));
  store.commit(next, "structural");
}

export function removeConnection(store: Store, slot: GraphSlot, connectionId: string): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    connections: graph.connections.filter((connection) => connection.id !== connectionId),
  }));
  store.commit(next, "structural");
}

/** Breaks every edge leaving an output socket: node connections and sink output bindings. */
export function removeEdgesFromOutput(
  store: Store,
  slot: GraphSlot,
  nodeId: string,
  socketKey: string,
): void {
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    connections: graph.connections.filter(
      (connection) => connection.from.nodeId !== nodeId || connection.from.socketKey !== socketKey,
    ),
    outputBindings: graph.outputBindings.filter(
      (binding) => binding.from.nodeId !== nodeId || binding.from.socketKey !== socketKey,
    ),
  }));
  store.commit(next, "structural");
}

/**
 * Removes several edges - node connections (by id) and sink output bindings (by slot+phase)
 * - in a single structural commit, so a knife-cut across many wires is one history step.
 */
export function removeEdges(
  store: Store,
  slot: GraphSlot,
  edges: {
    readonly connectionIds?: readonly string[];
    readonly bindings?: readonly {
      readonly slot: string;
      readonly phase: "spawn" | "update" | undefined;
    }[];
  },
): void {
  const connectionIds = new Set(edges.connectionIds ?? []);
  const bindings = edges.bindings ?? [];
  if (connectionIds.size === 0 && bindings.length === 0) {
    return;
  }
  const next = withGraph(store.getSource(), slot, (graph) => ({
    ...graph,
    connections: graph.connections.filter((connection) => !connectionIds.has(connection.id)),
    outputBindings: graph.outputBindings.filter(
      (binding) =>
        !bindings.some((requested) => bindingMatches(binding, requested.slot, requested.phase)),
    ),
  }));
  store.commit(next, "structural");
}
