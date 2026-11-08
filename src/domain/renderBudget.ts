/**
 * What the editor makes of a render artifact's {@link FXRenderBudget} - the vertex attributes and
 * varying vectors its materials take, counted by the runtime off the very shaders it builds.
 * Measured against the least each GLSL tier guarantees: past Standard's (WebGL2's) minimum the
 * effect is an error - some WebGL2 GPU would refuse to link it, and the editor promises any
 * WebGL2 browser. Past Baseline's (WebGL1's, far lower) it is only a warning: the Baseline tier
 * shares Standard's material templates, so the same count applies, and real WebGL1 GPUs mostly
 * offer more than the minimum.
 */

import type { FXAttributeDecl, FXBufferLayout, FXRenderArtifact } from "sparcoon";
import {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxTrailRenderBudget,
  type FXRenderBudget,
} from "sparcoon/editor";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";

export interface RenderBudgetFindings {
  /** Past Standard's minimums: the effect must not ship as it is. */
  readonly errors: readonly FXCompilerError[];
  /** Past Baseline's minimums only. */
  readonly warnings: readonly FXCompilerError[];
}

/** One resource of a budget: what it takes, each tier's minimum, its codes and wording. */
interface FXBudgetResource {
  /** What the material takes on Standard. */
  readonly used: number;
  /** What it takes on Baseline - the same as `used`, but for an emitter with a GPU kernel. */
  readonly baselineUsed: number;
  readonly standard: number;
  readonly baseline: number;
  readonly noun: string;
  readonly error: FXCompilerError["code"];
  readonly warning: FXCompilerError["code"];
  readonly advice: string;
}

/**
 * The resources a budget measures, worded as in `errors.en.json`: what `budget` takes is measured
 * against Standard's minimums, what `baselineBudget` takes against Baseline's.
 */
function resources(
  budget: FXRenderBudget,
  baselineBudget: FXRenderBudget,
): readonly FXBudgetResource[] {
  const { standard, baseline } = FX_RENDER_BUDGET_MINIMUMS;
  return [
    {
      used: budget.attributes,
      baselineUsed: baselineBudget.attributes,
      standard: standard.attributes,
      baseline: baseline.attributes,
      noun: "vertex attributes",
      error: "render-attribute-budget",
      warning: "render-attribute-budget-baseline",
      advice: "drop particle attributes the render does not need",
    },
    {
      used: budget.varyingVectors,
      baselineUsed: baselineBudget.varyingVectors,
      standard: standard.varyingVectors,
      baseline: baseline.varyingVectors,
      noun: "varying vectors",
      error: "render-varying-budget",
      warning: "render-varying-budget-baseline",
      advice:
        "read fewer particle attributes in the fragment stage, or pass fewer values from the " +
        "vertex stage",
    },
  ];
}

/**
 * Each resource past Standard's minimum is an error; one within it but past Baseline's is a
 * warning - never both for the same resource. `baselineBudget` is what the Baseline tier runs,
 * when that differs from what Standard does (an emitter with a GPU kernel - see
 * {@link emitterRenderBudgetFindings}).
 */
export function renderBudgetFindings(
  budget: FXRenderBudget,
  baselineBudget: FXRenderBudget = budget,
): RenderBudgetFindings {
  const errors: FXCompilerError[] = [];
  const warnings: FXCompilerError[] = [];
  for (const resource of resources(budget, baselineBudget)) {
    const { used, baselineUsed, standard, baseline, noun, error, warning, advice } = resource;
    if (used > standard) {
      errors.push({
        code: error,
        message:
          `the material needs ${String(used)} ${noun}; every WebGL2 GPU guarantees ` +
          `${String(standard)} - ${advice}`,
        params: { used, limit: standard },
      });
    } else if (baselineUsed > baseline) {
      warnings.push({
        code: warning,
        message:
          `the material needs ${String(baselineUsed)} ${noun}; the Baseline tier on a WebGL1 GPU ` +
          `guarantees only ${String(baseline)}, so it may not draw there`,
        params: { used: baselineUsed, limit: baseline },
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
 * The findings for an emitter's particle material. The two backends lay the particle state out
 * differently: the JS mesh gives every field the behavior writes an attribute of its own (a read
 * nothing writes is a constant zero, free), while the
 * GPU (transform-feedback) mesh reads the kernel's slot through packed views - several adjacent
 * fields per attribute, laid out by the editor in the runtime's packing order
 * (`FXKernelBuildStandard.Internal.ts`). With `kernelBuffers` (the emitter's GPU kernel's
 * `buffers`) a Standard (WebGL2) error is measured on the GPU mesh, which is what WebGL2 runs;
 * a Baseline (WebGL1) warning is always measured on the JS mesh - the only one WebGL1 ever runs.
 */
export function emitterRenderBudgetFindings(
  render: FXRenderArtifact,
  behaviorWrites: readonly FXAttributeDecl[],
  castShadow: boolean,
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): RenderBudgetFindings {
  const js = fxEmitterRenderBudget(render, behaviorWrites, { castShadow });
  if (kernelBuffers === undefined) {
    return renderBudgetFindings(js);
  }
  const gpu = fxEmitterRenderBudget(render, behaviorWrites, { castShadow, kernelBuffers });
  return renderBudgetFindings(gpu, js);
}

/**
 * The findings for an emitter's trail, by the same split as {@link emitterRenderBudgetFindings}:
 * with `kernelBuffers` a Standard error is measured on the GPU history - which copies the kernel's
 * slot whole, so it takes that slot's packed views - else on the JS history alone, while a
 * Baseline warning is always measured on the JS history.
 */
export function trailRenderBudgetFindings(
  render: FXRenderArtifact,
  behaviorWrites: readonly FXAttributeDecl[],
  kernelBuffers: readonly FXBufferLayout[] | undefined,
): RenderBudgetFindings {
  const js = fxTrailRenderBudget(render, behaviorWrites);
  if (kernelBuffers === undefined) {
    return renderBudgetFindings(js);
  }
  const gpu = fxTrailRenderBudget(render, behaviorWrites, { backend: "gpu", kernelBuffers });
  return renderBudgetFindings(gpu, js);
}
