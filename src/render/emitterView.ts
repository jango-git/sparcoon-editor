/**
 * Turns an emitter's authored graphs (render, behavior, and its trail and ribbon when it has them)
 * into artifacts and runs them through the runtime executor - the editor's own live gate (the
 * runtime has none), deciding between a full rebuild, an in-place render or strip swap, and a
 * value-only rebind. Each strip graph's own live compile and built state live in
 * {@link EmitterStrip}.
 */

import type {
  FXBehaviorArtifact,
  FXGeometrySource,
  FXParticleKernelArtifact,
  FXRenderArtifact,
  FXUniformValue,
} from "sparcoon";
import type {
  FXApplyValues,
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleEventKind,
  FXParticleEventListener,
  FXParticleEventSource,
  FXSlotLayout,
  FXSpawnTarget,
} from "sparcoon/editor";
import { FXEmitter } from "sparcoon/editor";
import type { BufferGeometry, Camera, Object3D, Texture, WebGLRenderer } from "three";

import { kernelWrittenBuffers, unwrittenAttributeWarnings } from "../domain/attributeChecks";
import { depthFadeModeErrors } from "../domain/depthFadeChecks";
import type { EditorAttribute } from "../domain/graphModel";
import { unboundedLifetimeWarnings } from "../domain/lifetimeBound";
import { missingMeshAssetErrors } from "../domain/meshSurfaceChecks";
import {
  encodeGeometrySource,
  type RenderMode,
  type RenderSinkConfig,
  type SpawnSinkConfig,
  toArtifactGeometrySource,
} from "../domain/nodePalette";
import { type ReactionSource, reactionSourceOf } from "../domain/reactionLinking";
import {
  emitterRenderBudgetFindings,
  type FXRenderArtifactsByTier,
  type RenderBudgetFindings,
  RenderBudgetMemo,
} from "../domain/renderBudget";
import { undeclaredAttributeErrors } from "../domain/serialize";
import { hiddenParticlesSortError } from "../domain/stripChecks";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompiledBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXInheritEntry } from "../engine/behavior/FXInheritPlan";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { particleBehaviorTargetsFor } from "../engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorLiveBackend } from "../engine/behavior/live/FXBehaviorLiveBackend";
import {
  collectAttributeRequests,
  mergeAttributeCollections,
} from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
  assembleRenderArtifact,
} from "../engine/emit/assembleArtifacts";
import {
  PARAM_COMPONENTS,
  paramBindingName,
  paramUniformName,
} from "../engine/nodes-std/paramSupport.Internal";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import { buildParticleTarget } from "../engine/render/target/FXParticleRenderTarget";
import type { LiveApplyStatus } from "../model/editorState";
import { STRIP_NAMES, type StripName } from "../model/graphSlots";
import type {
  GraphApplier,
  GraphApplyResult,
  StripApplyInput,
  StripApplyInputs,
} from "../model/pipeline";
import type { Transform } from "../model/transform";
import { normalizeQuat } from "../model/transform";
import {
  blocked,
  invalid,
  invalidFromErrors,
  REBOUND,
  RECOMPILED,
  withWarnings,
} from "./applyStatus.Internal";
import { createGizmoMarker, type GizmoMarker } from "./emitterMarker";
import { type AssembledStrip, EmitterStrip } from "./emitterStrip.Internal";
import { everyTierShaders } from "./everyTierShaders";
import { externalSlots } from "./externalSlots";
import { ParticleEventForward } from "./particleEventForward";

/** Resolves a Texture node's name to a live Three texture (or a fallback). */
export type TextureResolver = (paramName: string) => Texture;

/** A strip assembled for one apply, with the live graph it came from. */
type LiveStrip<K extends StripName> = AssembledStrip<K> & { readonly live: EmitterStrip<K> };

