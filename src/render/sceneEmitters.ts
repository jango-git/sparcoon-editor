/**
 * Owns one {@link EmitterView} per emitter and one {@link MeshView} per VFX mesh, synced to the
 * scene model each recompute. Surfaces the active graph owner's snapshot/status to the pipeline.
 */

import type { Vector2 } from "three";
import {
  Group,
  Raycaster,
  type BufferGeometry,
  type Camera,
  type Object3D,
  type Quaternion,
  type Scene,
  type Vector3,
  type WebGLRenderer,
} from "three";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../engine/nodes-std/index";
import { registerManualRenderNodes } from "../engine/render/nodes/FXManualRenderNodes";
import { registerManualBehaviorNodes } from "../engine/behavior/nodes/FXManualBehaviorNodes";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import { serializeGraph } from "../domain/serialize";
import { GraphKind, readRenderSinkConfig, readSpawnSinkConfig } from "../domain/nodePalette";
import {
  resolveGraphOwner,
  type EmitterDoc,
  type LiveApplyStatus,
  type SceneModel,
  type VfxMeshDoc,
} from "../model/editorState";
import { entityKey, VFX_ENTITY, type SceneEntity } from "../model/entity";
import type { SceneApplier, SceneApplyResult } from "../model/pipeline";
import { sampleTransform, type Transform, type TransformTrack } from "../model/transform";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { applyTransform, EmitterView, type TextureResolver } from "./emitterView";
import { MeshView } from "./meshView";

const IDLE: LiveApplyStatus = { status: "invalid", messages: [] };
// The placeholder snapshot for a graph half that doesn't apply (no emitters yet, or a mesh's
// nonexistent behavior graph) - computed once, not per fallback (see emptyResult/meshSceneResult).
const EMPTY_SNAPSHOT = serializeGraph({
  nodes: {},
  connections: [],
  outputBindings: [],
  attributes: [],
  comments: [],
});

export class SceneEmitters implements SceneApplier {
  private readonly views = new Map<string, EmitterView>();
  // One MeshView per VFX mesh, kept in sync alongside the emitter views. A mesh is render-only
  // (no simulation), so its views never take part in spawn/particle-count/sorting.
  private readonly meshViews = new Map<string, MeshView>();
  // The two node registries every view shares: stateless factory maps populated once here rather
  // than re-registering the standard node set per emitter (each view keeps only its reconcilers).
  private readonly renderRegistry = createRenderRegistry();
  private readonly behaviorRegistry = createBehaviorRegistry();
  /**
   * The single group every emitter is parented under: the **VFX** object. Its own transform
   * poses the whole effect at once, and each emitter's transform is local to it.
   */
  private readonly vfxGroup = new Group();
  // The VFX group's own preview gizmo, a permanent child of the group.
  private readonly vfxMarker: GizmoMarker = createGizmoMarker("vfx");
  // Reused for viewport click-picking, so a pick allocates nothing.
  private readonly raycaster = new Raycaster();
  // The entity currently selected for the gizmo - its marker is highlighted. Re-applied after
  // every sync so a freshly (re)built emitter view adopts the current highlight.
  private selected: SceneEntity = VFX_ENTITY;
  // Set while the modal transform tool drives an Object3D directly, so the timeline drive and
  // view-commit re-pose don't fight the drag; the tool clears it (and commits) on confirm/cancel.
  private transformsLocked = false;
  // Entities hand-posed while the caret is parked; applySceneTransforms holds these at base
  // (ignoring tracks) until the dispatcher clears the set on the next frame entry. Keyed by entityKey.
  private readonly manualPoses = new Set<string>();

  constructor(
    scene: Scene,
    private readonly resolveTexture: TextureResolver,
    private readonly camera: Camera,
    // The live renderer, threaded into every emitter view so it can attempt a GPU (transform-
    // feedback) behavior driver when the spawn sink opts in.
    private readonly renderer: WebGLRenderer,
    // Which GLSL tier every emitter/mesh view's live render graph compiles with
    // (settings/renderBackend.ts) - shared across every view the same way the registries are.
    private readonly renderBackend: FXGLSLRenderTier,
    // The frame-quantized playhead time, so a rebuild re-poses at the same frame the caret sits on.
    private readonly currentTime: () => number = () => 0,
    // The content library's live mesh geometries, by name - threaded into every emitter/mesh view
    // so a "custom" geometry source resolves the same way an external texture does.
    private readonly resolveMeshGeometries: () => Readonly<
      Record<string, BufferGeometry>
    > = () => ({}),
  ) {
    this.vfxGroup.name = "VFX";
    this.vfxGroup.add(this.vfxMarker.object);
    scene.add(this.vfxGroup);
  }

