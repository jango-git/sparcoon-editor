/**
 * Owns one {@link EmitterView} per emitter and one {@link MeshView} per VFX mesh, synced to the
 * scene on each recompute. Reports the active graph owner's result.
 */

import { connectReaction, fireSpawnAction } from "sparcoon/editor";
import type { Vector2 } from "three";
import {
  type Camera,
  Group,
  type Object3D,
  type Quaternion,
  Raycaster,
  type Scene,
  type Vector3,
  type WebGLRenderer,
} from "three";

import {
  GraphKind,
  readRenderSinkConfig,
  readStripSinkConfig,
  timelineValueConflicts,
} from "../domain/nodePalette";
import { type InheritIssue, inheritIssueWarnings, linkReaction } from "../domain/reactionLinking";
import { effectiveSpawnConfig } from "../domain/reactions";
import { serializeGraph } from "../domain/serialize";
import { emitterDrawsNothingWarnings, stripSpawnWarnings } from "../domain/stripChecks";
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
import {
  authoredGraphs,
  type GraphName,
  STRIP_NAMES,
  stripGraphs,
  type StripName,
} from "../model/graphSlots";
import type { SceneApplier, SceneApplyResult, StripApplyInputs } from "../model/pipeline";
import { sampleTransform, type Transform, type TransformTrack } from "../model/transform";
import { blocked, invalidFromErrors, withLinkFailure, withWarnings } from "./applyStatus.Internal";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { applyTransform, EmitterView, type TextureResolver } from "./emitterView";
import { MeshView } from "./meshView";
import { NO_PREVIEW_ASSETS, type PreviewAssets } from "./previewAssets";
import { type ProgramLinkFailures, sameProgramLinkFailures } from "./programLinkFailures";

const IDLE: LiveApplyStatus = { status: "invalid", messages: [] };
// Placeholder snapshot for a graph half that does not apply, computed once.
const EMPTY_SNAPSHOT = serializeGraph({
  nodes: {},
  connections: [],
  outputBindings: [],
  attributes: [],
  comments: [],
});

export class SceneEmitters implements SceneApplier {
  private readonly views = new Map<string, EmitterView>();
  // Mesh views take no part in spawn, particle count or sorting.
  private readonly meshViews = new Map<string, MeshView>();
  // Node registries shared by all views. They are stateless factory maps.
  private readonly renderRegistry = createRenderRegistry();
  private readonly behaviorRegistry = createBehaviorRegistry();
  /**
   * The VFX object. Every emitter is parented under it, and its transform poses the whole effect.
   */
  private readonly vfxGroup = new Group();
  private readonly vfxMarker: GizmoMarker = createGizmoMarker("vfx");
  private readonly raycaster = new Raycaster();
  // Selected entity. Reapplied after every sync so rebuilt views pick up the highlight.
  private selected: SceneEntity = VFX_ENTITY;
  // Set while the modal transform tool moves an Object3D, so the timeline drive does not fight the
  // drag.
  private transformsLocked = false;
  // Entities hand-posed while the caret is parked. Held at base until the dispatcher clears them on
  // the next frame entry.
  private readonly manualPoses = new Set<string>();
  // The death reactions as wired between views, re-made on every sync (cheap: a listener each),
  // and what each leaves its births at defaults for, by reaction id.
  private reactionLinks: (() => void)[] = [];
  private inheritIssuesByReaction: ReadonlyMap<string, readonly InheritIssue[]> = new Map();
  private sceneDepthRead = false;
  // The link failures of every view as last checked, by view id, to tell when they change.
  private programLinkFailuresSeen = new Map<string, ProgramLinkFailures>();

  constructor(
    scene: Scene,
    private readonly resolveTexture: TextureResolver,
    private readonly camera: Camera,
    private readonly renderer: WebGLRenderer,
    private readonly renderBackend: FXGLSLRenderTier,
    // Time a rebuild re-poses at, the caret frame when parked and the caret time while playing.
    private readonly currentTime: () => number = () => 0,
    private readonly resolveAssets: () => PreviewAssets = () => NO_PREVIEW_ASSETS,
  ) {
    this.vfxGroup.name = "VFX";
    this.vfxGroup.add(this.vfxMarker.object);
    scene.add(this.vfxGroup);
  }

  public get inheritIssues(): ReadonlyMap<string, readonly InheritIssue[]> {
    return this.inheritIssuesByReaction;
  }
  public get effects(): Object3D {
    return this.vfxGroup;
  }

