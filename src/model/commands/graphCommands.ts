/**
 * Node and connection edits on the authored graphs, including the timeline-track migration tied
 * to a node's `name` param (renaming/removing a Timeline Value carries or prunes its track).
 * Route/comment/attribute/fragment commands live in their own sibling modules; all share the
 * {@link activeGraph}/{@link withGraph} substrate from `graphAccess.Internal`.
 */

import type { GraphConnection, GraphNode, GraphPosition } from "../../domain/graphModel";
import {
  TIMELINE_VALUE_TYPE,
  defaultParametersFor,
  metaFor,
  timelineValueNames,
} from "../../domain/nodePalette";
import { nodeFamily, pruneStaleFamilyComponents } from "../../domain/nodeFamilies";
import { isSink } from "../../domain/sinks";
import { resolveGraphOwner, type SourceState } from "../editorState";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";
import {
  activeGraph,
  bindingMatches,
  kindForSlot,
  withGraph,
  type GraphSlot,
} from "./graphAccess.Internal";

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

/**
 * Sets one parameter on a node (inline editing); committed `"structural"` so the pipeline
 * recomputes, then the emitter view decides rebind vs recompile from the compiled structural hash.
 *
 * `live: true` (an intermediate step of a scrub/drag control, never its final release) applies the
 * same edit through {@link Store.commitLive} instead - a preview the pipeline still recomputes
 * from, but that never touches undo history, so a whole drag gesture costs history exactly one
 * entry (the caller's later, non-live call at the gesture's end) rather than one per step.
 */
export function updateNodeParam(
  store: Store,
  slot: GraphSlot,
  nodeId: string,
  key: string,
  value: unknown,
  live = false,
): void {
  const source = store.getSource();
  const before = activeGraph(source, slot).nodes[nodeId];
  const next = withGraph(source, slot, (graph) => {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      return graph;
    }
    let parameters: Record<string, unknown> = { ...node.parameters, [key]: value };
    // A family facade (combine) reshapes its pins when its `type` changes; drop any component
    // value that no longer fits the new pin shape so the pin reverts to its default rather than
    // showing a coerced stale value the compiler would discard.
    const family = nodeFamily(node.type);
    if (key === family?.typeParamKey) {
      parameters = pruneStaleFamilyComponents(family, parameters);
    }
    const updated: GraphNode = { ...node, parameters };
    return { ...graph, nodes: { ...graph.nodes, [nodeId]: updated } };
  });
  const migrated = migrateRenamedTrack(next, before, key, value);
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
  // Removing the last Timeline Value that referenced a name leaves its timeline track orphaned;
  // drop any track no node feeds any more so a deleted node takes its keyframes with it.
  store.commit(withPrunedTracks(next), "structural");
}

/** Drops each emitter's animation tracks whose param name no `timeline-value` node references. */
function withPrunedTracks(source: SourceState): SourceState {
  return {
    ...source,
    scene: {
      ...source.scene,
      emitters: source.scene.emitters.map((emitter) => {
        const referenced = timelineValueNames([emitter.renderGraph, emitter.behaviorGraph]);
        const tracks = emitter.tracks.filter((track) => referenced.has(track.name));
        return tracks.length === emitter.tracks.length ? emitter : { ...emitter, tracks };
      }),
    },
  };
}

/** Renames `oldName` -> `newName` in a live-params list, if present; otherwise returns it as-is. */
function renameLiveParam(
  names: readonly string[],
  oldName: string,
  newName: string,
): readonly string[] {
  return names.includes(oldName) ? [...names.filter((name) => name !== oldName), newName] : names;
}

/**
 * Renames the active owner's animation track `oldName` -> `newName`, carrying its keyframes and
 * live-param membership along (a live param with no keyframes yet still migrates). No-op if nothing matches.
 */
function withRenamedTrack(source: SourceState, oldName: string, newName: string): SourceState {
  if (oldName === newName) {
    return source;
  }
  const owner = resolveGraphOwner(source.scene);
  if (owner === undefined) {
    return source;
  }
  const rename = <T extends { readonly name: string }>(tracks: readonly T[]): T[] =>
    tracks
      .filter((track) => track.name !== newName)
      .map((track) => (track.name === oldName ? { ...track, name: newName } : track));
  if (owner.kind === "vfxMesh") {
    return {
      ...source,
      scene: {
        ...source.scene,
        meshes: source.scene.meshes.map((mesh) =>
          mesh.id === owner.id &&
          (mesh.tracks.some((track) => track.name === oldName) || mesh.liveParams.includes(oldName))
            ? {
                ...mesh,
                tracks: rename(mesh.tracks),
                liveParams: renameLiveParam(mesh.liveParams, oldName, newName),
              }
            : mesh,
        ),
      },
    };
  }
  return {
    ...source,
    scene: {
      ...source.scene,
      emitters: source.scene.emitters.map((emitter) =>
        emitter.id === owner.id &&
        (emitter.tracks.some((track) => track.name === oldName) ||
          emitter.liveParams.includes(oldName))
          ? {
              ...emitter,
              tracks: rename(emitter.tracks),
              liveParams: renameLiveParam(emitter.liveParams, oldName, newName),
            }
          : emitter,
      ),
    },
  };
}

/**
 * Carries a renamed `timeline-value` node's track to its new `name` (tracks are keyed by name, so
 * otherwise keyframes silently stop applying). No-op for any other node/key, e.g. `texture`'s `name`.
 */
function migrateRenamedTrack(
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
  return withRenamedTrack(source, before.parameters["name"], value);
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
  store.commit(migrateRenamedTrack(next, existing, "name", patch["name"]), "structural");
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

/**
 * Breaks every edge leaving an output socket - the node connections and the sink output
 * bindings fed by it. Used by Alt+Click on an output pin (Unreal-style "break all links").
 */
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