  public sync(scene: SceneModel): SceneApplyResult {
    // A removed emitter/mesh is a genuine rebuild; a value edit that only rebinds is not (see the
    // `recompiled` flag - it gates the timeline restart-on-rebuild so a rebind never rewinds).
    let recompiled = this.pruneRemoved(scene);

    let active: SceneApplyResult | undefined = undefined;
    let first: SceneApplyResult | undefined = undefined;
    for (const emitter of scene.emitters) {
      const result = this.applyEmitter(emitter);
      first ??= result;
      if (emitter.id === scene.activeEmitterId) {
        active = result;
      }
      if (isRecompiled(result)) {
        recompiled = true;
      }
    }
    // Every mesh still (re)builds its own material + mesh here regardless of which one (if any) is
    // the active graph owner; only the owner's result is surfaced below (see `resolveGraphOwner`).
    const meshResults = new Map<string, MeshApplyResult>();
    for (const mesh of scene.meshes) {
      const result = this.applyMesh(mesh);
      meshResults.set(mesh.id, result);
      if (result.recompiled) {
        recompiled = true;
      }
    }
    // Re-assert every entity's pose after the (re)build so a structural edit never resets it.
    this.applySceneTransforms(scene, this.currentTime());
    this.highlightSelected();
    // Surface whichever entity the graph editor actually targets (same resolution as
    // `selectActiveGraphOwner`), so a VFX mesh's errors reach the graph panel like an emitter's.
    const owner = resolveGraphOwner(scene);
    const ownerMeshResult = owner?.kind === "vfxMesh" ? meshResults.get(owner.id) : undefined;
    const ownerResult =
      ownerMeshResult !== undefined ? meshSceneResult(ownerMeshResult) : (active ?? first);
    return { ...(ownerResult ?? emptyResult()), recompiled };
  }

  public destroy(): void {
    for (const view of this.views.values()) {
      view.destroy();
    }
    this.views.clear();
    for (const meshView of this.meshViews.values()) {
      meshView.destroy();
    }
    this.meshViews.clear();
    this.vfxMarker.dispose();
    this.vfxGroup.removeFromParent();
  }

  /** Poses the VFX group and every emitter/mesh Object3D at `time` and syncs mute visibility.
   * Callers pass **frame-quantized** caret time, so the pose only ever changes on a frame entry. */
  public applySceneTransforms(scene: SceneModel, time: number): void {
    if (this.transformsLocked) {
      return;
    }
    // A manually posed entity (see markManualPose) holds its base until the next frame entry
    // clears the flag, so a parked gizmo drag is not overwritten by the timeline sample.
    const pose = (base: Transform, tracks: readonly TransformTrack[], key: string): Transform =>
      this.manualPoses.has(key) ? base : sampleTransform(base, tracks, time);
    applyTransform(
      this.vfxGroup,
      pose(scene.vfx.transform, scene.vfx.transformTracks, entityKey(VFX_ENTITY)),
    );
    for (const emitter of scene.emitters) {
      const view = this.views.get(emitter.id);
      view?.applyTransform(
        pose(
          emitter.transform,
          emitter.transformTracks,
          entityKey({ kind: "emitter", id: emitter.id }),
        ),
      );
      view?.setVisible(emitter.hidden !== true);
    }
    for (const mesh of scene.meshes) {
      const meshView = this.meshViews.get(mesh.id);
      meshView?.applyTransform(
        pose(mesh.transform, mesh.transformTracks, entityKey({ kind: "vfxMesh", id: mesh.id })),
      );
      meshView?.setVisible(mesh.hidden !== true);
    }
  }

  /** Records a hand-posed `entity` (gizmo base commit); {@link applySceneTransforms} holds it at
   * base, ignoring tracks, until {@link clearManualPoses} runs on the next frame entry. */
  public markManualPose(entity: SceneEntity): void {
    this.manualPoses.add(entityKey(entity));
  }

  /** Drops every manual pose so the timeline reasserts (called by the dispatcher on frame entry). */
  public clearManualPoses(): void {
    this.manualPoses.clear();
  }

  /** Locks/unlocks the transform drive while the modal gizmo owns the Object3D directly. */
  public setTransformLock(locked: boolean): void {
    this.transformsLocked = locked;
  }

  /** Marks `entity` as selected, highlighting its emitter's preview gizmo. */
  public setSelected(entity: SceneEntity): void {
    this.selected = entity;
    this.highlightSelected();
  }

