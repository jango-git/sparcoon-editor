/**
 * Turns an emitter's authored graphs (render, behavior, and its trail when it has one) into
 * artifacts and runs them through the runtime executor - the editor's own live gate (the runtime
 * has none), deciding between a full rebuild, an in-place render or trail swap, and a value-only
 * rebind. The trail graph's own live compile and built state live in {@link EmitterTrail}.
 */

import type { BufferGeometry, Camera, Object3D, Texture, WebGLRenderer } from "three";
import { FXEmitter } from "sparcoon/editor";
import type {
  FXApplyValues,
  FXDeathSource,
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleDeath,
  FXParticleDeathListener,
  FXSpawnTarget,
} from "sparcoon/editor";
import type { FXBehaviorArtifact, FXParticleKernelArtifact, FXRenderArtifact } from "sparcoon";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import {
  collectAttributeRequests,
  mergeAttributeCollections,
} from "../engine/core/compiler/collectAttributeRequests";
import {
  PARAM_COMPONENTS,
  paramBindingName,
  paramUniformName,
} from "../engine/nodes-std/paramSupport.Internal";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXCompiledBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { FXBehaviorLiveBackend } from "../engine/behavior/live/FXBehaviorLiveBackend";
import { buildParticleBehaviorTargets } from "../engine/behavior/FXParticleBehaviorTarget";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { buildParticleTarget } from "../engine/render/target/FXParticleRenderTarget";
import { collectRenderCapabilities } from "../engine/core/compiler/collectRenderCapabilities";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
  assembleRenderArtifact,
} from "../engine/emit/assembleArtifacts";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { EditorAttribute } from "../domain/graphModel";
import {
  encodeGeometrySource,
  toArtifactGeometrySource,
  type RenderMode,
  type RenderSinkConfig,
  type SpawnSinkConfig,
} from "../domain/nodePalette";
import {
  emitterRenderBudgetFindings,
  RenderBudgetMemo,
  type RenderBudgetFindings,
} from "../domain/renderBudget";
import { undeclaredAttributeErrors } from "../domain/serialize";
import { kernelWrittenBuffers, unwrittenAttributeWarnings } from "../domain/attributeChecks";
import type { LiveApplyStatus } from "../model/editorState";
import type { Transform } from "../model/transform";
import { normalizeQuat } from "../model/transform";
import type { GraphApplier, GraphApplyResult, TrailApplyInput } from "../model/pipeline";
import {
  blocked,
  invalid,
  invalidFromErrors,
  REBOUND,
  RECOMPILED,
  withWarnings,
} from "./applyStatus.Internal";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { externalSlots } from "./externalSlots";
import { EmitterTrail, type AssembledTrail } from "./emitterTrail.Internal";
import { gpuSortWarnings } from "../domain/sortChecks";
import { unboundedLifetimeWarnings } from "../domain/lifetimeBound";
import { trailSortError } from "../domain/trailChecks";
import { depthFadeModeErrors } from "../domain/depthFadeChecks";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";

/** Resolves a Texture node's name to a live Three texture (or a fallback). */
export type TextureResolver = (paramName: string) => Texture;

/** The runnable artifacts assembled from the live graphs' compiled IR. */
interface PreviewArtifacts {
  readonly render: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
  readonly gpuBehavior?: FXParticleKernelArtifact;
  /** The trail's runtime options and the sink config they were assembled from, with the live
   *  trail graph they came from; absent when the emitter has no trail. */
  readonly trail?: AssembledTrail & { readonly live: EmitterTrail };
}

/** Every material `artifacts` draws with: the particles', then the trail's. One parameter
 *  namespace spans them all - the runtime routes a value to every material that declares it. */
function renderArtifactsOf(artifacts: PreviewArtifacts): readonly FXRenderArtifact[] {
  return artifacts.trail === undefined
    ? [artifacts.render]
    : [artifacts.render, artifacts.trail.options.render];
}

/** The statuses of a held apply: each graph named here gets its own, every other one is blocked. */
interface HeldStatuses {
  readonly render?: LiveApplyStatus | undefined;
  readonly behavior?: LiveApplyStatus | undefined;
  readonly trail?: LiveApplyStatus | undefined;
}

/** An apply that changed nothing in the running emitter; the trail's status only with a trail. */
function heldResult(hasTrail: boolean, statuses: HeldStatuses): GraphApplyResult {
  return {
    render: statuses.render ?? blocked(),
    behavior: statuses.behavior ?? blocked(),
    ...(hasTrail ? { trail: statuses.trail ?? blocked() } : {}),
    emitterRebuilt: false,
  };
}

// What burst/play return with no emitter built: never a scheduled handler.
const NO_HANDLER = -1;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One emitter's preview: its live graphs and the runtime emitter they build, rebuilt on a
 * structural edit. A spawn target and a death source in its own right (what a death reaction is
 * wired between, see SceneEmitters), so a link outlives every rebuild of either side.
 */
