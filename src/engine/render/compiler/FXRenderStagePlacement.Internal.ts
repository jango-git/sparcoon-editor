import type { FXCompiledDrawStage, FXTypedLocal } from "../../core/codegen/drawStage.Internal";
import { liftDrawStage } from "../../core/codegen/drawStage.Internal";
import { hoistToEarlyStage } from "../../core/codegen/hoist.Internal";
import { liveLocals } from "../../core/codegen/liveness.Internal";
import type { FXProjectionPolicy } from "../../core/codegen/projectComponents.Internal";
import { pickComponents, projectComponents } from "../../core/codegen/projectComponents.Internal";
import { classifyRates } from "../../core/codegen/rates.Internal";
import { ref } from "../../core/ir/FXExprBuilder";
import { refNames, refNamesIn } from "../../core/ir/visit.Internal";
import type { FXValueType } from "../../core/socket/FXValueType";
import { FXShaderStage } from "../FXShaderStage";
import { crossingBudget, drawUniformBudget } from "../target/FXParticleRenderTarget";
import type { FXTarget } from "../target/FXTarget";
import { FX_INPUT_RATE_RANK, renderRatePolicy } from "../target/FXTarget";
import type { FXUniformHandle } from "./FXCompiledShader";
import type { FXGLSLRenderTier } from "./FXRenderCompilers";
import type { FXShadowRoot, FXSlotValue } from "./FXRenderCompileShared.Internal";
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

/** Where every local of one program of a render graph runs, and what crosses between its stages. */
export interface FXPlacedProgram<L extends FXTypedLocal> {
  readonly vertex: readonly L[];
  readonly fragment: readonly L[];
  readonly crossing: readonly FXRenderCrossing<L>[];
}

/** One render graph's programs as placed, and the draw stage they share. */
export interface FXRenderStagePlacement<L extends FXTypedLocal> {
  readonly color: FXPlacedProgram<L>;
  /** The shadow program and what its output slots read, when the graph has one. */
  readonly shadow?: {
    readonly program: FXPlacedProgram<L>;
    readonly slots: ReadonlyMap<string, FXSlotValue>;
  };
  /** The draw uniform an output slot now reads, by the local it read (see `liftDrawStage`). */
  readonly renamed: ReadonlyMap<string, string>;
  readonly draw: FXCompiledDrawStage | undefined;
}

/** One render graph's locals by the stage its nodes run in, what its color program's output
 *  slots read, and what its shadow program reads of them (see `shadowRoots`). */
export interface FXRenderGraphStages<L extends FXTypedLocal> {
  readonly vertex: readonly L[];
  readonly fragment: readonly L[];
  readonly slots: ReadonlyMap<string, FXSlotValue>;
  readonly shadow: readonly FXShadowRoot[] | undefined;
}

/** What placement needs of the tier compiling the graph. */
export interface FXRenderPlacementContext<L extends FXTypedLocal> {
  readonly target: FXTarget;
  readonly tier: FXGLSLRenderTier;
  /** The lighting the graph's nodes call (empty: unlit) - it fixes the material beside it. */
  readonly lightingIntrinsics: readonly string[];
  /** The graph's own uniforms so far: its parameters, generated textures and external slots. */
  readonly uniforms: readonly FXUniformHandle[];
  /** How the shadow program's own locals are made (see `projectComponents`). */
  readonly projection: FXProjectionPolicy<L>;
  isImpureCall(fn: string): boolean;
  /** Declares one draw uniform of `type` (seeded to zero) and returns its name. */
  declareDrawUniform(type: FXValueType): string;
}

/**
 * Places one render graph's locals - the shading-language-neutral part of both GLSL tiers'
 * `finalize`, which keep their own declarations, `flat` rules and printing:
 * - what is one for the whole draw and known before it goes to the draw stage, computed once per
 *   tick on the CPU, as far as the tier's uniforms allow (see `liftDrawStage`, `drawUniformBudget`)
 *   - one draw stage for both programs, which every material drawing the graph shares;
 * - the shadow program, cut down to the components its outputs read of what stays on the GPU
 *   (see `projectComponents`) - a value lifted whole is read off its draw uniform;
 * - for each program, a fragment local whose value is the same at every fragment of a particle
 *   (see `renderRatePolicy`) moves to the vertex stage, computed per vertex rather than per
 *   fragment, as far as the tier can carry the results between the stages beside a material lit by
 *   the graph's lighting (see `hoistToEarlyStage`, `crossingBudget`); a program keeps only the
 *   locals its own slots read.
 */