  /** The Object3D a timeline entity manipulates (the VFX group, an emitter, or a mesh), if built. */
  public entityObject(entity: SceneEntity): Object3D | undefined {
    switch (entity.kind) {
      case "vfx":
        return this.vfxGroup;
      case "emitter":
        return this.views.get(entity.id)?.object3D;
      case "vfxMesh":
        return this.meshViews.get(entity.id)?.object3D;
    }
  }

  /** Applies a live-preview local transform to an entity's Object3D on intent from the modal
   * transform tool. Only the given channels are set; `transformsLocked` keeps the drive off it. */
  public applyEntityLocalTransform(
    entity: SceneEntity,
    patch: { position?: Vector3; quaternion?: Quaternion; scale?: Vector3 },
  ): void {
    const object = this.entityObject(entity);
    if (object === undefined) {
      return;
    }
    if (patch.position !== undefined) {
      object.position.copy(patch.position);
    }
    if (patch.quaternion !== undefined) {
      object.quaternion.copy(patch.quaternion);
    }
    if (patch.scale !== undefined) {
      object.scale.copy(patch.scale);
    }
  }

  /** Picks the scene entity under viewport point `ndc` by raycasting the gizmo pick proxies;
   * nearest wins, with a more specific object (emitter/mesh) preferred over the VFX cube on a near-tie. */
  public pick(ndc: Vector2, camera: Camera): SceneEntity | undefined {
    this.vfxGroup.updateWorldMatrix(true, true);
    this.raycaster.setFromCamera(ndc, camera);
    const targets: { object: Object3D; entity: SceneEntity }[] = [
      { object: this.vfxMarker.pickTarget, entity: VFX_ENTITY },
    ];
    for (const [id, view] of this.views) {
      targets.push({ object: view.pickTarget, entity: { kind: "emitter", id } });
    }
    for (const [id, meshView] of this.meshViews) {
      targets.push({ object: meshView.pickTarget, entity: { kind: "vfxMesh", id } });
    }
    let best: { entity: SceneEntity; distance: number; specific: boolean } | undefined;
    for (const target of targets) {
      const hit = this.raycaster.intersectObject(target.object, false)[0];
      if (hit === undefined) {
        continue;
      }
      // An emitter gem or a mesh tetra is more specific than the enclosing VFX group cube.
      const specific = target.entity.kind !== "vfx";
      // Nearest wins; on a near-tie, prefer the more specific object over the group cube.
      if (
        best === undefined ||
        hit.distance < best.distance - 1e-4 ||
        (specific && !best.specific && hit.distance < best.distance + 0.1)
      ) {
        best = { entity: target.entity, distance: hit.distance, specific };
      }
    }
    return best?.entity;
  }

  /** Queues a burst on emitter `id`'s view (the timeline dispatcher's `burst` event). No-op if absent. */
  public burst(id: string, count: number): void {
    this.views.get(id)?.burst(count);
  }

  /** Starts a timed emission on emitter `id`'s view (the timeline dispatcher's `play` event). No-op if absent. */
  public play(id: string, rate: number, duration: number): void {
    this.views.get(id)?.play(rate, duration);
  }

  /** Total alive particle count across every unmuted emitter in the scene (for the viewport
   * stats) - a muted emitter keeps simulating (see `applySceneTransforms`) but contributes
   * nothing here, matching the fact that it renders nothing. */
  public totalParticleCount(): number {
    let total = 0;
    for (const view of this.views.values()) {
      if (view.visible) {
        total += view.particleCount;
      }
    }
    return total;
  }

  /** Clears live particles and cancels emission on every emitter - used on stop / loop rewind. */
  public resetAll(): void {
    for (const view of this.views.values()) {
      view.reset();
    }
  }

  /** Scrubs the timeline's sampled param values into emitter `id`'s view. No-op if absent. */
  public driveParamValues(
    id: string,
    values: ReadonlyMap<string, number | readonly number[]>,
  ): void {
    this.views.get(id)?.driveParamValues(values);
  }

  /** Scrubs the timeline's sampled render-param values into mesh `id`'s view. No-op if absent. */
  public driveMeshParamValues(
    id: string,
    values: ReadonlyMap<string, number | readonly number[]>,
  ): void {
    this.meshViews.get(id)?.driveParamValues(values);
  }

  private highlightSelected(): void {
    this.vfxMarker.setSelected(this.selected.kind === "vfx");
    for (const [id, view] of this.views) {
      view.setSelected(this.selected.kind === "emitter" && this.selected.id === id);
    }
    for (const [id, meshView] of this.meshViews) {
      meshView.setSelected(this.selected.kind === "vfxMesh" && this.selected.id === id);
    }
  }