export class EmitterView implements GraphApplier, FXSpawnTarget, FXDeathSource {
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  private readonly behaviorLive: FXLiveGraph<FXBehaviorNode, FXCompiledBehaviorBundle>;
  // The trail graph's live part, created when the emitter first has a trail and dropped with it.
  private liveTrail: EmitterTrail | undefined = undefined;
  private emitter: FXEmitter | undefined = undefined;
  // Who listens to this view's particles' deaths, and the running emitter's subscription feeding
  // them - re-made on every rebuild (see installEmitter).
  private readonly deathListeners = new Set<FXParticleDeathListener>();
  private detachDeaths: (() => void) | undefined = undefined;

  // Latest installed IR + the attribute set it was compiled over (captured on each install).
  private shader: FXCompiledShader | undefined = undefined;
  private kernel: FXCompiledKernel | undefined = undefined;
  // The "standard" (GLSL/transform-feedback) family's own compiled program - undefined when the
  // flag is off or that family failed to compile this graph (FXCompiledBehaviorBundle.
  // standardProgram, unwrapped here the same way this.kernel unwraps bundle.kernel).
  private standardProgram: FXFusedProgramStandard | undefined = undefined;
  private renderAttributes: readonly FXAttributeRequest[] = [];
  private behaviorAttributes: readonly FXAttributeRequest[] = [];

  private readonly budget = new RenderBudgetMemo();

  // The artifacts the running emitter last accepted - kept so the timeline value-drive can find
  // each param's slot names and baked baseline (to revert a param that stops being driven).
  // Reassembled every apply (no re-compile), but replaced only once the emitter takes them.
  private artifacts: PreviewArtifacts | undefined = undefined;
  // The emitter's overflow count at its last reset, so the viewport reports one run's losses.
  private overflowAtReset = 0;

  // The exact IR + runtime shape the emitter was built from - compared against the latest to
  // force a rebuild on drift (recompile-while-other-invalid, or a geometry/renderMode/shadow change).
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtKernel: FXCompiledKernel | undefined = undefined;
  private builtGeometryKey: string | undefined = undefined;
  // Only meaningful for `config.geometry.kind === "custom"`: catches a mesh asset that was
  // deleted/re-uploaded under the same authored name, which a built emitter can't pick up live.
  private builtCustomGeometryRef: BufferGeometry | undefined = undefined;
  private builtRenderMode: RenderMode | undefined = undefined;
  // Surface-sink params, invisible to the live gate's IR hash - tracked to force a rebuild on
  // flip (the depth material is attached at build time in installEmitter).
  private builtCastShadow = false;
  private builtReceiveShadow = false;
  // The spawn sink's "Try GPU simulation" flag and expected-particle-count, also invisible to
  // the live gate's IR hash - tracked the same way, since editing either alone must still force
  // a rebuild through installEmitter (a capacity edit resizes the state buffers either backend).
  private builtTryGpuSimulation = false;
  private builtExpectedCapacity = 0;
  // The current apply()'s spawn-sink flag, read by the behavior target-builder closure in the
  // constructor below - FXBehaviorTargets is derived per snapshot, so this must be current
  // before behaviorLive.apply runs each call.
  private currentTryGpuSimulation = false;

  // param names driven by the timeline last frame - so one that drops out reverts to baseline.
  private readonly drivenParams = new Set<string>();
  // The last transform applied, re-asserted onto a freshly (re)built emitter so a structural
  // edit never snaps the pose back to the origin between rebuild and the next drive tick.
  private lastTransform: Transform | undefined = undefined;
  // The last visibility set (the outline's mute toggle), re-asserted the same way so a rebuild
  // never flashes a muted emitter visible again.
  private lastVisible = true;
  // The persistent preview gizmo (wireframe box), re-parented onto each rebuilt emitter Object3D.
  private readonly marker: GizmoMarker = createGizmoMarker("emitter");

  // Kept to build the trail's live graph lazily, the same way the render one is built.
  private readonly renderRegistry: FXNodeRegistry<FXRenderNode>;
  private readonly renderBackend: FXGLSLRenderTier;

