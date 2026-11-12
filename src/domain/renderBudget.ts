/**
 * What the editor makes of a render artifact's {@link FXRenderBudget} - the attributes, varying
 * vectors, uniform vectors and texture units its materials take, counted by the runtime off the
 * very shaders it builds. Each tier's artifact is measured against the least that tier
 * guarantees: past Standard's (WebGL2's) minimum the effect is an error - some WebGL2 GPU would
 * refuse to link it, and the editor promises any WebGL2 browser. Past Baseline's (WebGL1's, far
 * lower) it is only a warning: real WebGL1 GPUs mostly offer more than the minimum. The tiers'
 * artifacts differ - each lifts what it can afford to the draw stage - so each is counted on its
 * own.
 */

import type { FXBufferLayout, FXRenderArtifact } from "sparcoon";
import {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxMeshRenderBudget,
  fxTrailRenderBudget,
  type FXRenderBudget,
} from "sparcoon/editor";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";

/** One material's render artifact, assembled for each GLSL tier. */
export type FXRenderArtifactsByTier = Readonly<Record<FXGLSLRenderTier, FXRenderArtifact>>;

export interface RenderBudgetFindings {
  /** Past Standard's minimums: the effect must not ship as it is. */
  readonly errors: readonly FXCompilerError[];
  /** Past Baseline's minimums only. */
  readonly warnings: readonly FXCompilerError[];
}

/** One resource of a budget: its codes and wording. */
interface FXBudgetResource {
  readonly key: keyof FXRenderBudget;
  readonly noun: string;
  readonly error: FXCompilerError["code"];
  readonly warning: FXCompilerError["code"];
  readonly advice: string;
  /**
   * How Baseline's minimum reads in a warning: WebGL1's own guarantee (`"webgl1"`), or the least
   * device the tier supports offers (`"device"`) - see `FX_RENDER_BUDGET_MINIMUMS`.
   */
  readonly baselineFloor: "webgl1" | "device";
}

/** The resources a budget measures, worded as in `errors.en.json`. */
const RESOURCES: readonly FXBudgetResource[] = [
  {
    key: "attributes",
    noun: "vertex attributes",
    error: "render-attribute-budget",
    warning: "render-attribute-budget-baseline",
    advice: "drop particle attributes the render does not need",
    baselineFloor: "webgl1",
  },
  {
    key: "varyingVectors",
    noun: "varying vectors",
    error: "render-varying-budget",
    warning: "render-varying-budget-baseline",
    advice:
      "read fewer particle attributes in the fragment stage, or pass fewer values from the " +
      "vertex stage",
    baselineFloor: "webgl1",
  },
  {
    key: "vertexUniformVectors",
    noun: "vertex uniform vectors",
    error: "render-vertex-uniform-budget",
    warning: "render-vertex-uniform-budget-baseline",
    advice: "declare fewer parameters or pass fewer values to the vertex stage",
    baselineFloor: "device",
  },
  {
    key: "fragmentUniformVectors",
    noun: "fragment uniform vectors",
    error: "render-fragment-uniform-budget",
    warning: "render-fragment-uniform-budget-baseline",
    advice: "declare fewer parameters",
    baselineFloor: "device",
  },
  {
    key: "vertexSamplers",
    noun: "vertex texture units",
    error: "render-vertex-sampler-budget",
    warning: "render-vertex-sampler-budget-baseline",
    advice: "sample fewer textures in the vertex stage",
    baselineFloor: "device",
  },
  {
    key: "fragmentSamplers",
    noun: "fragment texture units",
    error: "render-fragment-sampler-budget",
    warning: "render-fragment-sampler-budget-baseline",
    advice: "sample fewer textures",
    baselineFloor: "device",
  },
];

/**
 * Each resource past Standard's minimum in `budget` (what the Standard tier runs) is an error; one
 * within it but past Baseline's in `baselineBudget` (what the Baseline tier runs) is a warning -
 * never both for the same resource.
 */
