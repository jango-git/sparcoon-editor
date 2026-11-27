/**
 * Compiles an emitter's graphs into artifacts and runs them. The editor's own live gate picks a
 * full rebuild, an in-place render or strip swap, or a value-only rebind. Strip graphs live in
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
import { FXEmitter, fxEmitterStripMesh } from "sparcoon/editor";
import type { BufferGeometry, Camera, Object3D, Texture, WebGLRenderer } from "three";

import { missingAssetErrors } from "../domain/assetChecks";
import { kernelWrittenBuffers, unwrittenAttributeWarnings } from "../domain/attributeChecks";
import type { EditorAttribute } from "../domain/graphModel";
import { unboundedLifetimeWarnings } from "../domain/lifetimeBound";
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
import { cpuSceneDepthWarnings, depthFadeModeErrors } from "../domain/sceneDepthChecks";
import { undeclaredAttributeErrors } from "../domain/serialize";
import { hiddenParticlesSortError } from "../domain/stripChecks";
import type { FXBehaviorNode } from "../engine/behavior/FXBehaviorNode";
import type { FXCompiledBehaviorBundle } from "../engine/behavior/FXCompiledBehaviorBundle";
import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import type { FXInheritEntry } from "../engine/behavior/FXInheritPlan";
import type { FXFusedProgramStandard } from "../engine/behavior/FXKernelBuildStandard.Internal";
import { assetNamesOf } from "../engine/behavior/FXKernelShared.Internal";
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
import { FX_ASSET_KIND_LIST, FX_ASSET_KINDS } from "../engine/core/nodes/FXAssetKind";
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
import { KernelBuildWait } from "./kernelBuildWait";
import { ParticleEventForward } from "./particleEventForward";
import { NO_PREVIEW_ASSETS, previewAssetNames, type PreviewAssets } from "./previewAssets";
import { type ProgramLinkFailures, programLinkFailures } from "./programLinkFailures";

export type TextureResolver = (paramName: string) => Texture;

type LiveStrip<K extends StripName> = AssembledStrip<K> & { readonly live: EmitterStrip<K> };

interface PreviewArtifacts {
  readonly render: FXRenderArtifact;
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

/**
 * The particles' material, then each strip's. They share one parameter namespace and the runtime
 * routes a value to every material that declares it.
 */
function renderArtifactsOf(artifacts: PreviewArtifacts): readonly FXRenderArtifact[] {
  return [
    particlesOf(artifacts),
    ...STRIP_NAMES.map((name) => artifacts.strips[name]?.options.render),
  ].filter((render) => render !== undefined);
}

type HeldStatuses = {
  readonly [K in "render" | "behavior" | StripName]?: LiveApplyStatus | undefined;
};

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
 * One emitter's preview, built from live graphs and the runtime emitter they produce, rebuilt on a
 * structural edit. It is a spawn target and particle event source, so reaction links outlive
 * rebuilds.
 */
export class EmitterView implements GraphApplier, FXSpawnTarget, FXParticleEventSource {
  private readonly renderLive: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  private renderSnapshot: FXGraphSnapshotData | undefined = undefined;
  private readonly behaviorLive: FXLiveGraph<FXBehaviorNode, FXCompiledBehaviorBundle>;
  private readonly liveStrips: Partial<Record<StripName, EmitterStrip>> = {};
  private emitter: FXEmitter | undefined = undefined;
  // Listeners of particle births and deaths, fed from the running emitter. Re-subscribed on every
  // rebuild.
  private readonly events: Readonly<Record<FXParticleEventKind, ParticleEventForward>> = {
    birth: new ParticleEventForward("birth"),
    death: new ParticleEventForward("death"),
  };

  private shader: FXCompiledShader | undefined = undefined;
  private kernel: FXCompiledKernel | undefined = undefined;
  // The Standard (GLSL/transform-feedback) kernel program. `undefined` when the flag is off or
  // compile failed.
  private standardProgram: FXFusedProgramStandard | undefined = undefined;
  private renderAttributes: readonly FXAttributeRequest[] = [];
  private behaviorAttributes: readonly FXAttributeRequest[] = [];

  private readonly budget = new RenderBudgetMemo();

  private readonly kernelBuild: KernelBuildWait;

  // Artifacts the running emitter accepted. Value drive reads param slots and baked baselines from
  // them. Replaced only once the emitter takes new ones.
  private artifacts: PreviewArtifacts | undefined = undefined;
  private overflowAtReset = 0;

