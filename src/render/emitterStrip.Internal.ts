/**
 * An emitter's trail or ribbon graph in the live preview: its own live compile against the strip's
 * target, the runtime options assembled from it, its GPU budget, and what the running emitter's
 * strip was built from - so {@link EmitterView} only decides when to build, swap or drop a strip,
 * not how.
 */

import type { FXBufferLayout, FXRenderArtifact } from "sparcoon";
import type { FXStripOptions } from "sparcoon/editor";

import { unwrittenAttributeWarnings } from "../domain/attributeChecks";
import { depthFadeModeErrors } from "../domain/depthFadeChecks";
import type { EditorAttribute } from "../domain/graphModel";
import {
  type FXRenderArtifactsByTier,
  type RenderBudgetFindings,
  RenderBudgetMemo,
  stripRenderBudgetFindings,
} from "../domain/renderBudget";
import { stripRuntimeFields, type StripSinkConfigs } from "../domain/sinkMeta";
import { STRIP_GEOMETRY, stripAttributeErrors, stripSortError } from "../domain/stripChecks";
import { collectAttributeRequests } from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { FXGraphReconciler } from "../engine/core/live/FXGraphReconciler";
import { FXLiveGraph, type FXLiveResult } from "../engine/core/live/FXLiveGraph";
import type { FXNodeRegistry } from "../engine/core/live/FXNodeRegistry";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import { assembleRenderArtifact } from "../engine/emit/assembleArtifacts";
import type { FXCompiledShader } from "../engine/render/compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../engine/render/FXRenderNode";
import { FXRenderLiveBackend } from "../engine/render/live/FXRenderLiveBackend";
import { buildStripTarget } from "../engine/render/target/FXParticleRenderTarget";
import type { StripName } from "../model/graphSlots";
import { everyTierShaders } from "./everyTierShaders";

/** A strip assembled for one apply: the runtime options and the sink config they came from. */
export interface AssembledStrip<K extends StripName = StripName> {
  readonly options: FXStripOptions[K];
  readonly config: StripSinkConfigs[K];
}

/** The strip's problems that hold the preview, by the graph they are pinned on. */
export interface StripCheck {
  /** Pinned on the render graph: a setting of its sink makes them. */
  readonly render: readonly FXCompilerError[];
  readonly strip: readonly FXCompilerError[];
}

/** Everything about a strip its live IR hash does not see. */
function configKey(config: StripSinkConfigs[StripName]): string {
  return JSON.stringify(config);
}

export class EmitterStrip<K extends StripName = StripName> {
  private readonly live: FXLiveGraph<FXRenderNode, FXCompiledShader>;
  // The snapshot last applied: what the budget compiles the other tier from.
  private snapshot: FXGraphSnapshotData | undefined = undefined;
  // The latest installed IR and the attributes it reads.
  private shader: FXCompiledShader | undefined = undefined;
  private attributes: readonly FXAttributeRequest[] = [];
  // What the running emitter's strip was built from; `undefined` until one is.
  private builtShader: FXCompiledShader | undefined = undefined;
  private builtKey: string | undefined = undefined;
  private readonly budget = new RenderBudgetMemo();