  constructor(
    private readonly parent: Object3D,
    private readonly resolveTexture: TextureResolver,
    private readonly camera: Camera,
    // The live renderer - handed to installEmitter's GPU (transform-feedback) driver gate so it
    // can check capabilities.isWebGL2 and construct against the real WebGL2 context.
    private readonly renderer: WebGLRenderer,
    // Node registries are stateless factory maps, so every view shares one pair (owned by
    // SceneEmitters) rather than re-registering the standard node set per emitter.
    renderRegistry: FXNodeRegistry<FXRenderNode>,
    behaviorRegistry: FXNodeRegistry<FXBehaviorNode>,
    // Which GLSL tier this view's live render graph compiles with (settings/renderBackend.ts) -
    // fixed for the session; the preview's own switch reloads the page to change it.
    renderBackend: FXGLSLRenderTier,
    // The content library's live mesh geometries, by name - a "custom" geometry source resolves
    // through this the same way an external texture resolves through `resolveTexture`.
    private readonly resolveMeshGeometries: () => Readonly<
      Record<string, BufferGeometry>
    > = () => ({}),
  ) {
    this.renderRegistry = renderRegistry;
    this.renderBackend = renderBackend;
    this.renderLive = new FXLiveGraph(
      new FXGraphReconciler(renderRegistry),
      new FXRenderLiveBackend(
        renderBackend,
        // The target is derived per snapshot from the graph's attributes (lighting-model-independent).
        (attributes) => buildParticleTarget(attributes),
        (compiled) => {
          this.shader = compiled;
          this.renderAttributes = collectAttributeRequests(this.renderLive.graphView).requests;
        },
      ),
    );
    this.behaviorLive = new FXLiveGraph(
      new FXGraphReconciler(behaviorRegistry),
      new FXBehaviorLiveBackend(
        (bundle) => {
          this.kernel = bundle.kernel;
          this.standardProgram = bundle.standardProgram;
          this.behaviorAttributes = collectAttributeRequests(this.behaviorLive.graphView).requests;
        },
        (attributes) => buildParticleBehaviorTargets(attributes, this.currentTryGpuSimulation),
      ),
    );
  }

  /** Currently alive particle count for this emitter (0 before an emitter is built). */
  public get particleCount(): number {
    return this.emitter?.particleCount ?? 0;
  }

  /** Births lost to a full ring since the emitter was last reset or built (its capacity is too
   *  small), or `undefined` when that is unknowable - a GPU-driven emitter, or none built yet. */
  public get particleOverflowCount(): number | undefined {
    const total = this.emitter?.particleOverflowCount;
    return total === undefined ? undefined : total - this.overflowAtReset;
  }

  /** The runtime emitter's Object3D (its transform is the emitter's pose), or `undefined` before build. */
  public get object3D(): Object3D | undefined {
    return this.emitter;
  }

  /** Whether the outline's mute toggle currently shows this emitter (survives a rebuild). */
  public get visible(): boolean {
    return this.lastVisible;
  }

  /** Whether the running emitter draws a material that reads the scene depth (a Depth Fade). */
  public get readsSceneDepth(): boolean {
    return (
      this.artifacts?.render.sceneDepth === true ||
      this.artifacts?.trail?.options.render.sceneDepth === true
    );
  }

  /** The gizmo's invisible pick proxy, raycast to select this emitter in the viewport. */
  public get pickTarget(): Object3D {
    return this.marker.pickTarget;
  }

