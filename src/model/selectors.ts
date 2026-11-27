/** Read-only selectors over the live state. */

import type { LibraryAssetNames } from "../domain/assetChecks";
import type { EditorGraph } from "../domain/graphModel";
import { computeGraphStats } from "../domain/graphStats";
import { GraphKind, metaFor } from "../domain/nodePalette";
import { coerceGeometrySource, RENDER_SINK_TYPE } from "../domain/sinkMeta";
import { assetParamsOf, type FXAssetKind, mapAssetKinds } from "../engine/core/nodes/FXAssetKind";
import type {
  AnimationTrack,
  EmitterDoc,
  EnvironmentAsset,
  GraphOwnerKind,
  LiveApplyStatus,
  MeshAsset,
  PaletteSwatch,
  SceneAsset,
  SourceState,
  TextureAsset,
  VfxDoc,
  VfxMeshDoc,
  VolumeAsset,
} from "./editorState";
import { resolveGraphOwner } from "./editorState";
import type { SceneEntity } from "./entity";
import {
  authoredGraphs,
  GRAPH_SLOTS,
  type GraphName,
  stripGraphs,
  type StripSlot,
  stripSlot,
} from "./graphSlots";
import type { Store } from "./store";

export function selectVfx(store: Store): VfxDoc {
  return store.getSource().scene.vfx;
}

export function selectTextureAssets(store: Store): readonly TextureAsset[] {
  return store.getSource().assets;
}

export function selectEnvironmentAssets(store: Store): readonly EnvironmentAsset[] {
  return store.getSource().environments;
}

export function selectSceneAssets(store: Store): readonly SceneAsset[] {
  return store.getSource().scenes;
}

export function selectMeshAssets(store: Store): readonly MeshAsset[] {
  return store.getSource().meshAssets;
}

/** The volume-asset library, in bake order. */
export function selectVolumeAssets(store: Store): readonly VolumeAsset[] {
  return store.getSource().volumeAssets;
}

/** The content library each kind of asset a node picks is one of. */
export type AssetLibrary = "mesh" | "volume";

/** The library of each kind of asset, and which of its entries are of the kind. */
const KIND_LIBRARIES: Readonly<
  Record<
    FXAssetKind,
    | { readonly library: "mesh"; readonly accepts: (asset: MeshAsset) => boolean }
    | { readonly library: "volume" }
  >
> = {
  mesh: { library: "mesh", accepts: () => true },
  sceneMesh: { library: "mesh", accepts: (asset) => asset.geometry.skin === undefined },
  skinnedMesh: { library: "mesh", accepts: (asset) => asset.geometry.skin !== undefined },
  volume: { library: "volume" },
};

/** The library's assets of `kind`, in library order, with the library they are of. */
export function kindAssets(
  source: SourceState,
  kind: FXAssetKind,
):
  | { readonly library: "mesh"; readonly assets: readonly MeshAsset[] }
  | { readonly library: "volume"; readonly assets: readonly VolumeAsset[] } {
  const entry = KIND_LIBRARIES[kind];
  return entry.library === "volume"
    ? { library: "volume", assets: source.volumeAssets }
    : { library: "mesh", assets: source.meshAssets.filter(entry.accepts) };
}

/** The names of the content library's assets nodes sample, by kind. */
export function libraryAssetNames(source: SourceState): LibraryAssetNames {
  return mapAssetKinds((kind) => kindAssets(source, kind).assets.map((asset) => asset.name));
}

/**
 * How many nodes use each asset of `library`, keyed by name - every node picking it (Random Mesh
 * Point, Random Scene Mesh Point, Random Skinned Mesh Point, SDF Sample) and, for a mesh, every
 * surface sink drawing it as the geometry. Names with no users are absent (caller reads 0).
 */
export function selectAssetUsage(store: Store, library: AssetLibrary): ReadonlyMap<string, number> {
  const usage = new Map<string, number>();
  const count = (name: unknown): void => {
    if (typeof name === "string" && name !== "") {
      usage.set(name, (usage.get(name) ?? 0) + 1);
    }
  };
  const scene = store.getSource().scene;
  for (const owner of [...scene.emitters, ...scene.meshes]) {
    for (const { name, graph } of authoredGraphs(owner)) {
      for (const node of Object.values(graph.nodes)) {
        if (library === "mesh" && node.type === RENDER_SINK_TYPE) {
          const geometry = coerceGeometrySource(node.parameters["geometry"]);
          if (geometry.kind === "custom") {
            count(geometry.meshAssetName);
          }
        }
        for (const parameter of assetParamsOf(metaFor(GRAPH_SLOTS[name].kind, node.type))) {
          if (KIND_LIBRARIES[parameter.kind].library === library) {
            count(node.parameters[parameter.key]);
          }
        }
      }
    }
  }
  return usage;
}

export function selectPaletteSwatches(store: Store): readonly PaletteSwatch[] {
  return store.getSource().palette;
}

/**
 * How many nodes reference each texture asset, keyed by name: every `texture` node across all
 * render graphs (behavior graphs hold none). Names with no users are absent (caller reads 0).
 */
export function selectTextureAssetUsage(store: Store): ReadonlyMap<string, number> {
  const usage = new Map<string, number>();
  const scene = store.getSource().scene;
  const renderGraphs = [
    ...scene.emitters.map((emitter) => emitter.renderGraph),
    ...scene.emitters.flatMap((emitter) => stripGraphs(emitter).map(({ graph }) => graph)),
    ...scene.meshes.map((mesh) => mesh.renderGraph),
  ];
  for (const graph of renderGraphs) {
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== "texture") {
        continue;
      }
      const name = node.parameters["name"];
      if (typeof name === "string" && name !== "") {
        usage.set(name, (usage.get(name) ?? 0) + 1);
      }
    }
  }
  return usage;
}

