/**
 * An emitter's trail graph in the live preview: its own live compile against the trail target,
 * the artifact assembled from it, its GPU budget, and what the running emitter's trail was built
 * from - so {@link EmitterView} only decides when to build, swap or drop the trail, not how.
 */

import { everyTierShaders } from "./everyTierShaders";
import type { FXTrailOptions } from "sparcoon/editor";
import type { FXBufferLayout, FXRenderArtifact } from "sparcoon";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph, type FXLiveResult } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import { assembleRenderArtifact } from "../engine/emit/assembleArtifacts";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { buildTrailTarget } from "../engine/render/target/FXParticleRenderTarget";
import type { EditorAttribute } from "../domain/graphModel";
import type { TrailSinkConfig } from "../domain/nodePalette";
import {
  RenderBudgetMemo,
  trailRenderBudgetFindings,
  type FXRenderArtifactsByTier,
  type RenderBudgetFindings,
} from "../domain/renderBudget";
import { TRAIL_GEOMETRY, trailAttributeErrors } from "../domain/trailChecks";
import { unwrittenAttributeWarnings } from "../domain/attributeChecks";
import { depthFadeModeErrors } from "../domain/depthFadeChecks";
import type { RenderMode } from "../domain/sinkMeta";

/** Everything about a trail its live IR hash does not see. */
function configKey(config: TrailSinkConfig): string {
  return `${config.renderMode}|${String(config.frames)}|${String(config.sampleInterval)}`;
}

/** A trail assembled for one apply: the runtime options and the sink config they came from. */
export interface AssembledTrail {
  readonly options: FXTrailOptions;
  readonly config: TrailSinkConfig;
}

export class EmitterTrail {
  private readonly live: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  // The trail snapshot last applied: what the budget compiles the other tier from.
  private snapshot: FXGraphSnapshotData | undefined = undefined;
  // The latest installed IR and the attributes it reads.
  private shader: FXCompiledShader | undefined = undefined;
  private attributes: readonly FXAttributeRequest[] = [];
  // What the running emitter's trail was built from; `undefined` until one is.
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtKey: string | undefined = undefined;
  private readonly budget = new RenderBudgetMemo();

  constructor(
    private readonly registry: FXNodeRegistry<FXRenderNode>,
    private readonly tier: FXGLSLRenderTier,
  ) {
    const live: FXLiveGraph<FXRenderNode, FXCompiledShader> = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXRenderLiveBackend(
        tier,
        (attributes) => buildTrailTarget(attributes),
        (compiled) => {
          this.shader = compiled;
          this.attributes = collectAttributeRequests(live.graphView).requests;
        },
      ),
    );
    this.live = live;
  }

  /** Whether a valid apply has installed IR to assemble from. */
  public get compiled(): boolean {
    return this.shader !== undefined;
  }

  /** Reconciles and compiles the trail graph; never throws (see {@link FXLiveGraph.apply}). */
  public apply(snapshot: FXGraphSnapshotData): FXLiveResult<FXRenderNode> {
    this.snapshot = snapshot;
    return this.live.apply(snapshot);
  }

  /** The trail's attribute reads against the emitter's behavior (see `trailAttributeErrors`). */
  public attributeErrors(
    behaviorAttributes: readonly FXAttributeRequest[],
    declared: readonly EditorAttribute[],
  ): readonly FXCompilerError[] {
    return trailAttributeErrors(this.attributes, behaviorAttributes, declared);
  }

  /** The trail's Depth Fade nodes, when `renderMode` writes depth (see `depthFadeModeErrors`). */
  public depthFadeErrors(renderMode: RenderMode): readonly FXCompilerError[] {
    return depthFadeModeErrors(this.live.graphView, renderMode);
  }

  /** The trail's reads of attributes the behavior never writes (see `unwrittenAttributeWarnings`). */
  public unwrittenAttributeWarnings(
    written: ReadonlySet<string>,
    declared: readonly EditorAttribute[],
  ): readonly FXCompilerError[] {
    return unwrittenAttributeWarnings(this.live.graphView, written, declared);
  }

  /** The runtime trail options from the installed IR and `config`; throws before a valid apply. */
  public assemble(config: TrailSinkConfig): AssembledTrail {
    if (this.shader === undefined) {
      throw new Error("EmitterTrail: no compiled trail IR");
    }
    return {
      options: {
        render: assembleRenderArtifact(
          this.shader,
          TRAIL_GEOMETRY,
          this.attributes,
          config.renderMode,
        ),
        frames: config.frames,
        sampleInterval: config.sampleInterval,
      },
      config,
    };
  }

  /**
   * What `trail`'s material takes of a GPU, against each tier's minimums (see
   * `trailRenderBudgetFindings`; `kernelBuffers` is the emitter's GPU kernel's slot, when it has a
   * kernel whose history the trail could draw) - memoized on the installed IR, the render mode,
   * `kernelBuffers` and `behaviorKey` (what `behaviorBuffers` was derived from), all by identity.
   */
  public budgetFindings(
    trail: AssembledTrail,
    behaviorBuffers: readonly FXBufferLayout[],
    behaviorKey: unknown,
    kernelBuffers: readonly FXBufferLayout[] | undefined,
  ): RenderBudgetFindings {
    return this.budget.get([this.shader, behaviorKey, trail.config.renderMode, kernelBuffers], () =>
      trailRenderBudgetFindings(this.everyTier(trail), behaviorBuffers, kernelBuffers),
    );
  }

  /**
   * Whether the running emitter's trail must be (re)built for `trail`: it draws none yet
   * (`emitterHasTrail` - a fresh live part, or a trail the runtime refused), or one built from
   * other IR or another history config.
   */
  public needsSwap(trail: AssembledTrail, emitterHasTrail: boolean): boolean {
    return (
      !emitterHasTrail ||
      this.shader !== this.builtShader ||
      configKey(trail.config) !== this.builtKey
    );
  }

  /** Records that the running emitter's trail was just built from the installed IR and `trail`. */
  public markBuilt(trail: AssembledTrail): void {
    this.builtShader = this.shader;
    this.builtKey = configKey(trail.config);
  }

  public destroy(): void {
    this.live.destroy();
  }

  /** `trail`'s artifact (the preview tier's) beside the other tier's of the same graph. */
  private everyTier(trail: AssembledTrail): FXRenderArtifactsByTier {
    const render = trail.options.render;
    const shader = this.shader;
    const snapshot = this.snapshot;
    if (shader === undefined || snapshot === undefined) {
      return { baseline: render, standard: render };
    }
    const shaders = everyTierShaders({
      tier: this.tier,
      shader,
      snapshot,
      registry: this.registry,
      buildTarget: buildTrailTarget,
    });
    const assemble = (compiled: FXCompiledShader): FXRenderArtifact =>
      compiled === shader
        ? render
        : assembleRenderArtifact(
            compiled,
            TRAIL_GEOMETRY,
            this.attributes,
            trail.config.renderMode,
          );
    return { baseline: assemble(shaders.baseline), standard: assemble(shaders.standard) };
  }
}