/** The runnable artifacts assembled from the live graphs' compiled IR. */
interface PreviewArtifacts {
  readonly render: FXRenderArtifact;
  /** Whether the particles are drawn with {@link render} (the render sink's Draw Particles). */
  readonly drawParticles: boolean;
  readonly behavior: FXBehaviorArtifact;
  /** The compiled behavior `behavior` was assembled from: what its births and deaths hand out and
   *  what its births inherit (see `reactionLinking.ts`). */
  readonly kernel: FXCompiledKernel;
  readonly gpuBehavior?: FXParticleKernelArtifact;
  /** Each strip's runtime options and the sink config they were assembled from, with the live
   *  graph they came from; a strip the emitter does not have is absent. */
  readonly strips: { readonly [K in StripName]?: LiveStrip<K> };
}

/** The particles' render artifact, when they are drawn. */
function particlesOf(artifacts: PreviewArtifacts): FXRenderArtifact | undefined {
  return artifacts.drawParticles ? artifacts.render : undefined;
}

/** Every material `artifacts` draws with: the particles', then each strip's. One parameter
 *  namespace spans them all - the runtime routes a value to every material that declares it. */
function renderArtifactsOf(artifacts: PreviewArtifacts): readonly FXRenderArtifact[] {
  return [
    particlesOf(artifacts),
    ...STRIP_NAMES.map((name) => artifacts.strips[name]?.options.render),
  ].filter((render) => render !== undefined);
}

/** The statuses of a held apply: each graph named here gets its own, every other one is blocked. */
type HeldStatuses = {
  readonly [K in "render" | "behavior" | StripName]?: LiveApplyStatus | undefined;
};

/** An apply that changed nothing in the running emitter; a strip's status only with that strip. */
function heldResult(
  strips: ReadonlySet<StripName> | readonly StripName[],
  statuses: HeldStatuses,
): GraphApplyResult {
  const has = new Set(strips);
  return {
    render: statuses.render ?? blocked(),
    behavior: statuses.behavior ?? blocked(),
    ...Object.fromEntries(
      STRIP_NAMES.filter((name) => has.has(name)).map((name) => [
        name,
        statuses[name] ?? blocked(),
      ]),
    ),
    emitterRebuilt: false,
  };
}

// What burst/play return with no emitter built: never a scheduled handler.
const NO_HANDLER = -1;

// What a view with no running emitter inherits and hands out: nothing.
const NOTHING_INHERITED = new Float32Array(0);
const EMPTY_SLOT: FXSlotLayout = { stride: 0, fields: [] };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One emitter's preview: its live graphs and the runtime emitter they build, rebuilt on a
 * structural edit. A spawn target and a particle event source in its own right (what a reaction is
 * wired between, see SceneEmitters), so a link outlives every rebuild of either side.
 */
export class EmitterView implements GraphApplier, FXSpawnTarget, FXParticleEventSource {
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  // The render snapshot last applied: what the budget compiles the other tier from.
  private renderSnapshot: FXGraphSnapshotData | undefined = undefined;
  private readonly behaviorLive: FXLiveGraph<FXBehaviorNode, FXCompiledBehaviorBundle>;
  // Each strip graph's live part, created when the emitter first has that strip and dropped with it.
  private readonly liveStrips: Partial<Record<StripName, EmitterStrip>> = {};
  private emitter: FXEmitter | undefined = undefined;
  // Who listens to this view's particles' births and deaths, fed from the running emitter - its
  // subscriptions re-made on every rebuild (see installEmitter).
  private readonly events: Readonly<Record<FXParticleEventKind, ParticleEventForward>> = {
    birth: new ParticleEventForward("birth"),
    death: new ParticleEventForward("death"),
  };

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
  // The geometries the behavior samples, as built: a mesh asset re-uploaded under the same name
  // is a new geometry, which only a rebuild reads.
  private builtSurfaceGeometries: readonly (BufferGeometry | undefined)[] = [];
  private builtRenderMode: RenderMode | undefined = undefined;
  // The render sink's Draw Particles, as built - invisible to the IR hash like the shadow flags.
  private builtDrawParticles = true;
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

