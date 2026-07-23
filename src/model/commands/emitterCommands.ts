/**
 * Emitter-level edits: add/remove/select commit `"structural"` (scene + graph-editor target
 * change); rename commits `"view"` (a name never recompiles) - mirrors {@link renameVfxMesh}.
 */

import type { EditorGraph, GraphNode } from "../../domain/graphModel";
import { isSink } from "../../domain/sinks";
import { createDefaultEmitter, type EmitterDoc, type SceneModel } from "../editorState";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";

/**
 * Re-mints every node/connection/comment id in `graph` (sinks keep their fixed ids), remapping
 * refs - a fresh emitter reuses the default template, so without this its ids (`n_albedo`, ...) would collide.
 */
export function withFreshIds(graph: EditorGraph): EditorGraph {
  const idMap = new Map<string, string>();
  const nodes: Record<string, GraphNode> = {};
  for (const node of Object.values(graph.nodes)) {
    const id = isSink(node) ? node.id : nextIdentifier("node");
    idMap.set(node.id, id);
    nodes[id] = { ...node, id };
  }
  const remap = (nodeId: string): string => idMap.get(nodeId) ?? nodeId;
  return {
    ...graph,
    nodes,
    connections: graph.connections.map((connection) => ({
      ...connection,
      id: nextIdentifier("conn"),
      from: { ...connection.from, nodeId: remap(connection.from.nodeId) },
      to: { ...connection.to, nodeId: remap(connection.to.nodeId) },
    })),
    outputBindings: graph.outputBindings.map((binding) => ({
      ...binding,
      from: { ...binding.from, nodeId: remap(binding.from.nodeId) },
    })),
    comments: graph.comments.map((comment) => ({ ...comment, id: nextIdentifier("comment") })),
  };
}

/** Commits `scene` as the source's new scene, leaving the rest of the document untouched. */
function commitScene(store: Store, scene: SceneModel, kind: "structural" | "view"): void {
  store.commit({ ...store.getSource(), scene }, kind);
}

/**
 * Adds a fresh emitter (seeded with the default visible effect, its own freshly-minted node
 * ids) to the end of the scene and makes it the active one. Returns the new emitter's id.
 */
export function addEmitter(store: Store): string {
  const scene = store.getSource().scene;
  const id = nextIdentifier("emitter");
  const seed = createDefaultEmitter(id, uniqueName(scene.emitters));
  const emitter: EmitterDoc = {
    ...seed,
    renderGraph: withFreshIds(seed.renderGraph),
    behaviorGraph: withFreshIds(seed.behaviorGraph),
    // The seed's default event carries a literal id; re-mint it so emitters never share one.
    events: seed.events.map((event) => ({ ...event, id: nextIdentifier("event") })),
  };
  commitScene(
    store,
    {
      ...scene,
      emitters: [...scene.emitters, emitter],
      activeEmitterId: id,
      activeGraphKind: "emitter",
    },
    "structural",
  );
  return id;
}

/**
 * Removes emitter `id` (no-op if it's the last one, or unknown). If it was active, selection
 * falls to its neighbour (the previous emitter, or the new head if it was first).
 */
export function removeEmitter(store: Store, id: string): void {
  const scene = store.getSource().scene;
  if (scene.emitters.length <= 1) {
    return;
  }
  const index = scene.emitters.findIndex((emitter) => emitter.id === id);
  if (index === -1) {
    return;
  }
  const emitters = scene.emitters.filter((emitter) => emitter.id !== id);
  const [firstEmitter] = emitters;
  if (firstEmitter === undefined) {
    // scene.emitters.length > 1 was checked above and exactly one was removed.
    throw new Error("removeEmitter: no emitters remain after removal");
  }
  const activeEmitterId =
    scene.activeEmitterId === id ? (emitters[index - 1] ?? firstEmitter).id : scene.activeEmitterId;
  commitScene(store, { ...scene, emitters, activeEmitterId }, "structural");
}

/**
 * Toggles emitter `id`'s outline/preview visibility. Editor-only (never reaches the TS export),
 * so it commits as a view edit; {@link SceneEmitters.applySceneTransforms} applies it. No-op if unknown.
 */
export function toggleEmitterHidden(store: Store, id: string): void {
  const scene = store.getSource().scene;
  if (!scene.emitters.some((emitter) => emitter.id === id)) {
    return;
  }
  commitScene(
    store,
    {
      ...scene,
      emitters: scene.emitters.map((emitter) =>
        emitter.id === id ? { ...emitter, hidden: emitter.hidden !== true } : emitter,
      ),
    },
    "view",
  );
}

/** Targets emitter `id` for graph editing and preview focus (makes it - not a mesh - the active graph owner). No-op if already active or unknown. */
export function selectEmitter(store: Store, id: string): void {
  const scene = store.getSource().scene;
  const alreadyActive = scene.activeEmitterId === id && scene.activeGraphKind === "emitter";
  if (alreadyActive || !scene.emitters.some((emitter) => emitter.id === id)) {
    return;
  }
  commitScene(store, { ...scene, activeEmitterId: id, activeGraphKind: "emitter" }, "structural");
}

/** Renames emitter `id` (blank rejected, no-op). Commits `"view"` - a name never recompiles, like {@link renameVfxMesh}. */
export function renameEmitter(store: Store, id: string, name: string): void {
  const trimmed = name.trim();
  const scene = store.getSource().scene;
  if (trimmed === "" || !scene.emitters.some((emitter) => emitter.id === id)) {
    return;
  }
  commitScene(
    store,
    {
      ...scene,
      emitters: scene.emitters.map((emitter) =>
        emitter.id === id ? { ...emitter, name: trimmed } : emitter,
      ),
    },
    "view",
  );
}

/** A default name that doesn't clash with an existing emitter (`Emitter`, `Emitter 2`, ...). */
function uniqueName(emitters: readonly EmitterDoc[]): string {
  const taken = new Set(emitters.map((emitter) => emitter.name));
  if (!taken.has("Emitter")) {
    return "Emitter";
  }
  let number = 2;
  while (taken.has(`Emitter ${number}`)) {
    number += 1;
  }
  return `Emitter ${number}`;
}
