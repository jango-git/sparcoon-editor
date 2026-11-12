import { hoistToEarlyStage } from "../../core/codegen/hoist.Internal";
import { classifyRates } from "../../core/codegen/rates.Internal";
import { refNamesIn } from "../../core/ir/visit.Internal";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXUniformHandle } from "./FXCompiledShader";
import type { FXTarget } from "../target/FXTarget";
import { FX_INPUT_RATE_RANK, renderRatePolicy } from "../target/FXTarget";
import { crossingBudget, drawUniformBudget } from "../target/FXParticleRenderTarget";
import type { FXGLSLRenderTier } from "./FXRenderCompilers";
import { liftDrawStage } from "../../core/codegen/drawStage.Internal";
import type { FXCompiledDrawStage, FXTypedLocal } from "../../core/codegen/drawStage.Internal";
import { RENDER_DRAW_INPUTS } from "./FXRenderDrawInputs.Internal";

/**
 * The fewest operations a value must cost to be worth a uniform, by the stage reading it (vertex,
 * fragment). A uniform costs each draw some tens of nanoseconds on the CPU, an operation some
 * picoseconds per invocation on the GPU (measured on an integrated GPU): a fragment stage runs
 * thousands of times a draw, so any value pays off there; a vertex stage - four vertices a
 * particle - only a value of a few operations.
 */
const RENDER_MINIMUM_LIFT_COST: readonly number[] = [3, 0];

/** One vertex value the fragment stage reads, and whether it is the same across a primitive. */
export interface FXRenderCrossing<L extends FXTypedLocal> {
  readonly local: L;
  readonly perPrimitive: boolean;
}

/** Where every local of one render graph runs, and what crosses between the stages. */
export interface FXRenderStagePlacement<L extends FXTypedLocal> {
  readonly vertex: readonly L[];
  readonly fragment: readonly L[];
  readonly crossing: readonly FXRenderCrossing<L>[];
  /** The draw uniform an output slot now reads, by the local it read (see `liftDrawStage`). */
  readonly renamed: ReadonlyMap<string, string>;
  readonly draw: FXCompiledDrawStage | undefined;
}

/** One render graph's locals by the stage its nodes run in, and what its output slots read. */
export interface FXRenderGraphStages<L extends FXTypedLocal> {
  readonly vertex: readonly L[];
  readonly fragment: readonly L[];
  readonly vertexSlotReads: readonly string[];
  readonly fragmentSlotReads: readonly string[];
}

/** What placement needs of the tier compiling the graph. */
export interface FXRenderPlacementContext {
  readonly target: FXTarget;
  readonly tier: FXGLSLRenderTier;
  /** The lighting the graph's nodes call (empty: unlit) - it fixes the material beside it. */
  readonly lightingIntrinsics: readonly string[];
  /** The graph's own uniforms so far: its parameters, generated textures and external slots. */
  readonly uniforms: readonly FXUniformHandle[];
  isImpureCall(fn: string): boolean;
  /** Declares one draw uniform of `type` (seeded to zero) and returns its name. */
  declareDrawUniform(type: FXValueType): string;
}

/**
 * Places one render graph's locals - the shading-language-neutral part of both GLSL tiers'
 * `finalize`, which keep their own declarations, `flat` rules and printing:
 * - what is one for the whole draw and known before it goes to the draw stage, computed once per
 *   tick on the CPU, as far as the tier's uniforms allow (see `liftDrawStage`, `drawUniformBudget`);
 * - a fragment local whose value is the same at every fragment of a particle (see
 *   `renderRatePolicy`) moves to the vertex stage, computed per vertex rather than per fragment,
 *   as far as the tier can carry the results between the stages beside a material lit by the
 *   graph's lighting (see `hoistToEarlyStage`, `crossingBudget`).
 */
export function placeRenderStages<L extends FXTypedLocal>(
  graph: FXRenderGraphStages<L>,
  context: FXRenderPlacementContext,
): FXRenderStagePlacement<L> {
  const { target, tier, lightingIntrinsics } = context;
  const policy = renderRatePolicy(target, (fn) => context.isImpureCall(fn));
  const rates = classifyRates([...graph.vertex, ...graph.fragment], policy);
  const targetReads = (locals: readonly L[]): string[] =>
    refNamesIn(
      locals.map((local) => local.expr),
      "targetInput",
    );
  const fragmentReads = targetReads(graph.fragment);
  const lifted = liftDrawStage(
    [graph.vertex, graph.fragment],
    [new Set(graph.vertexSlotReads), new Set(graph.fragmentSlotReads)],
    rates,
    {
      ...RENDER_DRAW_INPUTS,
      rate: FX_INPUT_RATE_RANK.frame,
      minimumCost: RENDER_MINIMUM_LIFT_COST,
      fits: drawUniformBudget(
        tier,
        fragmentReads,
        lightingIntrinsics,
        context.uniforms.filter((handle) => handle.type.instantiable).map((handle) => handle.type),
        context.uniforms
          .filter((handle) => handle.external !== undefined)
          .map((handle) => handle.name),
      ),
      declareUniform: (type) => context.declareDrawUniform(type),
    },
  );
  const fits = crossingBudget(target, tier, fragmentReads, lightingIntrinsics);
  const [vertex = [], fragment = []] = lifted.stages;
  const plan = hoistToEarlyStage(
    {
      early: vertex,
      late: fragment,
      // A slot reading a lifted value reads its uniform: no local of the late stage.
      lateRoots: graph.fragmentSlotReads.filter((name) => !lifted.renamed.has(name)),
    },
    {
      rates,
      maxRate: FX_INPUT_RATE_RANK.primitive,
      // Every frame- and view-rate input is a uniform both stages declare (target validation).
      sharedRate: FX_INPUT_RATE_RANK.view,
      fits: (crossing, late) =>
        fits(
          crossing.map((local) => local.type),
          targetReads(late),
        ),
    },
  );
  return {
    vertex: plan.early,
    fragment: plan.late,
    crossing: plan.crossing.map((local) => ({
      local,
      perPrimitive: (rates.get(local.name) ?? policy.pinned) <= FX_INPUT_RATE_RANK.primitive,
    })),
    renamed: lifted.renamed,
    draw: lifted.stage,
  };
}
