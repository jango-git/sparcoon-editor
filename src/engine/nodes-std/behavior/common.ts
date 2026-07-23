import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";

/**
 * Shared node-authoring fragments for the standard behavior nodes: the recurring velocity/`dt`
 * input sockets plus the `rand`/`TWO_PI` helpers, so each node file states them once.
 */

/** Editable `vec3` velocity input defaulting to zero - the accumulator most force/integrate nodes
 *  read. Its `velocity`/`dt` record keys are shared node-text dictionary keys (`i18n/nodeText.ts`,
 *  `nodes.en.json`) across every node that spreads this in under those same keys. */
export const VELOCITY_INPUT = { type: "vec3", value: [0, 0, 0] } as const;

/** Float `dt` input wired to the target's synthesized timestep. */
export const DT_INPUT = {
  type: "float",
  default: { targetInput: "dt" },
} as const;

/** Full turn in radians. */
export const TWO_PI = 6.283185307179586;

/** A fresh draw in [0, 1) - `Math.random()` on the JS backend, a decorrelated GLSL hash on the
 *  standard tier (see the `rand` entry in `core/ir/FXFunctions.Internal.ts`). */
export function rand(fn: FXExprBuilderApi): FXExpr {
  return fn.call("rand");
}