  public apply(
    renderSnapshot: FXGraphSnapshotData,
    behaviorSnapshot: FXGraphSnapshotData,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    // The sole source of truth for which attributes exist - checked against every
    // custom-attribute request in either graph, so a name left over after a
    // removal/retype is a held error.
    declaredAttributes: readonly EditorAttribute[],
    trailInput?: TrailApplyInput,
  ): GraphApplyResult {
    const { geometry, renderMode, castShadow } = config;
    // The trail's live part and this apply's input to it, narrowed once: both or neither.
    const trail = this.liveTrailFor(trailInput);
    // Read by the behaviorLive target-builder closure (constructor) - must be set before
    // behaviorLive.apply runs below, since validate/previewHash/compile all read it synchronously.
    this.currentTryGpuSimulation = spawnConfig.tryGpuSimulation;
    const hold = (statuses: HeldStatuses): GraphApplyResult =>
      heldResult(trail !== undefined, statuses);

    // Each live graph reconciles + gates internally and never throws: a bad edit (unknown node,
    // failed validation, a codegen fault) comes back in its `errors`, holding the last good IR.
    const renderResult = this.renderLive.apply(renderSnapshot);
    const behaviorResult = this.behaviorLive.apply(behaviorSnapshot);
    const trailResult = trail?.live.apply(trail.input.snapshot);

    // The preview is all-or-nothing (the artifacts run as one emitter). If any graph is invalid,
    // surface its node-attributed errors and leave the last emitter running.
    const invalidOf = (
      result: { status: string; errors: readonly FXCompilerError[] } | undefined,
    ): LiveApplyStatus | undefined =>
      result?.status === "invalid" ? invalidFromErrors(result.errors) : undefined;
    if (
      renderResult.status === "invalid" ||
      behaviorResult.status === "invalid" ||
      trailResult?.status === "invalid"
    ) {
      return hold({
        render: invalidOf(renderResult),
        behavior: invalidOf(behaviorResult),
        trail: invalidOf(trailResult),
      });
    }

    // Every graph is valid, so each live graph has installed its current IR through the backend
    // callback above; guard defensively (a valid apply always installs them before we get here).
    if (this.shader === undefined || this.kernel === undefined) {
      const held = invalid(["EmitterView: no compiled IR after a valid apply"]);
      return hold({ render: held, behavior: held });
    }
    if (trail !== undefined && !trail.live.compiled) {
      return hold({ trail: invalid(["EmitterView: no compiled trail IR after a valid apply"]) });
    }

    // A *cross-graph* attribute conflict (behavior writes `foo` as vec3, render reads vec2) is
    // invisible to each graph's own validation - hold it as `invalid` rather than let the rebuild throw.
    const crossErrors = mergeAttributeCollections(
      { requests: this.renderAttributes, errors: [] },
      { requests: this.behaviorAttributes, errors: [] },
    ).errors;
    const attributeErrors = [
      ...crossErrors,
      ...undeclaredAttributeErrors(
        this.renderAttributes,
        this.behaviorAttributes,
        declaredAttributes,
      ),
    ];
    const renderErrors = [
      ...attributeErrors,
      ...depthFadeModeErrors(this.renderLive.graphView, renderMode),
    ];
    if (renderErrors.length > 0) {
      return hold({ render: invalidFromErrors(renderErrors) });
    }
    if (trail !== undefined) {
      // A sort scrambles the per-slot path a trail records: the fix is on the render graph's
      // sink, so the error is pinned there, and repeated on the trail.
      const sortError = trailSortError(config.sortInterval);
      if (sortError !== undefined) {
        return hold({
          render: invalidFromErrors([sortError]),
          trail: invalidFromErrors([{ code: sortError.code, message: sortError.message }]),
        });
      }
      const trailErrors = [
        ...trail.live.attributeErrors(this.behaviorAttributes, declaredAttributes),
        ...trail.live.depthFadeErrors(trail.input.config.renderMode),
      ];
      if (trailErrors.length > 0) {
        return hold({ trail: invalidFromErrors(trailErrors) });
      }
    }

    // Assembly copies compiled strings + snapshots values (no code generation), so a value-only
    // rebind never re-pays the compile. A same-name binding conflict would throw here; hold rather than crash.
    let artifacts: PreviewArtifacts;
    try {
      artifacts = {
        render: assembleRenderArtifact(
          this.shader,
          collectRenderCapabilities(this.renderLive.graphView),
          toArtifactGeometrySource(geometry),
          this.renderAttributes,
          renderMode,
        ),
        behavior: assembleBehaviorArtifact(this.kernel),
        ...(this.standardProgram !== undefined
          ? { gpuBehavior: assembleGpuKernelArtifact(this.standardProgram) }
          : {}),
        ...(trail === undefined
          ? {}
          : { trail: { ...trail.live.assemble(trail.input.config), live: trail.live } }),
      };
    } catch (error) {
      const held = invalid([describeError(error)]);
      return hold({ render: held, behavior: held, trail: held });
    }

    // An effect some GPUs could not link is held like any other graph error, before it replaces
    // anything; one past only the Baseline tier's limits runs, with a warning. Each graph's count
    // is its own: a failure counting the trail's materials is the trail's.
    let budget: RenderBudgetFindings;
    try {
      budget = this.budgetFindings(artifacts, renderMode, castShadow);
    } catch (error) {
      return hold({ render: invalid([describeError(error)]) });
    }
    if (budget.errors.length > 0) {
      return hold({ render: invalidFromErrors(budget.errors) });
    }
    let trailBudget: RenderBudgetFindings | undefined;
    if (artifacts.trail !== undefined) {
      try {
        trailBudget = artifacts.trail.live.budgetFindings(
          artifacts.trail,
          artifacts.behavior.buffers,
          this.behaviorAttributes,
          // The same "can this emitter run on the GPU" the export counts by: a compiled kernel,
          // whose slot (in its order) the GPU history copies.
          this.standardProgram?.buffers,
        );
      } catch (error) {
        return hold({ trail: invalid([describeError(error)]) });
      }
      if (trailBudget.errors.length > 0) {
        return hold({ trail: invalidFromErrors(trailBudget.errors) });
      }
    }

    // A read of an attribute nothing writes runs (as a constant 0) - the same check the export runs.
    const written = kernelWrittenBuffers(this.kernel);
    const renderWarnings = [
      ...budget.warnings,
      ...unwrittenAttributeWarnings(this.renderLive.graphView, written, declaredAttributes),
      // The same "does this emitter run on the GPU" installEmitter decides by.
      ...gpuSortWarnings(
        config.sortInterval,
        spawnConfig.tryGpuSimulation &&
          this.renderer.capabilities.isWebGL2 &&
          artifacts.gpuBehavior !== undefined,
      ),
    ];
    const trailWarnings =
      trail === undefined || trailBudget === undefined
        ? undefined
        : [
            ...trailBudget.warnings,
            ...trail.live.unwrittenAttributeWarnings(written, declaredAttributes),
          ];

    const result = this.applyArtifacts(artifacts, config, spawnConfig, {
      render: renderResult.status === "recompiled",
      behavior: behaviorResult.status === "recompiled",
    });
    return {
      ...result,
      render: withWarnings(result.render, renderWarnings),
      // The preview runs without the bound (only an export settles by it), but warns as the export.
      behavior: withWarnings(result.behavior, unboundedLifetimeWarnings(behaviorSnapshot)),
      ...(result.trail === undefined || trailWarnings === undefined
        ? {}
        : { trail: withWarnings(result.trail, trailWarnings) }),
    };
  }

