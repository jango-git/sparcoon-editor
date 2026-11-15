/**
 * How the agent API names things: graph owners and scene entities by the ids `scene.get()`
 * reports, graphs as `"render"`/`"behavior"`/`"trail"`. Resolves those names against a source (throwing
 * {@link AgentError} on a miss) and focuses an owner the way a click in the editor does - the
 * graph commands always edit the active owner.
 */

import type { EditorGraph } from "../domain/graphModel";
import type { GraphKind, RenderHost } from "../domain/nodePalette";
import { selectEmitter, selectVfxMesh } from "../model/commands";
import type { GraphOwnerRef, SourceState } from "../model/editorState";
import { emitterEntity, type SceneEntity, VFX_ENTITY, vfxMeshEntity } from "../model/entity";
import {
  GRAPH_SLOTS,
  type GraphSlot,
  isStripName,
  renderHostFor,
  type StripName,
} from "../model/graphSlots";
import type { Store } from "../model/store";
import { AgentError } from "./errors";
import type { GraphName } from "./views";

/** One resolved graph: its owner, the command slot, and the palette kind it draws from. */
export interface GraphTarget {
  readonly owner: GraphOwnerRef;
  readonly name: GraphName;
  readonly slot: GraphSlot;
  readonly kind: GraphKind;
  /** The render host the owner's surface sink is shaped for. */
  readonly host: RenderHost;
}

/** The emitter or VFX mesh `ownerId` names. */
export function resolveOwner(source: SourceState, ownerId: string): GraphOwnerRef {
  if (source.scene.emitters.some((emitter) => emitter.id === ownerId)) {
    return { kind: "emitter", id: ownerId };
  }
  if (source.scene.meshes.some((mesh) => mesh.id === ownerId)) {
    return { kind: "vfxMesh", id: ownerId };
  }
  throw new AgentError("not_found", `No emitter or mesh with id "${ownerId}".`);
}

/** The scene entity `entityId` names: the VFX group's id, or an emitter/mesh id. */
export function resolveEntity(source: SourceState, entityId: string): SceneEntity {
  if (entityId === source.scene.vfx.id) {
    return VFX_ENTITY;
  }
  const owner = resolveOwner(source, entityId);
  return owner.kind === "emitter" ? emitterEntity(owner.id) : vfxMeshEntity(owner.id);
}

export function parseGraphName(graph: string): GraphName {
  if (graph !== "render" && graph !== "behavior" && graph !== "trail" && graph !== "ribbon") {
    throw new AgentError(
      "invalid_argument",
      `Graph must be "render", "behavior", "trail" or "ribbon", got "${graph}".`,
    );
  }
  return graph;
}

/** The palette a graph draws from: the trail and ribbon graphs are render-kind. */
export function graphKindFor(graph: GraphName): GraphKind {
  return GRAPH_SLOTS[graph].kind;
}

/** The scene edit that turns each strip on. */
const STRIP_SWITCHES: { readonly [K in StripName]: string } = {
  trail: "scene.setTrail",
  ribbon: "scene.setRibbon",
};

/** Resolves `ownerId`'s `graph`; a VFX mesh has only a render graph, and only an emitter whose
 *  trail or ribbon is on has that graph. */
export function resolveGraph(source: SourceState, ownerId: string, graph: GraphName): GraphTarget {
  const owner = resolveOwner(source, ownerId);
  if (owner.kind === "vfxMesh" && graph !== "render") {
    throw new AgentError("invalid_argument", `Mesh "${ownerId}" has no ${graph} graph.`);
  }
  if (
    isStripName(graph) &&
    source.scene.emitters.find((emitter) => emitter.id === ownerId)?.[GRAPH_SLOTS[graph].slot] ===
      undefined
  ) {
    throw new AgentError(
      "invalid_argument",
      `Emitter "${ownerId}" has no ${graph} - turn it on with ${STRIP_SWITCHES[graph]} first.`,
    );
  }
  return {
    owner,
    name: graph,
    slot: GRAPH_SLOTS[graph].slot,
    kind: GRAPH_SLOTS[graph].kind,
    host: renderHostFor(owner.kind, graph),
  };
}

/** The authored graph a resolved target points at, read by id (independent of the active owner). */
export function targetGraph(source: SourceState, target: GraphTarget): EditorGraph {
  if (target.owner.kind === "vfxMesh") {
    const mesh = source.scene.meshes.find((candidate) => candidate.id === target.owner.id);
    if (mesh === undefined) {
      throw new AgentError("not_found", `No mesh with id "${target.owner.id}".`);
    }
    return mesh.renderGraph;
  }
  const emitter = source.scene.emitters.find((candidate) => candidate.id === target.owner.id);
  if (emitter === undefined) {
    throw new AgentError("not_found", `No emitter with id "${target.owner.id}".`);
  }
  const graph = emitter[target.slot];
  if (graph === undefined) {
    throw new AgentError("not_found", `Emitter "${target.owner.id}" has no ${target.name}.`);
  }
  return graph;
}

/** Makes `owner` the active graph owner, so the graph commands that follow edit its graphs. */
export function focusOwner(store: Store, owner: GraphOwnerRef): void {
  if (owner.kind === "emitter") {
    selectEmitter(store, owner.id);
  } else {
    selectVfxMesh(store, owner.id);
  }
}
