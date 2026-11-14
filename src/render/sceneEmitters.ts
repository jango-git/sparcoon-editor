/**
 * Owns one {@link EmitterView} per emitter and one {@link MeshView} per VFX mesh, synced to the
 * scene model each recompute. Surfaces the active graph owner's snapshot/status to the pipeline.
 */

import { connectDeathReaction, fireSpawnAction } from "sparcoon/editor";
import type { Vector2 } from "three";
import {
  type BufferGeometry,
  type Camera,
  Group,
  type Object3D,
  type Quaternion,
  Raycaster,
  type Scene,
  type Vector3,
  type WebGLRenderer,
} from "three";

import { effectiveSpawnConfig } from "../domain/deathReactions";
import {
  GraphKind,
  readRenderSinkConfig,
  readTrailSinkConfig,
  timelineValueConflicts,
} from "../domain/nodePalette";
import { type InheritIssue, inheritIssueWarnings, linkReaction } from "../domain/reactionLinking";
import { serializeGraph } from "../domain/serialize";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import { registerManualBehaviorNodes } from "../engine/behavior/nodes/FXManualBehaviorNodes";
import { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../engine/nodes-std/index";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../engine/render/nodes/FXManualRenderNodes";
import { compilerErrorMessage } from "../i18n/compilerErrors";
import {
  type EmitterDoc,
  type LiveApplyStatus,
  resolveGraphOwner,
  type SceneModel,
  type SpawnAction,
  type VfxMeshDoc,
} from "../model/editorState";
import { entityKey, type SceneEntity, VFX_ENTITY } from "../model/entity";
import { authoredGraphs, type GraphName } from "../model/graphSlots";
import type { SceneApplier, SceneApplyResult } from "../model/pipeline";
import { sampleTransform, type Transform, type TransformTrack } from "../model/transform";
import { blocked, invalidFromErrors } from "./applyStatus.Internal";
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
  // The death reactions as wired between views, re-made on every sync (cheap: a listener each),
  // and what each leaves its births at defaults for, by reaction id.
  private reactionLinks: (() => void)[] = [];
  private inheritIssuesByReaction: ReadonlyMap<string, readonly InheritIssue[]> = new Map();
  // See readsSceneDepth: what the views' materials and visibility last said, refreshed when either
  // can change - a sync (new materials) or a visibility flip.
  private sceneDepthRead = false;

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
    // The playhead time a rebuild re-poses at: the caret's frame when parked, the caret itself while
    // playing (see TimelineDispatcher.driveFrame).
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

  /** What each reaction, by id, leaves its births at defaults for, as last wired. */
  public get inheritIssues(): ReadonlyMap<string, readonly InheritIssue[]> {
    return this.inheritIssuesByReaction;
  }
  /** The effects' root: everything the scene depth pre-pass leaves out (see `SceneDepthSource`). */
  public get effects(): Object3D {
    return this.vfxGroup;
  }

  public sync(scene: SceneModel): SceneApplyResult {
    // A removed emitter/mesh is a genuine rebuild; a value edit that only rebinds is not (see the
    // `recompiled` flag - it gates the timeline restart-on-rebuild so a rebind never rewinds).
    let recompiled = this.pruneRemoved(scene);

    let active: SceneApplyResult | undefined = undefined;
    let first: SceneApplyResult | undefined = undefined;
    for (const emitter of scene.emitters) {
      const result = this.applyEmitter(emitter, scene);
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
    this.wireReactions(scene);
    active = active === undefined ? undefined : this.withInheritWarnings(active, scene);
    // Re-assert every entity's pose after the (re)build so a structural edit never resets it.
    this.applySceneTransforms(scene, this.currentTime());
    this.refreshSceneDepthRead();
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
    this.unwireReactions();
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
   * Callers pass the caret's frame time while it is parked, and the caret time itself while playing. */
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
    let visibilityChanged = false;
    for (const emitter of scene.emitters) {
      const view = this.views.get(emitter.id);
      view?.applyTransform(
        pose(
          emitter.transform,
          emitter.transformTracks,
          entityKey({ kind: "emitter", id: emitter.id }),
        ),
      );
      visibilityChanged = setVisible(view, emitter.hidden !== true) || visibilityChanged;
    }
    for (const mesh of scene.meshes) {
      const meshView = this.meshViews.get(mesh.id);
      meshView?.applyTransform(
        pose(mesh.transform, mesh.transformTracks, entityKey({ kind: "vfxMesh", id: mesh.id })),
      );
      visibilityChanged = setVisible(meshView, mesh.hidden !== true) || visibilityChanged;
    }
    if (visibilityChanged) {
      this.refreshSceneDepthRead();
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
    // Hidden gizmos are not pickable: the ray sees the layers the camera draws.
    this.raycaster.layers.mask = camera.layers.mask;
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

  /** Fires `action` on emitter `id`'s view (a timeline event crossing the playhead), the way the
   *  runtime's `FXEffect` does. No-op if absent. */
  public spawn(id: string, action: SpawnAction): void {
    const view = this.views.get(id);
    if (view !== undefined) {
      fireSpawnAction(view, action);
    }
  }

  /**
   * Links every death reaction of `scene` between the views, as the runtime's `FXEffect` does
   * between its emitters, with what its births inherit of the running source's particles (see
   * `reactionLinking.ts`). Part of every sync - after every rebuild, so a link always copies within
   * the layouts it was made for; also on its own after a view edit, which changes a reaction's
   * numbers without a rebuild.
   */
  public wireReactions(scene: SceneModel): void {
    this.unwireReactions();
    const issues = new Map<string, readonly InheritIssue[]>();
    for (const emitter of scene.emitters) {
      const target = this.views.get(emitter.id);
      for (const reaction of emitter.reactions) {
        const source = this.views.get(reaction.source);
        if (target !== undefined && source !== undefined) {
          const link = linkReaction(source.reactionSource, target.inheritEntries);
          if (link.issues.length > 0) {
            issues.set(reaction.id, link.issues);
          }
          this.reactionLinks.push(connectDeathReaction(source, target, reaction, link.copies));
        }
      }
    }
    this.inheritIssuesByReaction = issues;
  }

  /** Whether any shown emitter or mesh reads the scene depth - the pre-pass is paid only then.
   *  Kept, not polled: the pre-pass asks every frame. */
  public readsSceneDepth(): boolean {
    return this.sceneDepthRead;
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

  /**
   * Births lost to a full ring since the last reset (stop/rewind) or rebuild, across every unmuted
   * emitter that can report it (see {@link EmitterView.particleOverflowCount}) - nonzero means some
   * emitter's Expected Capacity is too small. `undefined` when no visible emitter can report it
   * (all GPU-driven, or none); `partial` when some visible emitter cannot.
   */
  public totalParticleOverflowCount(): ParticleOverflow | undefined {
    let count: number | undefined;
    let partial = false;
    for (const view of this.views.values()) {
      if (!view.visible) {
        continue;
      }
      const overflow = view.particleOverflowCount;
      if (overflow === undefined) {
        partial = true;
      } else {
        count = (count ?? 0) + overflow;
      }
    }
    return count === undefined ? undefined : { count, partial };
  }

  /** Clears live particles and cancels emission on every emitter - used on stop / rewind. */
  public resetAll(): void {
    for (const view of this.views.values()) {
      view.reset();
    }
  }

  /** Playback looped: cancels emission on every emitter, keeping its live particles. */
  public loopAll(): void {
    for (const view of this.views.values()) {
      view.loopTimeline();
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

  /** `result` (the active emitter's) with what its reactions cannot hand over among its behavior
   *  warnings. */
  private withInheritWarnings(result: SceneApplyResult, scene: SceneModel): SceneApplyResult {
    const target = scene.emitters.find((emitter) => emitter.id === scene.activeEmitterId);
    const status = result.behaviorStatus;
    if (target === undefined || status.status === "invalid") {
      return result;
    }
    const warnings = inheritIssueWarnings(target, scene.emitters, this.inheritIssuesByReaction);
    if (warnings.length === 0) {
      return result;
    }
    return {
      ...result,
      behaviorStatus: {
        ...status,
        warnings: [...(status.warnings ?? []), ...warnings.map(compilerErrorMessage)],
      },
    };
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

  /** Recomputes {@link readsSceneDepth} from every view's material and visibility. */
  private refreshSceneDepthRead(): void {
    this.sceneDepthRead = false;
    for (const view of this.views.values()) {
      this.sceneDepthRead ||= view.visible && view.readsSceneDepth;
    }
    for (const view of this.meshViews.values()) {
      this.sceneDepthRead ||= view.visible && view.readsSceneDepth;
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

  private unwireReactions(): void {
    for (const disconnect of this.reactionLinks) {
      disconnect();
    }
    this.reactionLinks = [];
  }

  /** Serializes one emitter's graphs and drives its view, creating it on first sight. */
  private applyEmitter(emitter: EmitterDoc, scene: SceneModel): SceneApplyResult {
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
    const trail =
      emitter.trailGraph === undefined
        ? undefined
        : {
            snapshot: serializeGraph(emitter.trailGraph, GraphKind.Render),
            config: readTrailSinkConfig(emitter.trailGraph),
          };
    // One Timeline Value name is one value across the emitter's graphs, so it must have one type
    // and one default: a clash is held like any graph error (the running emitter is left as it was).
    const graphs = authoredGraphs(emitter);
    const conflicts = timelineValueConflicts(graphs.map(({ graph }) => graph));
    if (conflicts.length > 0) {
      const statusOf = (name: GraphName): LiveApplyStatus => {
        const errors = conflicts
          .filter((conflict) => graphs[conflict.graphIndex]?.name === name)
          .map((conflict) => conflict.error);
        return errors.length > 0 ? invalidFromErrors(errors) : blocked();
      };
      return {
        renderSnapshot,
        behaviorSnapshot,
        renderStatus: statusOf("render"),
        behaviorStatus: statusOf("behavior"),
        ...(trail === undefined
          ? {}
          : { trailSnapshot: trail.snapshot, trailStatus: statusOf("trail") }),
        emitterRebuilt: false,
      };
    }
    const result = view.apply(
      renderSnapshot,
      behaviorSnapshot,
      readRenderSinkConfig(emitter.renderGraph),
      // A death source simulates on the CPU whatever its spawn node asks (deathReactions.ts).
      effectiveSpawnConfig(emitter, scene),
      emitter.behaviorGraph.attributes,
      trail,
    );
    return {
      renderSnapshot,
      behaviorSnapshot,
      renderStatus: result.render,
      behaviorStatus: result.behavior,
      ...(trail === undefined ? {} : { trailSnapshot: trail.snapshot }),
      ...(result.trail === undefined ? {} : { trailStatus: result.trail }),
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

/** Particles lost to full emitters, as the viewport stats report it. */
export interface ParticleOverflow {
  readonly count: number;
  /** Some visible emitter cannot report its overflow (GPU-driven), so `count` leaves it out. */
  readonly partial: boolean;
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

/** Shows or hides `view` (when it exists); whether that changed its visibility. */
function setVisible(
  view: { readonly visible: boolean; setVisible(visible: boolean): void } | undefined,
  visible: boolean,
): boolean {
  if (view === undefined) {
    return false;
  }
  const changed = view.visible !== visible;
  view.setVisible(visible);
  return changed;
}
