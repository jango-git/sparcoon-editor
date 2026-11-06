/**
 * What the editor makes of a render artifact's {@link FXRenderBudget} - the vertex attributes and
 * varying vectors its materials take, counted by the runtime off the very shaders it builds.
 * Measured against the least each GLSL tier guarantees: past Standard's (WebGL2's) minimum the
 * effect is an error - some WebGL2 GPU would refuse to link it, and the editor promises any
 * WebGL2 browser. Past Baseline's (WebGL1's, far lower) it is only a warning: the Baseline tier
 * shares Standard's material templates, so the same count applies, and real WebGL1 GPUs mostly
 * offer more than the minimum.
 */

import { FX_RENDER_BUDGET_MINIMUMS, type FXRenderBudget } from "sparcoon/editor";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";

export interface RenderBudgetFindings {
  /** Past Standard's minimums: the effect must not ship as it is. */
  readonly errors: readonly FXCompilerError[];
  /** Past Baseline's minimums only. */
  readonly warnings: readonly FXCompilerError[];
}

/** One resource of a budget: what it takes, each tier's minimum, its codes and wording. */
interface FXBudgetResource {
  readonly used: number;
  readonly standard: number;
  readonly baseline: number;
  readonly noun: string;
  readonly error: FXCompilerError["code"];
  readonly warning: FXCompilerError["code"];
  readonly advice: string;
}

/** The resources a budget measures, worded as in `errors.en.json`. */
function resources(budget: FXRenderBudget): readonly FXBudgetResource[] {
  const { standard, baseline } = FX_RENDER_BUDGET_MINIMUMS;
  return [
    {
      used: budget.attributes,
      standard: standard.attributes,
      baseline: baseline.attributes,
      noun: "vertex attributes",
      error: "render-attribute-budget",
      warning: "render-attribute-budget-baseline",
      advice: "drop particle attributes the render does not need",
    },
    {
      used: budget.varyingVectors,
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
 * warning - never both for the same resource.
 */
export function renderBudgetFindings(budget: FXRenderBudget): RenderBudgetFindings {
  const errors: FXCompilerError[] = [];
  const warnings: FXCompilerError[] = [];
  for (const { used, standard, baseline, noun, error, warning, advice } of resources(budget)) {
    if (used > standard) {
      errors.push({
        code: error,
        message:
          `the material needs ${String(used)} ${noun}; every WebGL2 GPU guarantees ` +
          `${String(standard)} - ${advice}`,
        params: { used, limit: standard },
      });
    } else if (used > baseline) {
      warnings.push({
        code: warning,
        message:
          `the material needs ${String(used)} ${noun}; the Baseline tier on a WebGL1 GPU ` +
          `guarantees only ${String(baseline)}, so it may not draw there`,
        params: { used, limit: baseline },
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