export function selectEmitters(store: Store): readonly EmitterDoc[] {
  return store.getSource().scene.emitters;
}

/** Total complexity cost across every graph of every visible entity in the scene - the whole
 * effect as it actually renders. A muted (hidden) emitter/mesh contributes nothing, mirroring
 * `applySceneTransforms`'s `hidden !== true` visibility check. */
export function selectSceneCost(store: Store): number {
  const scene = store.getSource().scene;
  let total = 0;
  for (const emitter of scene.emitters) {
    if (emitter.hidden === true) {
      continue;
    }
    total += computeGraphStats(GraphKind.Render, emitter.renderGraph).cost;
    total += computeGraphStats(GraphKind.Behavior, emitter.behaviorGraph).cost;
    for (const { graph } of stripGraphs(emitter)) {
      total += computeGraphStats(GraphKind.Render, graph).cost;
    }
  }
  for (const mesh of scene.meshes) {
    if (mesh.hidden === true) {
      continue;
    }
    total += computeGraphStats(GraphKind.Render, mesh.renderGraph).cost;
  }
  return total;
}

/**
 * Whether the scene holds an infinite play event (a `play` with `duration` 0): the timeline never
 * ends, so the transport parks the caret at the last frame while the sim runs on.
 */
export function hasInfinitePlay(store: Store): boolean {
  return store
    .getSource()
    .scene.emitters.some((emitter) =>
      emitter.events.some((event) => event.kind === "play" && event.duration <= 0),
    );
}

export function selectActiveEmitterId(store: Store): string | undefined {
  return store.getSource().scene.activeEmitterId;
}

/** The active emitter, or the first one when the active id is stale. */
export function selectActiveEmitter(store: Store): EmitterDoc {
  const { emitters, activeEmitterId } = store.getSource().scene;
  const active = emitters.find((emitter) => emitter.id === activeEmitterId) ?? emitters[0];
  if (active === undefined) {
    throw new Error("Scene has no emitters");
  }
  return active;
}

export function selectRenderGraph(store: Store): EditorGraph {
  return selectActiveEmitter(store).renderGraph;
}

export function selectBehaviorGraph(store: Store): EditorGraph {
  return selectActiveEmitter(store).behaviorGraph;
}

/** The active graph owner: the emitter or the VFX mesh the shared canvas currently edits. */
export type ActiveGraphOwner = {
  readonly kind: GraphOwnerKind;
  readonly id: string;
  readonly renderGraph: EditorGraph;
  /** An emitter's simulation graph (spawn + update sinks). Absent for a VFX mesh - it has no
   *  behavior graph at all - so callers summing "every graph this owner authors" skip it then. */
  readonly behaviorGraph?: EditorGraph;
  /** The owner's animated Timeline Value tracks (an emitter's or a mesh's render-graph values). */
  readonly tracks: readonly AnimationTrack[];
} & {
  /** An emitter's strip graphs, each while that strip is on. */
  readonly [K in StripSlot]?: EditorGraph;
};

/**
 * Resolves the active graph owner (see {@link resolveGraphOwner}): what the canvas reads. Always
 * defined - a scene always keeps at least one emitter or mesh.
 */
export function selectActiveGraphOwner(store: Store): ActiveGraphOwner {
  const scene = store.getSource().scene;
  const owner = resolveGraphOwner(scene);
  if (owner?.kind === "vfxMesh") {
    const mesh = scene.meshes.find((candidate) => candidate.id === owner.id);
    if (mesh !== undefined) {
      return { kind: "vfxMesh", id: mesh.id, renderGraph: mesh.renderGraph, tracks: mesh.tracks };
    }
  }
  const emitter = scene.emitters.find((candidate) => candidate.id === owner?.id);
  if (emitter === undefined) {
    throw new Error("Scene has neither an emitter nor a mesh");
  }
  return {
    kind: "emitter",
    id: emitter.id,
    renderGraph: emitter.renderGraph,
    behaviorGraph: emitter.behaviorGraph,
    ...Object.fromEntries(stripGraphs(emitter).map(({ name, graph }) => [stripSlot(name), graph])),
    tracks: emitter.tracks,
  };
}

export function selectMeshes(store: Store): readonly VfxMeshDoc[] {
  return store.getSource().scene.meshes;
}

export function selectActiveMeshId(store: Store): string | undefined {
  return store.getSource().scene.activeMeshId;
}

/** The VFX mesh the editor currently targets, or `undefined` (no meshes, or a stale active id). */
export function selectActiveMesh(store: Store): VfxMeshDoc | undefined {
  const { meshes, activeMeshId } = store.getSource().scene;
  return meshes.find((mesh) => mesh.id === activeMeshId);
}

/** Any scene entity's document: the VFX group, an emitter, or a VFX mesh. */
export type SceneEntityDoc = VfxDoc | EmitterDoc | VfxMeshDoc;

/**
 * Resolves any scene entity (not necessarily the active graph owner) to its document. `undefined`
 * only for a stale emitter/mesh id (the VFX group always exists).
 */
export function selectEntityDoc(store: Store, entity: SceneEntity): SceneEntityDoc | undefined {
  const scene = store.getSource().scene;
  switch (entity.kind) {
    case "vfx":
      return scene.vfx;
    case "emitter":
      return scene.emitters.find((emitter) => emitter.id === entity.id);
    case "vfxMesh":
      return scene.meshes.find((mesh) => mesh.id === entity.id);
  }
}

/** The live compile status of the active owner's graph `name` (see {@link GRAPH_SLOTS}). */
export function selectGraphStatus(store: Store, name: GraphName): LiveApplyStatus | undefined {
  return store.getState().derived[GRAPH_SLOTS[name].status];
}