  /**
   * Whether a sync is due because a link failure changed or the awaited GPU kernel finished
   * building. Called after a frame has compiled and run every view.
   */
  public checkPrograms(): boolean {
    let kernelBuilt = false;
    for (const view of this.views.values()) {
      kernelBuilt = view.takeEndedKernelBuild() || kernelBuilt;
    }
    return this.linkFailuresChanged() || kernelBuilt;
  }

  public sync(scene: SceneModel): SceneApplyResult {
    // A removal counts as a rebuild and a rebind does not. `recompiled` gates the timeline restart,
    // so a rebind never rewinds.
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
    // Every mesh rebuilds here. Only the graph owner's result is surfaced below.
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
    this.applySceneTransforms(scene, this.currentTime());
    this.refreshSceneDepthRead();
    this.highlightSelected();
    // Surfaces the entity the graph editor targets, so mesh errors reach the graph panel too.
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

  /**
   * Poses the VFX group and every emitter and mesh at `time`, and syncs mute visibility. `time` is
   * the caret frame when parked, else the caret time.
   */
  public applySceneTransforms(scene: SceneModel, time: number): void {
    if (this.transformsLocked) {
      return;
    }
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

  public markManualPose(entity: SceneEntity): void {
    this.manualPoses.add(entityKey(entity));
  }

  public clearManualPoses(): void {
    this.manualPoses.clear();
  }

  public setTransformLock(locked: boolean): void {
    this.transformsLocked = locked;
  }

  public setSelected(entity: SceneEntity): void {
    this.selected = entity;
    this.highlightSelected();
  }

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

  /** Applies a local transform to an entity's Object3D. Only the given channels are set. */
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

  /**
   * Raycasts the gizmo pick proxies at `ndc`. Nearest wins, but an emitter or mesh beats the VFX
   * cube on a near-tie.
   */
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
      const specific = target.entity.kind !== "vfx";
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

  public spawn(id: string, action: SpawnAction): void {
    const view = this.views.get(id);
    if (view !== undefined) {
      fireSpawnAction(view, action);
    }
  }

  /**
   * Links every reaction of `scene` between the views, with what births inherit from the source's
   * particles (see `reactionLinking.ts`). Runs on every sync after rebuilds, and alone after a view
   * edit that changes reaction numbers without a rebuild.
   */
  public wireReactions(scene: SceneModel): void {
    this.unwireReactions();
    const issues = new Map<string, readonly InheritIssue[]>();
    for (const emitter of scene.emitters) {
      const target = this.views.get(emitter.id);
      for (const reaction of emitter.reactions) {
        const source = this.views.get(reaction.source);
        if (target !== undefined && source !== undefined) {
          const link = linkReaction(source.reactionSource, reaction.on, target.inheritEntries);
          if (link.issues.length > 0) {
            issues.set(reaction.id, link.issues);
          }
          this.reactionLinks.push(
            connectReaction(source, reaction.on, target, reaction, link.copies),
          );
        }
      }
    }
    this.inheritIssuesByReaction = issues;
  }

  /**
   * Whether any shown emitter or mesh reads scene depth. Cached because the pre-pass asks every
   * frame.
   */
  public readsSceneDepth(): boolean {
    return this.sceneDepthRead;
  }

  /**
   * Alive particles across unmuted emitters. A muted emitter keeps simulating but renders nothing,
   * so it is not counted.
   */
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
   * Births lost to a full ring since the last reset or rebuild, over unmuted emitters that can
   * report it. Nonzero means Expected Capacity is too small. `undefined` when none can report,
   * `partial` when some cannot.
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

  public resetAll(): void {
    for (const view of this.views.values()) {
      view.reset();
    }
  }

  public loopAll(): void {
    for (const view of this.views.values()) {
      view.loopTimeline();
    }
  }

  public driveParamValues(
    id: string,
    values: ReadonlyMap<string, number | readonly number[]>,
  ): void {
    this.views.get(id)?.driveParamValues(values);
  }

  public driveMeshParamValues(
    id: string,
    values: ReadonlyMap<string, number | readonly number[]>,
  ): void {
    this.meshViews.get(id)?.driveParamValues(values);
  }

  /** Whether the programs the renderer or driver could not link changed since the last check. */
  private linkFailuresChanged(): boolean {
    const seen = new Map<string, ProgramLinkFailures>();
    for (const [id, view] of [...this.views, ...this.meshViews]) {
      const failures = view.programLinkFailures(this.renderer);
      if (Object.keys(failures).length > 0) {
        seen.set(id, failures);
      }
    }
    const previous = this.programLinkFailuresSeen;
    this.programLinkFailuresSeen = seen;
    return (
      seen.size !== previous.size ||
      [...seen].some(([id, failures]) => {
        const before = previous.get(id);
        return before === undefined || !sameProgramLinkFailures(before, failures);
      })
    );
  }

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

  private refreshSceneDepthRead(): void {
    this.sceneDepthRead = false;
    for (const view of this.views.values()) {
      this.sceneDepthRead ||= view.visible && view.readsSceneDepth;
    }
    for (const view of this.meshViews.values()) {
      this.sceneDepthRead ||= view.visible && view.readsSceneDepth;
    }
  }

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
        this.resolveAssets,
      );
      this.views.set(emitter.id, view);
    }
    const renderSnapshot = serializeGraph(emitter.renderGraph, GraphKind.Render);
    const behaviorSnapshot = serializeGraph(emitter.behaviorGraph, GraphKind.Behavior);
    // Each entry is the strip of its own name, which `Object.fromEntries` cannot carry.
    const strips = Object.fromEntries(
      stripGraphs(emitter).map(({ name, graph }) => [
        name,
        {
          snapshot: serializeGraph(graph, GraphKind.Render),
          config: readStripSinkConfig(name, graph),
        },
      ]),
    ) as StripApplyInputs;
    // Each strip's outcome, by the status `statusOf` gives it.
    const stripOutcomes = (
      statusOf: (name: StripName) => LiveApplyStatus | undefined,
    ): NonNullable<SceneApplyResult["strips"]> =>
      Object.fromEntries(
        STRIP_NAMES.flatMap((name) => {
          const snapshot = strips[name]?.snapshot;
          const status = statusOf(name);
          return snapshot === undefined || status === undefined
            ? []
            : [[name, { snapshot, status }]];
        }),
      );
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
        strips: stripOutcomes(statusOf),
        emitterRebuilt: false,
      };
    }
    const result = view.apply(
      renderSnapshot,
      behaviorSnapshot,
      readRenderSinkConfig(emitter.renderGraph),
      // A reaction source simulates on the CPU whatever its spawn node asks (reactions.ts).
      effectiveSpawnConfig(emitter, scene),
      emitter.behaviorGraph.attributes,
      strips,
    );
    // A program built from an earlier apply that the renderer could not link; a fresh one is
    // checked after the frame that compiles it.
    const linkFailures = view.programLinkFailures(this.renderer);
    return {
      renderSnapshot,
      behaviorSnapshot,
      // Drawing neither the particles nor a strip is no error, only nothing to see.
      renderStatus: withLinkFailure(
        withWarnings(result.render, emitterDrawsNothingWarnings(emitter)),
        linkFailures.render,
      ),
      behaviorStatus: withLinkFailure(result.behavior, linkFailures.behavior),
      // What a strip joins can follow from the emitter's spawns, not from its graph.
      strips: stripOutcomes((name) => {
        const status = result[name];
        return status === undefined
          ? undefined
          : withLinkFailure(
              withWarnings(status, stripSpawnWarnings(name, emitter)),
              linkFailures[name],
            );
      }),
      emitterRebuilt: result.emitterRebuilt,
    };
  }

  /** A fresh mesh view counts as a structural add, so `recompiled` is true. */
  private applyMesh(mesh: VfxMeshDoc): MeshApplyResult {
    let view = this.meshViews.get(mesh.id);
    const created = view === undefined;
    if (view === undefined) {
      view = new MeshView(
        this.vfxGroup,
        this.resolveTexture,
        this.renderRegistry,
        this.renderBackend,
        () => this.resolveAssets().geometries,
      );
      this.meshViews.set(mesh.id, view);
    }
    const renderSnapshot = serializeGraph(mesh.renderGraph, GraphKind.Render);
    // Geometry and compositing come from the surface sink. Sort is emitter-only.
    const config = readRenderSinkConfig(mesh.renderGraph);
    const applied = view.apply(
      renderSnapshot,
      config.geometry,
      config.renderMode,
      config.castShadow,
      config.receiveShadow,
    );
    return {
      renderSnapshot,
      // As for an emitter: a link failure of a program an earlier apply built.
      renderStatus: withLinkFailure(applied, view.programLinkFailures(this.renderer).render),
      recompiled: created || applied.status === "recompiled",
    };
  }
}

export interface ParticleOverflow {
  readonly count: number;
  /** Some visible emitter cannot report its overflow (GPU-driven), so `count` leaves it out. */
  readonly partial: boolean;
}

/**
 * Whether the apply rebuilt the runtime emitter. A render-only edit can recompile the render graph
 * yet swap it in place without a rebuild.
 */
function isRecompiled(result: SceneApplyResult): boolean {
  return result.emitterRebuilt === true;
}

interface MeshApplyResult {
  readonly renderSnapshot: FXGraphSnapshotData;
  readonly renderStatus: LiveApplyStatus;
  readonly recompiled: boolean;
}

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