  // What the emitter was built from. Compared with the latest to force a rebuild when they drift.
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtKernel: FXCompiledKernel | undefined = undefined;
  private builtGeometryKey: string | undefined = undefined;
  private builtCustomGeometryRef: BufferGeometry | undefined = undefined;
  // Assets the behavior samples. A replaced asset is a new object, which only a rebuild reads.
  private builtSampledAssets: readonly unknown[] = [];
  private builtRenderMode: RenderMode | undefined = undefined;
  private builtDrawParticles = true;
  // Surface-sink params as built. Not in the IR hash, so a flip must force a rebuild.
  private builtCastShadow = false;
  private builtReceiveShadow = false;
  // Spawn-sink GPU flag and capacity as built. Not in the IR hash, so an edit of either must force
  // a rebuild.
  private builtTryGpuSimulation = false;
  private builtExpectedCapacity = 0;
  // Spawn-sink flag of the current apply. The target builder reads it, so it must be set before
  // `behaviorLive.apply`.
  private currentTryGpuSimulation = false;
  // Cast-shadow flag of the current apply. The shadow program compiles only when it is set.
  private currentCastShadow = false;

  private readonly drivenParams = new Set<string>();
  // Reapplied to a rebuilt emitter so the pose does not snap to the origin.
  private lastTransform: Transform | undefined = undefined;
  // Reapplied likewise, so a muted emitter does not flash visible.
  private lastVisible = true;
  private readonly marker: GizmoMarker = createGizmoMarker("emitter");

  private readonly renderRegistry: FXNodeRegistry<FXRenderNode>;
  private readonly renderBackend: FXGLSLRenderTier;