export function placeRenderStages<L extends FXTypedLocal>(
  graph: FXRenderGraphStages<L>,
  context: FXRenderPlacementContext<L>,
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
  const colorReads = slotReadsOf(graph.slots);
  const shadowSources = slotReadsOf(
    new Map(
      (graph.shadow ?? []).map((root) => [root.slot, { stage: root.stage, value: root.name }]),
    ),
  );
  const lifted = liftDrawStage(
    [graph.vertex, graph.fragment],
    [
      new Set([...colorReads.vertex, ...shadowSources.vertex]),
      new Set([...colorReads.fragment, ...shadowSources.fragment]),
    ],
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
  const [vertex = [], fragment = []] = lifted.stages;
  const shadow =
    graph.shadow === undefined
      ? undefined
      : projectShadow(graph, { vertex, fragment }, lifted.renamed, context.projection);

  // What crosses, and what moves, is decided over what stays on the GPU.
  const placedRates = classifyRates(
    [...vertex, ...(shadow?.vertex ?? []), ...fragment, ...(shadow?.fragment ?? [])],
    policy,
  );
  const fits = crossingBudget(target, tier, fragmentReads, lightingIntrinsics);
  const place = (
    early: readonly L[],
    late: readonly L[],
    slots: ReadonlyMap<string, FXSlotValue>,
  ): FXPlacedProgram<L> => {
    // A slot reading a lifted value reads its uniform: no local of either stage.
    const reads = slotReadsOf(slots);
    const unlifted = (names: readonly string[]): string[] =>
      names.filter((name) => !lifted.renamed.has(name));
    const plan = hoistToEarlyStage(
      { early, late, lateRoots: unlifted(reads.fragment) },
      {
        rates: placedRates,
        maxRate: FX_INPUT_RATE_RANK.primitive,
        // Every frame- and view-rate input is a uniform both stages declare (target validation).
        sharedRate: FX_INPUT_RATE_RANK.view,
        fits: (crossing, lateNow) =>
          fits(
            crossing.map((local) => local.type),
            targetReads(lateNow),
          ),
      },
    );
    // The vertex stage keeps what the program's vertex slots and fragment stage read of it.
    const localReads = new Map(
      plan.early.map((local) => [local.name, refNames(local.expr, "local", new Set())]),
    );
    const live = liveLocals(plan.early, localReads, [
      ...unlifted(reads.vertex),
      ...plan.crossing.map((local) => local.name),
    ]);
    return {
      vertex: plan.early.filter((local) => live.has(local.name)),
      fragment: plan.late,
      crossing: plan.crossing.map((local) => ({
        local,
        perPrimitive:
          (placedRates.get(local.name) ?? policy.pinned) <= FX_INPUT_RATE_RANK.primitive,
      })),
    };
  };
  return {
    color: place(vertex, fragment, graph.slots),
    ...(shadow === undefined
      ? {}
      : {
          shadow: {
            program: place(
              [...vertex, ...shadow.vertex],
              [...fragment, ...shadow.fragment],
              shadow.slots,
            ),
            slots: shadow.slots,
          },
        }),
    renamed: lifted.renamed,
    draw: lifted.stage,
  };
}

/** What a program's output slots read, by the stage that reads them. */
function slotReadsOf(slots: ReadonlyMap<string, FXSlotValue>): {
  readonly vertex: string[];
  readonly fragment: string[];
} {
  const values = [...slots.values()];
  const of = (stage: FXShaderStage): string[] =>
    values.filter((slot) => slot.stage === stage).map((slot) => slot.value);
  return { vertex: of(FXShaderStage.VERTEX), fragment: of(FXShaderStage.FRAGMENT) };
}

/**
 * The shadow program over what stays on the GPU after the lift (`gpu`, `renamed`): its slots, and
 * the locals only it reads by stage - each a part of a local of the graph (or what reads only
 * such parts), in the stage that local runs in. A root lifted to a draw uniform is read off it:
 * whole as the color slot reads it, a part through a local of the uniform's components.
 */
function projectShadow<L extends FXTypedLocal>(
  graph: FXRenderGraphStages<L>,
  gpu: { readonly vertex: readonly L[]; readonly fragment: readonly L[] },
  renamed: ReadonlyMap<string, string>,
  projection: FXProjectionPolicy<L>,
): { readonly vertex: L[]; readonly fragment: L[]; readonly slots: Map<string, FXSlotValue> } {
  const roots = graph.shadow ?? [];
  const stageOf = new Map<string, FXShaderStage>([
    ...gpu.vertex.map((local) => [local.name, FXShaderStage.VERTEX] as const),
    ...gpu.fragment.map((local) => [local.name, FXShaderStage.FRAGMENT] as const),
  ]);
  const onGPU = roots.filter((root) => !renamed.has(root.name));
  const projected = projectComponents([...gpu.vertex, ...gpu.fragment], onGPU, {
    nextName: () => projection.nextName(),
    derive: (local, name, type, expr) => {
      // A local made of another runs in its stage.
      stageOf.set(name, stageOf.get(local.name) ?? FXShaderStage.FRAGMENT);
      return projection.derive(local, name, type, expr);
    },
  });
  const added = projected.locals.filter(
    (local) => !gpu.vertex.includes(local) && !gpu.fragment.includes(local),
  );
  const original = new Map(
    [...graph.vertex, ...graph.fragment].map((local) => [local.name, local]),
  );
  const slots = new Map<string, FXSlotValue>();
  roots.forEach((root) => {
    const index = onGPU.indexOf(root);
    if (index !== -1) {
      slots.set(root.slot, { stage: root.stage, value: projected.roots[index] ?? root.name });
      return;
    }
    const local = original.get(root.name);
    const uniform = renamed.get(root.name);
    if (local === undefined || uniform === undefined) {
      return;
    }
    const expr = pickComponents(ref("uniform", uniform, local.type), root.channels);
    // Whole: the color slot's own read, through the same draw uniform.
    if (expr.kind === "ref") {
      slots.set(root.slot, { stage: root.stage, value: root.name });
      return;
    }
    const name = projection.nextName();
    stageOf.set(name, root.stage);
    added.push(projection.derive(local, name, expr.type, expr));
    slots.set(root.slot, { stage: root.stage, value: name });
  });
  return {
    vertex: added.filter((local) => stageOf.get(local.name) === FXShaderStage.VERTEX),
    fragment: added.filter((local) => stageOf.get(local.name) !== FXShaderStage.VERTEX),
    slots,
  };
}
