import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";

/**
 * Shared node-authoring fragments for the standard behavior nodes: the recurring velocity/`dt`
 * input sockets plus the `rand`/`TWO_PI` and direction helpers, so each node file states them once.
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

/** `value`, or 1 where it is exactly 0 - a divisor that keeps a degenerate direction finite. */
export function nonZero(value: FXExpr, fn: FXExprBuilderApi): FXExpr {
  return fn.select(fn.eq(value, fn.lit(0)), fn.lit(1), value);
}

/** `vector` at unit length, a zero vector left zero. Its length and the result are the locals
 *  `<hint>len` and `<hint>`. */
export function unitOrZero(
  vector: FXExpr,
  hint: string,
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  const length = local(`${hint}len`, fn.call("length", vector));
  return local(hint, fn.div(vector, nonZero(length, fn)));
}

/** A fresh draw in [0, 1) - `Math.random()` on the JS backend, a decorrelated GLSL hash on the
 *  standard tier (see the `rand` entry in `core/ir/FXFunctions.Internal.ts`). */
export function rand(fn: FXExprBuilderApi): FXExpr {
  return fn.call("rand");
}