  constructor(
    public readonly strip: K,
    private readonly registry: FXNodeRegistry<FXRenderNode>,
    private readonly tier: FXGLSLRenderTier,
  ) {
    const live: FXLiveGraph<FXRenderNode, FXCompiledShader> = new FXLiveGraph(
      new FXGraphReconciler(registry),
      new FXRenderLiveBackend(
        tier,
        (attributes) => buildStripTarget(strip, attributes),
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

  /** Reconciles and compiles the strip's graph; never throws (see {@link FXLiveGraph.apply}). */
  public apply(snapshot: FXGraphSnapshotData): FXLiveResult<FXRenderNode> {
    this.snapshot = snapshot;
    return this.live.apply(snapshot);
  }

  /**
   * What holds the preview beyond the strip's own compile: a depth sort on the emitter
   * (`sortInterval`, pinned on the render graph's sink and repeated on the strip), its attribute
   * reads against the behavior (see `stripAttributeErrors`), and its Depth Fade nodes when its
   * render mode writes depth (see `depthFadeModeErrors`).
   */
  public check(
    sortInterval: number,
    config: StripSinkConfigs[K],
    behaviorAttributes: readonly FXAttributeRequest[],
    declared: readonly EditorAttribute[],
  ): StripCheck {
    const sortError = stripSortError(this.strip, sortInterval);
    if (sortError !== undefined) {
      return {
        render: [sortError],
        strip: [{ code: sortError.code, message: sortError.message }],
      };
    }
    return {
      render: [],
      strip: [
        ...stripAttributeErrors(this.attributes, behaviorAttributes, declared),
        ...depthFadeModeErrors(this.live.graphView, config.renderMode),
      ],
    };
  }

  /** The strip's reads of attributes the behavior never writes (see `unwrittenAttributeWarnings`). */
  public unwrittenAttributeWarnings(
    written: ReadonlySet<string>,
    declared: readonly EditorAttribute[],
  ): readonly FXCompilerError[] {
    return unwrittenAttributeWarnings(this.live.graphView, written, declared);
  }

  /** The runtime options from the installed IR and `config`; throws before a valid apply. */
  public assemble(config: StripSinkConfigs[K]): AssembledStrip<K> {
    if (this.shader === undefined) {
      throw new Error(`EmitterStrip: no compiled ${this.strip} IR`);
    }
    const render = assembleRenderArtifact(
      this.shader,
      STRIP_GEOMETRY,
      this.attributes,
      config.renderMode,
    );
    // The runtime options are the render artifact and the fields the sink config gives, which
    // TypeScript cannot follow through the generic `K`.
    const options = { render, ...stripRuntimeFields(this.strip, config) } as FXStripOptions[K];
    return { options, config };
  }

  /**
   * What `assembled`'s material takes of a GPU, against each tier's minimums (see
   * `stripRenderBudgetFindings`; `kernelBuffers` is the emitter's GPU kernel's slot, when it has a
   * kernel the strip could draw from) - memoized on the installed IR, the render mode,
   * `kernelBuffers` and `behaviorKey` (what `behaviorBuffers` was derived from), all by identity.
   */
  public budgetFindings(
    assembled: AssembledStrip,
    behaviorBuffers: readonly FXBufferLayout[],
    behaviorKey: unknown,
    kernelBuffers: readonly FXBufferLayout[] | undefined,
  ): RenderBudgetFindings {
    return this.budget.get(
      [this.shader, behaviorKey, assembled.config.renderMode, kernelBuffers],
      () =>
        stripRenderBudgetFindings(
          this.strip,
          this.everyTier(assembled),
          behaviorBuffers,
          kernelBuffers,
        ),
    );
  }

  /**
   * Whether the running emitter's strip must be (re)built for `assembled`: it draws none yet
   * (`emitterHasStrip` - a fresh live part, or a strip the runtime refused), or one built from
   * other IR or another sink config.
   */
  public needsSwap(assembled: AssembledStrip, emitterHasStrip: boolean): boolean {
    return (
      !emitterHasStrip ||
      this.shader !== this.builtShader ||
      configKey(assembled.config) !== this.builtKey
    );
  }

  /** Records that the running emitter's strip was just built from the installed IR and `assembled`. */
  public markBuilt(assembled: AssembledStrip): void {
    this.builtShader = this.shader;
    this.builtKey = configKey(assembled.config);
  }

  public destroy(): void {
    this.live.destroy();
  }

  /** `assembled`'s artifact (the preview tier's) beside the other tier's of the same graph. */
  private everyTier(assembled: AssembledStrip): FXRenderArtifactsByTier {
    const render = assembled.options.render;
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
      buildTarget: (attributes) => buildStripTarget(this.strip, attributes),
    });
    const assemble = (compiled: FXCompiledShader): FXRenderArtifact =>
      compiled === shader
        ? render
        : assembleRenderArtifact(
            compiled,
            STRIP_GEOMETRY,
            this.attributes,
            assembled.config.renderMode,
          );
    return { baseline: assemble(shaders.baseline), standard: assemble(shaders.standard) };
  }
}