  constructor(
    private readonly parent: Object3D,
    private readonly resolveTexture: TextureResolver,
    private readonly camera: Camera,
    private readonly renderer: WebGLRenderer,
    renderRegistry: FXNodeRegistry<FXRenderNode>,
    behaviorRegistry: FXNodeRegistry<FXBehaviorNode>,
    renderBackend: FXGLSLRenderTier,
    private readonly resolveAssets: () => PreviewAssets = () => NO_PREVIEW_ASSETS,
  ) {
    this.renderRegistry = renderRegistry;
    this.renderBackend = renderBackend;
    this.kernelBuild = new KernelBuildWait(renderer);
    this.renderLive = new FXLiveGraph(
      new FXGraphReconciler(renderRegistry),
      new FXRenderLiveBackend(
        renderBackend,
        (attributes) => buildParticleTarget(attributes, this.currentCastShadow),
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

  public get inheritDefaults(): ArrayLike<number> {
    return this.emitter?.inheritDefaults ?? NOTHING_INHERITED;
  }

  public get particleSlot(): FXSlotLayout {
    return this.emitter?.particleSlot ?? EMPTY_SLOT;
  }

  public get reactionSource(): ReactionSource | undefined {
    return this.emitter === undefined || this.artifacts === undefined
      ? undefined
      : reactionSourceOf(this.artifacts.kernel);
  }

  public get inheritEntries(): readonly FXInheritEntry[] {
    return this.emitter === undefined ? [] : (this.artifacts?.kernel.inherit?.entries ?? []);
  }

  public get particleCount(): number {
    return this.emitter?.particleCount ?? 0;
  }

  /**
   * Births lost to a full ring since the last reset or build. `undefined` for a GPU-driven emitter
   * or none built.
   */
  public get particleOverflowCount(): number | undefined {
    const total = this.emitter?.particleOverflowCount;
    return total === undefined ? undefined : total - this.overflowAtReset;
  }

  public get object3D(): Object3D | undefined {
    return this.emitter;
  }

  public get visible(): boolean {
    return this.lastVisible;
  }

  public get readsSceneDepth(): boolean {
    const artifacts = this.artifacts;
    return (
      artifacts !== undefined &&
      (this.gpuKernelOf(artifacts, this.builtTryGpuSimulation)?.sceneDepth === true ||
        renderArtifactsOf(artifacts).some((render) => render.sceneDepth))
    );
  }

  public get pickTarget(): Object3D {
    return this.marker.pickTarget;
  }

  public programLinkFailures(renderer: WebGLRenderer): ProgramLinkFailures {
    const emitter = this.emitter;
    if (emitter === undefined) {
      return {};
    }
    const stripOf = new Map(
      STRIP_NAMES.flatMap((name) => {
        const mesh = fxEmitterStripMesh(emitter, name);
        return mesh === undefined ? [] : [[mesh, name] as const];
      }),
    );
    const failures = programLinkFailures(
      renderer,
      emitter,
      (mesh) => stripOf.get(mesh) ?? "render",
      this.marker.object,
    );
    const simulationFailure = emitter.simulationFailure;
    return simulationFailure === undefined
      ? failures
      : { ...failures, behavior: simulationFailure };
  }

  /** Whether the awaited kernel build ended since the last call. Reported once per build. */
  public takeEndedKernelBuild(): boolean {
    return this.kernelBuild.takeEnded();
  }

  public apply(
    renderSnapshot: FXGraphSnapshotData,
    behaviorSnapshot: FXGraphSnapshotData,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    // Attributes are checked against every custom-attribute request in both graphs, so a leftover
    // name after a removal or retype is a held error.
    declaredAttributes: readonly EditorAttribute[],
    stripInputs: StripApplyInputs = {},
  ): GraphApplyResult {
    const { geometry, renderMode, castShadow } = config;
    // Each strip's live part and this apply's input to it, narrowed once: both or neither.
    const strips = this.liveStripsFor(stripInputs);
    const stripNames = strips.map(({ name }) => name);
    // Set before `behaviorLive.apply`, whose validation reads it synchronously.
    this.currentTryGpuSimulation = spawnConfig.tryGpuSimulation;
    this.currentCastShadow = castShadow;
    const hold = (statuses: HeldStatuses): GraphApplyResult => heldResult(stripNames, statuses);

    // Live graphs never throw. A bad edit comes back in `errors` and the last good IR is kept.
    const renderResult = this.renderLive.apply(renderSnapshot);
    this.renderSnapshot = renderSnapshot;
    const behaviorResult = this.behaviorLive.apply(behaviorSnapshot);
    const stripResults = strips.map((strip) => strip.live.apply(strip.input.snapshot));

    // All-or-nothing. If any graph is invalid, surface its errors and keep the last emitter
    // running.
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

    // A cross-graph attribute conflict (behavior writes `foo` as vec3, render reads vec2) passes
    // each graph's validation. Hold it as `invalid` instead of letting the rebuild throw.
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
    const assetErrors = missingAssetErrors(
      this.behaviorLive.graphView,
      previewAssetNames(this.resolveAssets()),
    );
    if (assetErrors.length > 0) {
      return hold({ behavior: invalidFromErrors(assetErrors) });
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

    // Assembly only copies strings and snapshots values, so a value-only rebind does not recompile.
    // A same-name binding conflict throws here and is held.
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

    // A link failure is held like a graph error, before anything is replaced. Exceeding only
    // Baseline limits runs with a warning. Each graph counts its own materials, strips included.
    // Undrawn particles count nothing.
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

    // Reading an attribute nothing writes yields constant 0. Same check as the export.
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
      behavior: withWarnings(result.behavior, [
        ...unboundedLifetimeWarnings(behaviorSnapshot),
        ...cpuSceneDepthWarnings(this.behaviorLive.graphView, this.standardProgram !== undefined),
      ]),
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
    this.kernelBuild.release();
    this.artifacts = undefined;
    this.drivenParams.clear();
    this.renderLive.destroy();
    this.behaviorLive.destroy();
    for (const name of STRIP_NAMES) {
      this.liveStrips[name]?.destroy();
      delete this.liveStrips[name];
    }
  }

  public setSelected(selected: boolean): void {
    this.marker.setSelected(selected);
  }

  /**
   * Writes sampled values into the running emitter. A param no longer driven reverts to its baked
   * baseline.
   */
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

  public burst(count: number, options?: Partial<FXEmitterBurstOptions>): number {
    return this.emitter?.burst(count, options) ?? NO_HANDLER;
  }

  public play(rate: number, options?: Partial<FXEmitterPlayOptions>): number {
    return this.emitter?.play(rate, options) ?? NO_HANDLER;
  }

  /**
   * Listens to `kind` events across rebuilds. Silent while the running emitter cannot report events
   * (GPU-driven).
   */
  public onParticleEvent(kind: FXParticleEventKind, listener: FXParticleEventListener): () => void {
    return this.events[kind].listen(listener, this.emitter);
  }

  public loopTimeline(): void {
    this.emitter?.loopTimeline();
  }

  /** Clears particles and emission. The overflow count restarts from zero. */
  public reset(): void {
    this.emitter?.stop();
    this.emitter?.reset();
    this.overflowAtReset = this.emitter?.particleOverflowCount ?? 0;
  }

  public setVisible(visible: boolean): void {
    this.lastVisible = visible;
    if (this.emitter !== undefined) {
      this.emitter.visible = visible;
    }
  }

  public applyTransform(transform: Transform): void {
    this.lastTransform = transform;
    if (this.emitter !== undefined) {
      applyTransform(this.emitter, transform);
    }
  }

  /**
   * Kernel of the GPU emitter, `undefined` on CPU. The renderer gates only its use, not
   * compilation, so `exportCompile.ts` stays consistent.
   */
  private gpuKernelOf(
    artifacts: PreviewArtifacts,
    tryGpuSimulation: boolean,
  ): FXParticleKernelArtifact | undefined {
    return tryGpuSimulation && this.renderer.capabilities.isWebGL2
      ? artifacts.gpuBehavior
      : undefined;
  }

  /**
   * Each strip's live part paired with its input. Built when the strip first appears, dropped with
   * everything compiled from it when it goes.
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
   * Applies `artifacts` the cheapest way. Behavior reshape is a full rebuild. A strip change is an
   * in-place strip swap. A render change is an in-place render swap. Values are scrubbed in on
   * every in-place path. `recompiled` says which half recompiled.
   */
  private applyArtifacts(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    recompiled: { readonly render: boolean; readonly behavior: boolean },
  ): GraphApplyResult {
    const { geometry, renderMode, sortInterval, castShadow, receiveShadow } = config;
    const currentCustomGeometryRef =
      geometry.kind === "custom"
        ? this.resolveAssets().geometries[geometry.meshAssetName]
        : undefined;
    // Render-half changes (GLSL, geometry, composite mode, shadow flags). These hot-swap in place
    // when the behavior half is unchanged.
    const renderStructural =
      recompiled.render ||
      encodeGeometrySource(geometry) !== this.builtGeometryKey ||
      currentCustomGeometryRef !== this.builtCustomGeometryRef ||
      renderMode !== this.builtRenderMode ||
      castShadow !== this.builtCastShadow ||
      receiveShadow !== this.builtReceiveShadow ||
      config.drawParticles !== this.builtDrawParticles ||
      this.shader !== this.builtShader;
    // Behavior-half changes (simulation, capacity, CPU/GPU backend). Only a fresh driver can resize
    // buffers or swap backend.
    const behaviorStructural =
      recompiled.behavior ||
      !sameAssets(this.sampledAssets(artifacts), this.builtSampledAssets) ||
      spawnConfig.tryGpuSimulation !== this.builtTryGpuSimulation ||
      spawnConfig.expectedCapacity !== this.builtExpectedCapacity ||
      this.kernel !== this.builtKernel;

    const sorts = sortInterval > 0;
    const sortingStructural = sorts !== (this.emitter?.sort !== undefined);

    if (this.emitter === undefined || behaviorStructural || sortingStructural) {
      return this.rebuildEmitter(artifacts, config, spawnConfig, currentCustomGeometryRef);
    }

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
          geometries: this.resolveAssets().geometries,
          castShadow,
          receiveShadow,
        });
      } catch (error) {
        // The driver refused an attribute-layout change only a fresh driver can apply. Fall back to
        // a full rebuild, not an error.
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

    // Scrub values into the running emitter so live particles do not reset. External textures take
    // this path too.
    this.emitter.applyValues(this.valuesFromArtifacts(artifacts));
    if (this.emitter.sort !== undefined) {
      this.emitter.sort.fraction = 1 / sortInterval;
    }
    this.artifacts = artifacts;
    // No rebuild happened, so playback must not restart.
    return {
      render: renderStructural ? RECOMPILED : REBOUND,
      behavior: REBOUND,
      ...stripResults,
      emitterRebuilt: false,
    };
  }

  /**
   * Budget of the materials against each tier's minimums, memoized. The GPU kernel is in the key
   * because its slot layout decides the Standard-tier count and it is replaced on every behavior
   * recompile.
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
      buildTarget: (attributes) => buildParticleTarget(attributes, this.currentCastShadow),
    });
    const assemble = (compiled: FXCompiledShader): FXRenderArtifact =>
      compiled === shader
        ? render
        : assembleRenderArtifact(compiled, geometry, this.renderAttributes, renderMode);
    return { baseline: assemble(shaders.baseline), standard: assemble(shaders.standard) };
  }

  private sampledAssets(artifacts: PreviewArtifacts): readonly unknown[] {
    const assets = this.resolveAssets();
    const names = assetNamesOf(artifacts.behavior);
    return FX_ASSET_KIND_LIST.flatMap((kind) =>
      names[kind].map((name) => assets[FX_ASSET_KINDS[kind].appField][name]),
    );
  }

  /**
   * Full rebuild with a fresh `FXEmitter.fromArtifacts`, resetting particles and playback. Used for
   * the first build, behavior changes, and when a render swap refuses a layout change. While the
   * kernel builds, the running emitter continues and the rebuild waits for
   * {@link takeEndedKernelBuild}.
   */
  private rebuildEmitter(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    currentCustomGeometryRef: BufferGeometry | undefined,
  ): GraphApplyResult {
    const { geometry, renderMode, castShadow, receiveShadow } = config;
    const gpuKernel = this.gpuKernelOf(artifacts, spawnConfig.tryGpuSimulation);
    if (gpuKernel !== undefined && this.kernelBuild.waitsFor(gpuKernel)) {
      return this.recompiledResult(artifacts, false);
    }
    try {
      this.installEmitter(artifacts, config, spawnConfig);
    } catch (error) {
      this.kernelBuild.release();
      const held = invalid([describeError(error)]);
      return {
        render: held,
        behavior: held,
        ...this.stripStatuses(artifacts, held),
        emitterRebuilt: false,
      };
    }
    this.kernelBuild.release();
    this.builtShader = this.shader;
    this.builtKernel = this.kernel;
    this.builtGeometryKey = encodeGeometrySource(geometry);
    this.builtCustomGeometryRef = currentCustomGeometryRef;
    this.builtSampledAssets = this.sampledAssets(artifacts);
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
    return this.recompiledResult(artifacts, true);
  }

  private recompiledResult(artifacts: PreviewArtifacts, emitterRebuilt: boolean): GraphApplyResult {
    return {
      render: RECOMPILED,
      behavior: RECOMPILED,
      ...this.stripStatuses(artifacts, RECOMPILED),
      emitterRebuilt,
    };
  }

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

  private resolveExternalTextures(artifact: FXRenderArtifact): Record<string, Texture> {
    const textures: Record<string, Texture> = {};
    for (const slot of externalSlots(artifact)) {
      textures[paramUniformName(slot.paramName)] = this.resolveTexture(slot.paramName);
    }
    return textures;
  }

  /**
   * Values scrubbed in on a rebind, per material by its artifact's names. A generated name is
   * unique to its graph, so the particles' and a strip's names may coincide for different uniforms.
   */
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
    // A vector param is one binding per component (`b_param_<name>_x`, ...). A scalar is
    // `b_param_<name>`.
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

  private installEmitter(
    artifacts: PreviewArtifacts,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
  ): void {
    // Every external sampler slot must be bound at build time. A missing texture resolves to a
    // transparent fallback.
    const textures = Object.assign(
      {},
      ...renderArtifactsOf(artifacts).map((render) => this.resolveExternalTextures(render)),
    ) as Record<string, Texture>;
    // `gpuKernel` is omitted, not set to `undefined`, because of `exactOptionalPropertyTypes`.
    const gpuKernel = this.gpuKernelOf(artifacts, spawnConfig.tryGpuSimulation);
    // Build the new emitter before dropping the old one. `fromArtifacts` can throw, and the caller
    // then keeps the last good preview.
    const particles = particlesOf(artifacts);
    const { trail, ribbon } = artifacts.strips;
    const next = FXEmitter.fromArtifacts(artifacts.behavior, {
      ...(particles === undefined ? {} : { particles }),
      textures,
      ...this.resolveAssets(),
      castShadow: config.castShadow,
      receiveShadow: config.receiveShadow,
      renderer: this.renderer,
      expectedCapacity: spawnConfig.expectedCapacity,
      ...(gpuKernel !== undefined ? { gpuKernel } : {}),
      ...(trail === undefined ? {} : { trail: trail.options }),
      ...(ribbon === undefined ? {} : { ribbon: ribbon.options }),
      camera: this.camera,
      ...(config.sortInterval > 0 ? { sort: { fraction: 1 / config.sortInterval } } : {}),
    });
    this.emitter?.destroy();
    this.emitter = next;
    for (const forward of Object.values(this.events)) {
      forward.follow(next);
    }
    this.overflowAtReset = 0;
    this.parent.add(next);
    next.add(this.marker.object);
    // `fromArtifacts` starts visible at the origin, so reapply the last pose and visibility.
    if (this.lastTransform !== undefined) {
      applyTransform(next, this.lastTransform);
    }
    next.visible = this.lastVisible;
    // No automatic emission. Timeline events drive spawning.
  }
}

/** Writes a {@link Transform} onto an Object3D, normalizing the rotation quaternion. */
export function applyTransform(object: Object3D, transform: Transform): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  const quaternion = normalizeQuat(transform.rotation);
  object.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
}

/** Whether `a` and `b` hold the same assets in the same order. */
function sameAssets(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((asset, i) => asset === b[i]);
}