  // Kept to build each strip's live graph lazily, the same way the render one is built.
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
        (attributes, graph) =>
          particleBehaviorTargetsFor(graph, this.currentTryGpuSimulation, attributes),
      ),
    );
  }

  /** What the running emitter's births inherit when no reaction hands them anything; nothing while
   *  none is built. */
  public get inheritDefaults(): ArrayLike<number> {
    return this.emitter?.inheritDefaults ?? NOTHING_INHERITED;
  }

  /** The running emitter's particle slot, as its events hand it out; empty while none is built. */
  public get particleSlot(): FXSlotLayout {
    return this.emitter?.particleSlot ?? EMPTY_SLOT;
  }

  /** What the running emitter's births and deaths hand out, for a reaction to link; none while
   *  none is built. Read off the artifacts it was built from, so it matches {@link particleSlot}. */
  public get reactionSource(): ReactionSource | undefined {
    return this.emitter === undefined || this.artifacts === undefined
      ? undefined
      : reactionSourceOf(this.artifacts.kernel);
  }

  /** What the running emitter's births inherit, value by value; nothing while none is built. */
  public get inheritEntries(): readonly FXInheritEntry[] {
    return this.emitter === undefined ? [] : (this.artifacts?.kernel.inherit?.entries ?? []);
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
    const artifacts = this.artifacts;
    return (
      artifacts !== undefined && renderArtifactsOf(artifacts).some((render) => render.sceneDepth)
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
    stripInputs: StripApplyInputs = {},
  ): GraphApplyResult {
    const { geometry, renderMode, castShadow } = config;
    // Each strip's live part and this apply's input to it, narrowed once: both or neither.
    const strips = this.liveStripsFor(stripInputs);
    const stripNames = strips.map(({ name }) => name);
    // Read by the behaviorLive target-builder closure (constructor) - must be set before
    // behaviorLive.apply runs below, since validate/previewHash/compile all read it synchronously.
    this.currentTryGpuSimulation = spawnConfig.tryGpuSimulation;
    const hold = (statuses: HeldStatuses): GraphApplyResult => heldResult(stripNames, statuses);

    // Each live graph reconciles + gates internally and never throws: a bad edit (unknown node,
    // failed validation, a codegen fault) comes back in its `errors`, holding the last good IR.
    const renderResult = this.renderLive.apply(renderSnapshot);
    this.renderSnapshot = renderSnapshot;
    const behaviorResult = this.behaviorLive.apply(behaviorSnapshot);
    const stripResults = strips.map((strip) => strip.live.apply(strip.input.snapshot));

    // The preview is all-or-nothing (the artifacts run as one emitter). If any graph is invalid,
    // surface its node-attributed errors and leave the last emitter running.
    const invalidOf = (
      result: { status: string; errors: readonly FXCompilerError[] } | undefined,
    ): LiveApplyStatus | undefined =>
      result?.status === "invalid" ? invalidFromErrors(result.errors) : undefined;
    if (
      renderResult.status === "invalid" ||
      behaviorResult.status === "invalid" ||
      stripResults.some((result) => result.status === "invalid")
    ) {
      return hold({
        render: invalidOf(renderResult),
        behavior: invalidOf(behaviorResult),
        ...Object.fromEntries(
          strips.map((strip, index) => [strip.name, invalidOf(stripResults[index])]),
        ),
      });
    }

    // Every graph is valid, so each live graph has installed its current IR through the backend
    // callback above; guard defensively (a valid apply always installs them before we get here).
    if (this.shader === undefined || this.kernel === undefined) {
      const held = invalid(["EmitterView: no compiled IR after a valid apply"]);
      return hold({ render: held, behavior: held });
    }
    for (const strip of strips) {
      if (!strip.live.compiled) {
        return hold({
          [strip.name]: invalid([`EmitterView: no compiled ${strip.name} IR after a valid apply`]),
        });
      }
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
    const hiddenSortError = hiddenParticlesSortError(config);
    const renderErrors = [
      ...attributeErrors,
      ...depthFadeModeErrors(this.renderLive.graphView, renderMode),
      ...(hiddenSortError === undefined ? [] : [hiddenSortError]),
    ];
    if (renderErrors.length > 0) {
      return hold({ render: invalidFromErrors(renderErrors) });
    }
    // The runtime requires every mesh the behavior samples: pin a missing one to its node.
    const meshErrors = missingMeshAssetErrors(
      this.behaviorLive.graphView,
      Object.keys(this.resolveMeshGeometries()),
    );
    if (meshErrors.length > 0) {
      return hold({ behavior: invalidFromErrors(meshErrors) });
    }
    for (const strip of strips) {
      const check = strip.live.check(
        config.sortInterval,
        strip.input.config,
        this.behaviorAttributes,
        declaredAttributes,
      );
      if (check.render.length > 0 || check.strip.length > 0) {
        return hold({
          ...(check.render.length > 0 ? { render: invalidFromErrors(check.render) } : {}),
          [strip.name]: invalidFromErrors(check.strip),
        });
      }
    }

    // Assembly copies compiled strings and snapshots values (a draw stage's `compute` is built once
    // per compiled stage), so a value-only rebind never re-pays the compile. A same-name binding
    // conflict would throw here; hold rather than crash.
    let artifacts: PreviewArtifacts;
    try {
      artifacts = {
        render: assembleRenderArtifact(
          this.shader,
          toArtifactGeometrySource(geometry),
          this.renderAttributes,
          renderMode,
        ),
        drawParticles: config.drawParticles,
        behavior: assembleBehaviorArtifact(this.kernel),
        kernel: this.kernel,
        ...(this.standardProgram !== undefined
          ? { gpuBehavior: assembleGpuKernelArtifact(this.standardProgram) }
          : {}),
        // Each entry is the strip of its own name, which `Object.fromEntries` cannot carry.
        strips: Object.fromEntries(
          strips.map((strip) => [
            strip.name,
            { ...strip.live.assemble(strip.input.config), live: strip.live },
          ]),
        ),
      };
    } catch (error) {
      const held = invalid([describeError(error)]);
      return hold({
        render: held,
        behavior: held,
        ...Object.fromEntries(stripNames.map((name) => [name, held])),
      });
    }

    // An effect some GPUs could not link is held like any other graph error, before it replaces
    // anything; one past only the Baseline tier's limits runs, with a warning. Each graph's count
    // is its own: a failure counting a strip's materials is the strip's. Particles that are not
    // drawn take nothing.
    let budget: RenderBudgetFindings = { errors: [], warnings: [] };
    if (config.drawParticles) {
      try {
        budget = this.budgetFindings(
          artifacts,
          toArtifactGeometrySource(geometry),
          renderMode,
          castShadow,
          config.sortInterval > 0,
        );
      } catch (error) {
        return hold({ render: invalid([describeError(error)]) });
      }
      if (budget.errors.length > 0) {
        return hold({ render: invalidFromErrors(budget.errors) });
      }
    }
    const stripBudgets: Partial<Record<StripName, RenderBudgetFindings>> = {};
    for (const name of stripNames) {
      const strip = artifacts.strips[name];
      if (strip === undefined) {
        continue;
      }
      let findings: RenderBudgetFindings;
      try {
        findings = strip.live.budgetFindings(
          strip,
          artifacts.behavior.buffers,
          this.behaviorAttributes,
          // The same "can this emitter run on the GPU" the export counts by: a compiled kernel,
          // whose slot (in its order) the GPU strip copies.
          this.standardProgram?.buffers,
        );
      } catch (error) {
        return hold({ [name]: invalid([describeError(error)]) });
      }
      if (findings.errors.length > 0) {
        return hold({ [name]: invalidFromErrors(findings.errors) });
      }
      stripBudgets[name] = findings;
    }

    // A read of an attribute nothing writes runs (as a constant 0) - the same check the export runs.
    const written = kernelWrittenBuffers(this.kernel);
    const renderWarnings = [
      ...budget.warnings,
      ...unwrittenAttributeWarnings(this.renderLive.graphView, written, declaredAttributes),
    ];

    const result = this.applyArtifacts(artifacts, config, spawnConfig, {
      render: renderResult.status === "recompiled",
      behavior: behaviorResult.status === "recompiled",
    });
    const stripStatuses: Partial<Record<StripName, LiveApplyStatus>> = {};
    for (const strip of strips) {
      const status = result[strip.name];
      if (status !== undefined) {
        stripStatuses[strip.name] = withWarnings(status, [
          ...(stripBudgets[strip.name]?.warnings ?? []),
          ...strip.live.unwrittenAttributeWarnings(written, declaredAttributes),
        ]);
      }
    }
    return {
      ...result,
      render: withWarnings(result.render, renderWarnings),
      // The preview runs without the bound (only an export settles by it), but warns as the export.
      behavior: withWarnings(result.behavior, unboundedLifetimeWarnings(behaviorSnapshot)),
      ...stripStatuses,
    };
  }

  public destroy(): void {
    this.marker.object.removeFromParent();
    this.marker.dispose();
    for (const forward of Object.values(this.events)) {
      forward.clear();
    }
    this.emitter?.destroy();
    this.emitter = undefined;
    this.artifacts = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
    this.behaviorLive.destroy();
    for (const name of STRIP_NAMES) {
      this.liveStrips[name]?.destroy();
      delete this.liveStrips[name];
    }
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
   * Calls `listener` for each `kind` event of this view's particles - across rebuilds. Silent while
   * the running emitter cannot report events (GPU-driven: a source is built on the CPU, see
   * `effectiveSpawnConfig`, but a held graph error can keep an older GPU emitter running).
   */
  public onParticleEvent(kind: FXParticleEventKind, listener: FXParticleEventListener): () => void {
    return this.events[kind].listen(listener, this.emitter);
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
   * Each strip's live part for this apply, paired with its input, in strip order: built the first
   * time the emitter has that strip, and dropped (with everything compiled from it) once it has
   * none, so turning a strip back on starts from a clean compile.
   */
  private liveStripsFor(inputs: StripApplyInputs): readonly {
    readonly name: StripName;
    readonly live: EmitterStrip;
    readonly input: StripApplyInput;
  }[] {
    return STRIP_NAMES.flatMap((name) => {
      const input = inputs[name];
      if (input === undefined) {
        this.liveStrips[name]?.destroy();
        delete this.liveStrips[name];
        return [];
      }
      const live = (this.liveStrips[name] ??= new EmitterStrip(
        name,
        this.renderRegistry,
        this.renderBackend,
      ));
      return [{ name, live, input }];
    });
  }

  /**
   * Puts valid `artifacts` into effect the cheapest way their changes allow: a full rebuild when
   * the behavior half reshaped; else an in-place strip swap when a trail or ribbon turned on/off or
   * reshaped, and an in-place render swap when the render half did (Draw Particles included);
   * values (behavior bindings, the uniforms of whichever material was not swapped) are scrubbed in
   * on every in-place path.
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
      config.drawParticles !== this.builtDrawParticles ||
      // The emitter fell behind during an invalid interlude on the other graph - resync.
      this.shader !== this.builtShader;
    // Everything that reshapes the behavior half specifically (simulation, capacity, CPU/GPU
    // backend choice) - only this half genuinely needs a full FXEmitter.fromArtifacts rebuild,
    // since only a fresh driver can resize particle buffers or swap backend.
    const behaviorStructural =
      recompiled.behavior ||
      !sameGeometries(this.surfaceGeometries(artifacts), this.builtSurfaceGeometries) ||
      spawnConfig.tryGpuSimulation !== this.builtTryGpuSimulation ||
      spawnConfig.expectedCapacity !== this.builtExpectedCapacity ||
      this.kernel !== this.builtKernel;

    // Whether an emitter sorts is fixed for its life.
    const sorts = sortInterval > 0;
    const sortingStructural = sorts !== (this.emitter?.sort !== undefined);

    if (this.emitter === undefined || behaviorStructural || sortingStructural) {
      return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
    }

    // A strip turning on/off, a new strip shader, or new sink settings - swapped in place.
    const stripResults: Partial<Record<StripName, LiveApplyStatus>> = {};
    for (const name of STRIP_NAMES) {
      const strip = artifacts.strips[name];
      const has = this.emitter.hasStrip(name);
      const structural = strip === undefined ? has : strip.live.needsSwap(strip, has);
      if (structural) {
        try {
          this.emitter.applyStripArtifact(
            name,
            strip?.options,
            strip === undefined ? {} : this.resolveExternalTextures(strip.options.render),
          );
        } catch (error) {
          return heldResult([name], { [name]: invalid([describeError(error)]) });
        }
        strip?.live.markBuilt(strip);
      }
      if (strip !== undefined) {
        stripResults[name] = structural ? RECOMPILED : REBOUND;
      }
    }

    if (renderStructural) {
      const particles = particlesOf(artifacts);
      try {
        this.emitter.applyRenderArtifact(particles, {
          textures: particles === undefined ? {} : this.resolveExternalTextures(particles),
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
      this.builtDrawParticles = config.drawParticles;
    }

    // Only values changed in whatever was not swapped above - the behavior bindings always, and an
    // unswapped strip's or render's uniforms. Scrub them into the running emitter so live particles
    // never reset (external textures ride the value path too, so a texture swap rebinds).
    this.emitter.applyValues(this.valuesFromArtifacts(artifacts));
    if (this.emitter.sort !== undefined) {
      this.emitter.sort.fraction = 1 / sortInterval;
    }
    this.artifacts = artifacts;
    // Particle buffers/instance count/simulation were never touched - no rebuild happened, so
    // playback must not restart over this (see emitterRebuilt on GraphApplyResult).
    return {
      render: renderStructural ? RECOMPILED : REBOUND,
      behavior: REBOUND,
      ...stripResults,
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
    geometry: FXGeometrySource,
    renderMode: RenderMode,
    castShadow: boolean,
    sorted: boolean,
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
        sorted,
      ],
      () =>
        emitterRenderBudgetFindings(
          this.everyTierArtifacts(artifacts.render, geometry, renderMode),
          artifacts.behavior.buffers,
          {
            castShadow,
            ...(program === undefined ? {} : { gpu: { buffers: program.buffers, sorted } }),
          },
        ),
    );
  }

  /** `render` (the preview tier's) beside the other tier's artifact of the same graph. */
  private everyTierArtifacts(
    render: FXRenderArtifact,
    geometry: FXGeometrySource,
    renderMode: RenderMode,
  ): FXRenderArtifactsByTier {
    const shader = this.shader;
    const snapshot = this.renderSnapshot;
    if (shader === undefined || snapshot === undefined) {
      return { baseline: render, standard: render };
    }
    const shaders = everyTierShaders({
      tier: this.renderBackend,
      shader,
      snapshot,
      registry: this.renderRegistry,
      buildTarget: buildParticleTarget,
    });
    const assemble = (compiled: FXCompiledShader): FXRenderArtifact =>
      compiled === shader
        ? render
        : assembleRenderArtifact(compiled, geometry, this.renderAttributes, renderMode);
    return { baseline: assemble(shaders.baseline), standard: assemble(shaders.standard) };
  }

  /** The library geometry of each mesh `artifacts`' behavior samples, in a stable order. */
  private surfaceGeometries(artifacts: PreviewArtifacts): (BufferGeometry | undefined)[] {
    const geometries = this.resolveMeshGeometries();
    return [...new Set(Object.values(artifacts.behavior.meshSurfaces ?? {}))]
      .sort()
      .map((name) => geometries[name]);
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
    const { geometry, renderMode, castShadow, receiveShadow } = config;
    try {
      this.installEmitter(artifacts, config, spawnConfig);
    } catch (error) {
      // The runtime rejected the artifact pair; installEmitter builds the new emitter before
      // dropping the old, so the last good preview still runs - hold rather than crash.
      const held = invalid([describeError(error)]);
      return {
        render: held,
        behavior: held,
        ...this.stripStatuses(artifacts, held),
        emitterRebuilt: false,
      };
    }
    this.builtShader = this.shader;
    this.builtKernel = this.kernel;
    this.builtGeometryKey = encodeGeometrySource(geometry);
    this.builtCustomGeometryRef = currentCustomGeometryRef;
    this.builtSurfaceGeometries = this.surfaceGeometries(artifacts);
    this.builtRenderMode = renderMode;
    this.builtCastShadow = castShadow;
    this.builtReceiveShadow = receiveShadow;
    this.builtDrawParticles = config.drawParticles;
    this.builtTryGpuSimulation = spawnConfig.tryGpuSimulation;
    this.builtExpectedCapacity = spawnConfig.expectedCapacity;
    for (const name of STRIP_NAMES) {
      const strip = artifacts.strips[name];
      strip?.live.markBuilt(strip);
    }
    this.artifacts = artifacts;
    return {
      render: RECOMPILED,
      behavior: RECOMPILED,
      ...this.stripStatuses(artifacts, RECOMPILED),
      emitterRebuilt: true,
    };
  }

  /** `status` for every strip `artifacts` has. */
  private stripStatuses(
    artifacts: PreviewArtifacts,
    status: LiveApplyStatus,
  ): Partial<Record<StripName, LiveApplyStatus>> {
    return Object.fromEntries(
      STRIP_NAMES.filter((name) => artifacts.strips[name] !== undefined).map((name) => [
        name,
        status,
      ]),
    );
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

  /** The live uniform/binding values to scrub into a running emitter on a rebind: each material's
   *  own, by its artifact's names - a generated name is its graph's alone, so the particles' and
   *  a strip's may coincide for two different uniforms. */
  private valuesFromArtifacts(artifacts: PreviewArtifacts): FXApplyValues {
    const particles = particlesOf(artifacts);
    const trail = artifacts.strips.trail?.options.render;
    const ribbon = artifacts.strips.ribbon?.options.render;
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, slot] of Object.entries(artifacts.behavior.bindings)) {
      bindings[name] = slot.value;
    }
    return {
      ...(particles === undefined ? {} : { particleMaterial: this.materialValues(particles) }),
      ...(trail === undefined ? {} : { trailMaterial: this.materialValues(trail) }),
      ...(ribbon === undefined ? {} : { ribbonMaterial: this.materialValues(ribbon) }),
      bindings,
    };
  }

  /** The values of `render`'s uniforms: the baked ones, and each external slot's live texture. */
  private materialValues(render: FXRenderArtifact): Record<string, FXUniformValue> {
    const values: Record<string, FXUniformValue> = {};
    for (const [name, init] of Object.entries(render.uniforms)) {
      if (init.value !== undefined) {
        values[name] = init.value;
      }
    }
    for (const slot of externalSlots(render)) {
      values[slot.uniformName] = this.resolveTexture(slot.paramName);
    }
    return values;
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

  /** Replaces the running emitter with a fresh one for the new artifacts. May throw (see caller). */
  private installEmitter(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
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
      spawnConfig.tryGpuSimulation && this.renderer.capabilities.isWebGL2
        ? artifacts.gpuBehavior
        : undefined;
    // Build the new emitter BEFORE dropping the old one: fromArtifacts can throw on a bad artifact
    // pair, and the caller holds the last good preview on a throw - so the old emitter must survive.
    const particles = particlesOf(artifacts);
    const { trail, ribbon } = artifacts.strips;
    const next = FXEmitter.fromArtifacts(artifacts.behavior, {
      ...(particles === undefined ? {} : { particles }),
      textures,
      geometries: this.resolveMeshGeometries(),
      castShadow: config.castShadow,
      receiveShadow: config.receiveShadow,
      renderer: this.renderer,
      expectedCapacity: spawnConfig.expectedCapacity,
      ...(gpuKernel !== undefined ? { gpuKernel } : {}),
      ...(trail === undefined ? {} : { trail: trail.options }),
      ...(ribbon === undefined ? {} : { ribbon: ribbon.options }),
      ...(config.sortInterval > 0
        ? { sort: { camera: this.camera, fraction: 1 / config.sortInterval } }
        : {}),
    });
    this.emitter?.destroy();
    this.emitter = next;
    for (const forward of Object.values(this.events)) {
      forward.follow(next);
    }
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

/** Whether `a` and `b` hold the same geometries in the same order. */
function sameGeometries(
  a: readonly (BufferGeometry | undefined)[],
  b: readonly (BufferGeometry | undefined)[],
): boolean {
  return a.length === b.length && a.every((geometry, i) => geometry === b[i]);
}