  /** Destroys and forgets views whose emitter / mesh is no longer in the scene; true if any went. */
  private pruneRemoved(scene: SceneModel): boolean {
    let removed = false;
    const liveEmitters = new Set(scene.emitters.map((emitter) => emitter.id));
    for (const [id, view] of this.views) {
      if (!liveEmitters.has(id)) {
        view.destroy();
        this.views.delete(id);
        removed = true;
      }
    }
    const liveMeshes = new Set(scene.meshes.map((mesh) => mesh.id));
    for (const [id, meshView] of this.meshViews) {
      if (!liveMeshes.has(id)) {
        meshView.destroy();
        this.meshViews.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  /** Serializes one emitter's graphs and drives its view, creating it on first sight. */
  private applyEmitter(emitter: EmitterDoc): SceneApplyResult {
    let view = this.views.get(emitter.id);
    if (view === undefined) {
      view = new EmitterView(
        this.vfxGroup,
        this.resolveTexture,
        this.camera,
        this.renderer,
        this.renderRegistry,
        this.behaviorRegistry,
        this.renderBackend,
        this.resolveMeshGeometries,
      );
      this.views.set(emitter.id, view);
    }
    const renderSnapshot = serializeGraph(emitter.renderGraph, GraphKind.Render);
    const behaviorSnapshot = serializeGraph(emitter.behaviorGraph, GraphKind.Behavior);
    const result = view.apply(
      renderSnapshot,
      behaviorSnapshot,
      readRenderSinkConfig(emitter.renderGraph),
      readSpawnSinkConfig(emitter.behaviorGraph),
      emitter.behaviorGraph.attributes,
    );
    return {
      renderSnapshot,
      behaviorSnapshot,
      renderStatus: result.render,
      behaviorStatus: result.behavior,
      emitterRebuilt: result.emitterRebuilt,
    };
  }

  /** Serializes one mesh's render graph and drives its view, creating it on first sight. A fresh
   * mesh view is a structural add, not a rebind, so `recompiled` is forced true for it too. */
  private applyMesh(mesh: VfxMeshDoc): MeshApplyResult {
    let view = this.meshViews.get(mesh.id);
    const created = view === undefined;
    if (view === undefined) {
      view = new MeshView(
        this.vfxGroup,
        this.resolveTexture,
        this.renderRegistry,
        this.renderBackend,
        this.resolveMeshGeometries,
      );
      this.meshViews.set(mesh.id, view);
    }
    const renderSnapshot = serializeGraph(mesh.renderGraph, GraphKind.Render);
    // Geometry + compositing both come from the surface sink (unified with emitters); a mesh has no
    // separate primitive field. Sort is emitter-only, so it is read but unused here.
    const config = readRenderSinkConfig(mesh.renderGraph);
    const renderStatus = view.apply(
      renderSnapshot,
      config.geometry,
      config.renderMode,
      config.castShadow,
      config.receiveShadow,
    );
    return {
      renderSnapshot,
      renderStatus,
      recompiled: created || renderStatus.status === "recompiled",
    };
  }
}

/** Whether an emitter apply actually tore down and rebuilt the runtime emitter (a real rebuild) -
 *  NOT whether either graph's own artifact recompiled: a render-only edit can recompile the
 *  render half yet apply it as an in-place swap, never resetting the running emitter. */
function isRecompiled(result: SceneApplyResult): boolean {
  return result.emitterRebuilt === true;
}

/** One mesh's apply outcome - a mesh has no behavior graph, so this carries only the render half. */
interface MeshApplyResult {
  readonly renderSnapshot: FXGraphSnapshotData;
  readonly renderStatus: LiveApplyStatus;
  readonly recompiled: boolean;
}

/** Widens a mesh's apply outcome to the shared `SceneApplyResult` shape, padding the behavior half
 * with the empty placeholder - a mesh has no behavior graph. */
function meshSceneResult(result: MeshApplyResult): SceneApplyResult {
  return {
    renderSnapshot: result.renderSnapshot,
    behaviorSnapshot: EMPTY_SNAPSHOT,
    renderStatus: result.renderStatus,
    behaviorStatus: IDLE,
  };
}

function createRenderRegistry(): FXNodeRegistry<FXRenderNode> {
  const registry = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(registry);
  registerManualRenderNodes(registry);
  return registry;
}

function createBehaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  const registry = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(registry);
  registerManualBehaviorNodes(registry);
  return registry;
}

function emptyResult(): SceneApplyResult {
  return {
    renderSnapshot: EMPTY_SNAPSHOT,
    behaviorSnapshot: EMPTY_SNAPSHOT,
    renderStatus: IDLE,
    behaviorStatus: IDLE,
  };
}