  public destroy(): void {
    this.marker.object.removeFromParent();
    this.marker.dispose();
    this.deathListeners.clear();
    this.detachDeaths = undefined;
    this.emitter?.destroy();
    this.emitter = undefined;
    this.artifacts = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
    this.behaviorLive.destroy();
    this.liveTrail?.destroy();
    this.liveTrail = undefined;
  }

  /** Highlights this emitter's preview gizmo as the selected one (accent tint), or not. */
  public setSelected(selected: boolean): void {
    this.marker.setSelected(selected);
  }

  /** Scrubs sampled param values into the running emitter; a param dropped since last frame
   * reverts to its baked baseline (deleting a keyframe restores the inline default). */
  public driveParamValues(values: ReadonlyMap<string, number | readonly number[]>): void {
    if (this.emitter === undefined || this.artifacts === undefined) {
      return;
    }
    const artifacts = this.artifacts;
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    const bindings: Record<string, number | Float32Array> = {};

    for (const [name, value] of values) {
      this.writeParamSlots(artifacts, name, value, uniforms, bindings);
      this.drivenParams.add(name);
    }
    for (const name of [...this.drivenParams]) {
      if (!values.has(name)) {
        this.writeParamBaseline(artifacts, name, uniforms, bindings);
        this.drivenParams.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0 || Object.keys(bindings).length > 0) {
      this.emitter.applyValues({ uniforms, bindings });
    }
  }

  /** Queues a burst on the running emitter (it lands on the next simulation step); a handler, or
   *  -1 with no emitter built. */
  public burst(count: number, options?: Partial<FXEmitterBurstOptions>): number {
    return this.emitter?.burst(count, options) ?? NO_HANDLER;
  }

  /** Starts a continuous emission on the running emitter; a handler, or -1 with none built. */
  public play(rate: number, options?: Partial<FXEmitterPlayOptions>): number {
    return this.emitter?.play(rate, options) ?? NO_HANDLER;
  }

  /**
   * Calls `listener` for each death of this view's particles - across rebuilds. Silent while the
   * running emitter cannot report deaths (GPU-driven: a source is built on the CPU, see
   * `effectiveSpawnConfig`, but a held graph error can keep an older GPU emitter running).
   */
  public onParticleDeath(listener: FXParticleDeathListener): () => void {
    this.deathListeners.add(listener);
    this.attachDeaths();
    return (): void => {
      if (this.deathListeners.delete(listener) && this.deathListeners.size === 0) {
        this.detachDeaths?.();
        this.detachDeaths = undefined;
      }
    };
  }

  /** Playback looped: cancels active emission, keeping live particles - a seamless loop. */
  public loopTimeline(): void {
    this.emitter?.loopTimeline();
  }

  /** Clears live particles and cancels any active emission - the emitter returns to idle, and
   *  {@link particleOverflowCount} starts counting the next run from zero. */
  public reset(): void {
    this.emitter?.stop();
    this.emitter?.reset();
    this.overflowAtReset = this.emitter?.particleOverflowCount ?? 0;
  }

  /** Shows/hides the emitter in the preview (the outline's mute toggle). Cached like the pose. */
  public setVisible(visible: boolean): void {
    this.lastVisible = visible;
    if (this.emitter !== undefined) {
      this.emitter.visible = visible;
    }
  }

  /** Poses the running emitter's Object3D. Cached so a later rebuild keeps the pose. */
  public applyTransform(transform: Transform): void {
    this.lastTransform = transform;
    if (this.emitter !== undefined) {
      applyTransform(this.emitter, transform);
    }
  }

  /**
   * The trail's live part for this apply, paired with its input: built the first time the emitter
   * has a trail, and dropped (with everything compiled from it) once it has none, so turning a
   * trail back on starts from a clean compile.
   */
  private liveTrailFor(
    input: TrailApplyInput | undefined,
  ): { readonly live: EmitterTrail; readonly input: TrailApplyInput } | undefined {
    if (input === undefined) {
      this.liveTrail?.destroy();
      this.liveTrail = undefined;
      return undefined;
    }
    this.liveTrail ??= new EmitterTrail(this.renderRegistry, this.renderBackend);
    return { live: this.liveTrail, input };
  }

  /**
   * Puts valid `artifacts` into effect the cheapest way their changes allow: a full rebuild when
   * the behavior half reshaped; else an in-place trail swap when the trail turned on/off or
   * reshaped, and an in-place render swap when the render half did; values (behavior bindings,
   * the uniforms of whichever material was not swapped) are scrubbed in on every in-place path.
   * `recompiled` says which half's graph just recompiled. `artifacts` become the installed ones
   * only once the emitter has taken them.
   */
  private applyArtifacts(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    recompiled: { readonly render: boolean; readonly behavior: boolean },
  ): GraphApplyResult {
    // Surface-sink params, invisible to the live gate's IR hash like geometry/renderMode - the
    // structural chain below tracks them to force a rebuild (the depth material is attached on build).
    const { geometry, renderMode, sortInterval, castShadow, receiveShadow } = config;
    const currentCustomGeometryRef =
      geometry.kind === "custom" ? this.resolveMeshGeometries()[geometry.meshAssetName] : undefined;
    // Everything that reshapes the render half specifically (new GLSL, geometry primitive/mesh,
    // composite mode, shadow flags) - independent of whether the behavior half changed at all, so
    // a render-only edit below can hot-swap in place instead of a full rebuild.
    const renderStructural =
      recompiled.render ||
      // geometry/renderMode reshape the runtime mesh+material, not the IR - force a rebuild here.
      // Compared by encoded key, not identity: `geometry` is a fresh object every apply.
      encodeGeometrySource(geometry) !== this.builtGeometryKey ||
      // A "custom" reference whose bound mesh asset was deleted or re-uploaded (a new baked object,
      // same name) - the authored param string above is unchanged, so only this catches it.
      currentCustomGeometryRef !== this.builtCustomGeometryRef ||
      renderMode !== this.builtRenderMode ||
      // Shadow flags reshape the runtime mesh (attach/detach the depth material), not the IR.
      castShadow !== this.builtCastShadow ||
      receiveShadow !== this.builtReceiveShadow ||
      // The emitter fell behind during an invalid interlude on the other graph - resync.
      this.shader !== this.builtShader;
    // Everything that reshapes the behavior half specifically (simulation, capacity, CPU/GPU
    // backend choice) - only this half genuinely needs a full FXEmitter.fromArtifacts rebuild,
    // since only a fresh driver can resize particle buffers or swap backend.
    const behaviorStructural =
      recompiled.behavior ||
      spawnConfig.tryGpuSimulation !== this.builtTryGpuSimulation ||
      spawnConfig.expectedCapacity !== this.builtExpectedCapacity ||
      this.kernel !== this.builtKernel;

    if (this.emitter === undefined || behaviorStructural) {
      return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
    }

    // The trail turning on/off, a new trail shader, or new history settings - swapped in place.
    const { trail } = artifacts;
    const trailStructural =
      trail === undefined
        ? this.emitter.hasTrail
        : trail.live.needsSwap(trail, this.emitter.hasTrail);
    if (trailStructural) {
      try {
        this.emitter.applyTrailArtifact(
          trail?.options,
          trail === undefined ? {} : this.resolveExternalTextures(trail.options.render),
        );
      } catch (error) {
        return heldResult(true, { trail: invalid([describeError(error)]) });
      }
      trail?.live.markBuilt(trail);
    }
    const trailResult =
      trail === undefined ? {} : { trail: trailStructural ? RECOMPILED : REBOUND };

    if (renderStructural) {
      try {
        this.emitter.applyRenderArtifact(artifacts.render, {
          textures: this.resolveExternalTextures(artifacts.render),
          geometries: this.resolveMeshGeometries(),
          castShadow,
          receiveShadow,
        });
      } catch (error) {
        // The active driver refused (a genuine attribute-layout change only a fresh driver can
        // safely resize buffers for) - fall back to a full rebuild rather than surfacing this as
        // an error; the editor never asked the user to know which path preserved the particles.
        console.warn(
          "EmitterView: a render-only artifact swap was rejected (attribute layout changed) - " +
            "falling back to a full rebuild.",
          error,
        );
        return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
      }
      this.builtShader = this.shader;
      this.builtGeometryKey = encodeGeometrySource(geometry);
      this.builtCustomGeometryRef = currentCustomGeometryRef;
      this.builtRenderMode = renderMode;
      this.builtCastShadow = castShadow;
      this.builtReceiveShadow = receiveShadow;
    }

    // Only values changed in whatever was not swapped above - the behavior bindings always, and an
    // unswapped trail's or render's uniforms. Scrub them into the running emitter so live particles
    // never reset (external textures ride the value path too, so a texture swap rebinds).
    this.emitter.applyValues(this.valuesFromArtifacts(artifacts));
    this.applySorting(sortInterval);
    this.artifacts = artifacts;
    // Particle buffers/instance count/simulation were never touched - no rebuild happened, so
    // playback must not restart over this (see emitterRebuilt on GraphApplyResult).
    return {
      render: renderStructural ? RECOMPILED : REBOUND,
      behavior: REBOUND,
      ...trailResult,
      emitterRebuilt: false,
    };
  }

  /**
   * What `artifacts`' materials take of a GPU, against each tier's minimums (see
   * `emitterRenderBudgetFindings`) - memoized, the GPU kernel's program included in the key: its
   * slot layout decides the Standard-tier count, and it is replaced on every behavior recompile.
   */
  private budgetFindings(
    artifacts: PreviewArtifacts,
    renderMode: string,
    castShadow: boolean,
  ): RenderBudgetFindings {
    const program = this.standardProgram;
    return this.budget.get(
      [
        this.shader,
        this.behaviorAttributes,
        this.renderAttributes,
        program,
        renderMode,
        castShadow,
      ],
      () =>
        emitterRenderBudgetFindings(
          artifacts.render,
          artifacts.behavior.buffers,
          castShadow,
          program?.buffers,
        ),
    );
  }

  /** Full rebuild path: a fresh `FXEmitter.fromArtifacts` replacing the previous one - resets
   *  particle buffers and playback. Used for the first build, any behavior-structural change, or
   *  as the fallback when a render-only swap ({@link applyRenderArtifact}) refuses a genuine
   *  attribute-layout change it cannot apply in place. */
  private rebuildEmitter(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    currentCustomGeometryRef: BufferGeometry | undefined,
  ): GraphApplyResult {
    const { geometry, renderMode, sortInterval, castShadow, receiveShadow } = config;
    try {
      this.installEmitter(
        artifacts,
        castShadow,
        receiveShadow,
        spawnConfig.tryGpuSimulation,
        spawnConfig.expectedCapacity,
      );
    } catch (error) {
      // The runtime rejected the artifact pair; installEmitter builds the new emitter before
      // dropping the old, so the last good preview still runs - hold rather than crash.
      const held = invalid([describeError(error)]);
      return {
        render: held,
        behavior: held,
        ...(artifacts.trail === undefined ? {} : { trail: held }),
        emitterRebuilt: false,
      };
    }
    this.builtShader = this.shader;
    this.builtKernel = this.kernel;
    this.builtGeometryKey = encodeGeometrySource(geometry);
    this.builtCustomGeometryRef = currentCustomGeometryRef;
    this.builtRenderMode = renderMode;
    this.builtCastShadow = castShadow;
    this.builtReceiveShadow = receiveShadow;
    this.builtTryGpuSimulation = spawnConfig.tryGpuSimulation;
    this.builtExpectedCapacity = spawnConfig.expectedCapacity;
    artifacts.trail?.live.markBuilt(artifacts.trail);
    this.applySorting(sortInterval);
    this.artifacts = artifacts;
    return {
      render: RECOMPILED,
      behavior: RECOMPILED,
      ...(artifacts.trail === undefined ? {} : { trail: RECOMPILED }),
      emitterRebuilt: true,
    };
  }

  /** Every external sampler slot `artifact` declares, bound to its live texture - shared by
   *  {@link installEmitter} (a full rebuild) and the render-only swap path (`applyRenderArtifact`). */
  private resolveExternalTextures(artifact: FXRenderArtifact): Record<string, Texture> {
    const textures: Record<string, Texture> = {};
    for (const slot of externalSlots(artifact)) {
      textures[paramUniformName(slot.paramName)] = this.resolveTexture(slot.paramName);
    }
    return textures;
  }

  /** Configures camera depth-sorting from `sortInterval` (frames/sort; 0 disables). Applied on
   * every reconcile, so live-editing the field updates in place. */
  private applySorting(sortInterval: number): void {
    if (this.emitter === undefined) {
      return;
    }
    if (sortInterval > 0) {
      this.emitter.sortCamera = this.camera;
      this.emitter.sortFraction = 1 / sortInterval;
    } else {
      // The runtime disables sorting when `sortCamera` is absent; clear it rather than assign
      // `undefined` (rejected under exactOptionalPropertyTypes).
      delete this.emitter.sortCamera;
    }
  }

  /** The live uniform/binding values to scrub into a running emitter on a rebind. */
  private valuesFromArtifacts(artifacts: PreviewArtifacts): FXApplyValues {
    const uniforms: Record<string, number | readonly number[] | Texture> = {};
    for (const render of renderArtifactsOf(artifacts)) {
      // A name every material declares carries one default (`param-value-conflict`), so the first
      // material's value stands for all of them.
      for (const [name, init] of Object.entries(render.uniforms)) {
        if (init.value !== undefined && !(name in uniforms)) {
          uniforms[name] = init.value;
        }
      }
      // External sampler slots carry no baked value: bind each to its live texture.
      for (const slot of externalSlots(render)) {
        uniforms[slot.uniformName] = this.resolveTexture(slot.paramName);
      }
    }
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, slot] of Object.entries(artifacts.behavior.bindings)) {
      bindings[name] = slot.value;
    }
    return { uniforms, bindings };
  }

  /** Writes one param's value into whichever render uniform / behavior bindings it declares. */
  private writeParamSlots(
    artifacts: PreviewArtifacts,
    name: string,
    value: number | readonly number[],
    uniforms: Record<string, number | readonly number[] | Texture>,
    bindings: Record<string, number | Float32Array>,
  ): void {
    const uniformKey = paramUniformName(name);
    if (renderArtifactsOf(artifacts).some((render) => uniformKey in render.uniforms)) {
      uniforms[uniformKey] = value;
    }
    // Behavior scalarizes a vector into one binding per component (`b_param_<name>_x/...`);
    // a scalar param is the single `b_param_<name>`.
    const bindingKey = paramBindingName(name);
    if (bindingKey in artifacts.behavior.bindings) {
      bindings[bindingKey] = typeof value === "number" ? value : (value[0] ?? 0);
      return;
    }
    const vector = typeof value === "number" ? [value] : value;
    PARAM_COMPONENTS.forEach((component, index) => {
      const key = `${bindingKey}_${component}`;
      if (key in artifacts.behavior.bindings) {
        bindings[key] = vector[index] ?? 0;
      }
    });
  }

  /** Restores one param's baked baseline into its declared slots (a param that stopped driving). */
  private writeParamBaseline(
    artifacts: PreviewArtifacts,
    name: string,
    uniforms: Record<string, number | readonly number[] | Texture>,
    bindings: Record<string, number | Float32Array>,
  ): void {
    const uniformKey = paramUniformName(name);
    const uniform = renderArtifactsOf(artifacts)
      .map((render) => render.uniforms[uniformKey])
      .find((candidate) => candidate !== undefined);
    if (uniform !== undefined && "value" in uniform) {
      uniforms[uniformKey] = uniform.value;
    }
    for (const [key, slot] of Object.entries(artifacts.behavior.bindings)) {
      if (key === paramBindingName(name) || key.startsWith(`${paramBindingName(name)}_`)) {
        bindings[key] = slot.value;
      }
    }
  }

  // Feeds this view's death listeners from the running emitter, once, when there are any and it
  // can report deaths.
  private attachDeaths(): void {
    if (
      this.detachDeaths !== undefined ||
      this.deathListeners.size === 0 ||
      this.emitter?.reportsParticleDeaths !== true
    ) {
      return;
    }
    this.detachDeaths = this.emitter.onParticleDeath(this.forwardDeath);
  }

  private readonly forwardDeath = (death: FXParticleDeath): void => {
    for (const listener of [...this.deathListeners]) {
      listener(death);
    }
  };

  /** Replaces the running emitter with a fresh one for the new artifacts. May throw (see caller). */
  private installEmitter(
    artifacts: PreviewArtifacts,
    castShadow: boolean,
    receiveShadow: boolean,
    tryGpuSimulation: boolean,
    expectedCapacity: number,
  ): void {
    // Every external sampler slot must be bound at build time (a missing one throws); a
    // deleted/absent texture resolves to a transparent fallback, keeping the preview alive.
    const textures = Object.assign(
      {},
      ...renderArtifactsOf(artifacts).map((render) => this.resolveExternalTextures(render)),
    ) as Record<string, Texture>;
    // Present only when actually compiled: `gpuKernel` is a bare optional under
    // exactOptionalPropertyTypes, so an explicit `undefined` value is rejected - omit the key.
    // isWebGL2 gates USE here only, never whether to compile (already compiled/cached above
    // regardless, so exportCompile.ts - which has no live renderer to gate on - stays consistent).
    const gpuKernel =
      tryGpuSimulation && this.renderer.capabilities.isWebGL2 ? artifacts.gpuBehavior : undefined;
    // Build the new emitter BEFORE dropping the old one: fromArtifacts can throw on a bad artifact
    // pair, and the caller holds the last good preview on a throw - so the old emitter must survive.
    const next = FXEmitter.fromArtifacts(artifacts.render, artifacts.behavior, {
      textures,
      geometries: this.resolveMeshGeometries(),
      castShadow,
      receiveShadow,
      renderer: this.renderer,
      expectedCapacity,
      ...(gpuKernel !== undefined ? { gpuKernel } : {}),
      ...(artifacts.trail !== undefined ? { trail: artifacts.trail.options } : {}),
    });
    this.detachDeaths = undefined; // went with the old emitter
    this.emitter?.destroy();
    this.emitter = next;
    this.attachDeaths();
    // A fresh emitter counts its overflow from zero.
    this.overflowAtReset = 0;
    this.parent.add(next);
    // The preview gizmo rides the emitter's Object3D, so re-parent it onto the fresh emitter.
    next.add(this.marker.object);
    // Re-assert the last pose + visibility onto the new Object3D (fromArtifacts starts visible, at
    // the origin).
    if (this.lastTransform !== undefined) {
      applyTransform(next, this.lastTransform);
    }
    next.visible = this.lastVisible;
    // No automatic emission: spawning is driven by the timeline's burst/play events, not by
    // the emitter's mere existence. A fresh emitter starts idle until an event fires.
  }
}

/** Writes a {@link Transform} onto a Three Object3D (rotation renormalized for safety). */
export function applyTransform(object: Object3D, transform: Transform): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  const quaternion = normalizeQuat(transform.rotation);
  object.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
}