export function renderBudgetFindings(
  budget: FXRenderBudget,
  baselineBudget: FXRenderBudget,
): RenderBudgetFindings {
  const { standard, baseline } = FX_RENDER_BUDGET_MINIMUMS;
  const errors: FXCompilerError[] = [];
  const warnings: FXCompilerError[] = [];
  for (const { key, noun, error, warning, advice, baselineFloor } of RESOURCES) {
    const used = budget[key];
    const baselineUsed = baselineBudget[key];
    if (used > standard[key]) {
      errors.push({
        code: error,
        message:
          `the material needs ${String(used)} ${noun}; every WebGL2 GPU guarantees ` +
          `${String(standard[key])} - ${advice}`,
        params: { used, limit: standard[key] },
      });
    } else if (baselineUsed > baseline[key]) {
      const floor =
        baselineFloor === "webgl1"
          ? `the Baseline tier on a WebGL1 GPU guarantees only ${String(baseline[key])}`
          : `the least WebGL1 device the Baseline tier supports offers ${String(baseline[key])}`;
      warnings.push({
        code: warning,
        message: `the material needs ${String(baselineUsed)} ${noun}; ${floor}, so it may not draw there`,
        params: { used: baselineUsed, limit: baseline[key] },
      });
    }
  }
  return { errors, warnings };
}

/**
 * The last findings and the inputs they were counted from, compared by identity: counting builds
 * the materials, which is worth it only when a shader, the particle attributes or a material flag
 * actually changed - not on every value scrub.
 */
export class RenderBudgetMemo {
  private key: readonly unknown[] | undefined = undefined;
  private findings: RenderBudgetFindings | undefined = undefined;

  public get(key: readonly unknown[], count: () => RenderBudgetFindings): RenderBudgetFindings {
    const known =
      this.findings !== undefined &&
      this.key?.length === key.length &&
      key.every((part, index) => part === this.key?.[index]);
    if (!known || this.findings === undefined) {
      this.findings = count();
      this.key = key;
    }
    return this.findings;
  }
}

/**
 * The findings for an emitter's particle material, each tier's artifact of `renders` measured on
 * its own. Both backends read a particle slot through its packed views - several adjacent fields
 * per attribute, laid out by the editor in the runtime's packing order
 * (`buildParticleBehaviorTargets`); a read nothing writes is a constant zero, free. Each is
 * measured over its own slot: `behaviorBuffers` (the JS behavior's `buffers`) and `kernelBuffers`
 * (the emitter's GPU kernel's, when it has one). A Standard (WebGL2) error is measured on the GPU
 * mesh when there is one, which is what WebGL2 runs; a Baseline (WebGL1) warning is always
 * measured on the JS mesh - the only one WebGL1 ever runs.
 */
export function emitterRenderBudgetFindings(
  renders: FXRenderArtifactsByTier,
  behaviorBuffers: readonly FXBufferLayout[],
  castShadow: boolean,
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): RenderBudgetFindings {
  return renderBudgetFindings(
    fxEmitterRenderBudget(renders.standard, kernelBuffers ?? behaviorBuffers, { castShadow }),
    fxEmitterRenderBudget(renders.baseline, behaviorBuffers, { castShadow }),
  );
}

/**
 * The findings for an emitter's trail, by the same split as {@link emitterRenderBudgetFindings}:
 * with `kernelBuffers` a Standard error is measured on the GPU history - which copies the kernel's
 * slot whole, so it takes that slot's packed views - else on the JS history alone, while a
 * Baseline warning is always measured on the JS history.
 */
export function trailRenderBudgetFindings(
  renders: FXRenderArtifactsByTier,
  behaviorBuffers: readonly FXBufferLayout[],
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): RenderBudgetFindings {
  return renderBudgetFindings(
    kernelBuffers === undefined
      ? fxTrailRenderBudget(renders.standard, behaviorBuffers)
      : fxTrailRenderBudget(renders.standard, kernelBuffers, { backend: "gpu" }),
    fxTrailRenderBudget(renders.baseline, behaviorBuffers),
  );
}

/** The findings for a mesh's material, each tier's artifact of `renders` measured on its own. */
export function meshRenderBudgetFindings(
  renders: FXRenderArtifactsByTier,
  castShadow: boolean,
): RenderBudgetFindings {
  return renderBudgetFindings(
    fxMeshRenderBudget(renders.standard, { castShadow }),
    fxMeshRenderBudget(renders.baseline, { castShadow }),
  );
}
