import type { FXExpr } from "../ir/FXExpr";
import { childrenOf } from "../ir/visit.Internal";

/**
 * How often a value changes, as a rank a backend defines (render: constant < frame < view <
 * primitive < vertex < fragment; GPU behavior kernel: constant < pass < particle). A value changes at the highest rate of
 * anything it reads - a lattice join - so rates only ever compare by `>`/`max`.
 */
export type FXRate = number;

/** An SSA local as both backends' plans hold one: a name and the expression it is bound to. */
export interface FXRatedLocal {
  readonly name: string;
  readonly expr: FXExpr;
}

/** The backend's answers {@link classifyRates} cannot derive from the IR alone. */
export interface FXRatePolicy {
  /**
   * The rate of what the plan cannot move: an impure call, a `raw` not marked `pure`, a local ref
   * the plan does not define. The highest rank, so nothing reading it moves either.
   */
  readonly pinned: FXRate;
  /** The rate of a non-local ref (a target input, a uniform, a binding, ...). */
  rateOfRef(ref: Extract<FXExpr, { kind: "ref" }>): FXRate;
  /** Whether a call is impure (`rand`): it is pinned, as an impure value must not be shared. */
  isImpureCall(fn: string): boolean;
}

/**
 * The rate of every local in an SSA plan (in definition order: a local only reads earlier ones).
 * A literal is rank 0; a pure node takes the highest rate of its children; see
 * {@link FXRatePolicy} for refs and for what is pinned.
 */
export function classifyRates(
  locals: readonly FXRatedLocal[],
  policy: FXRatePolicy,
): Map<string, FXRate> {
  const rates = new Map<string, FXRate>();
  const highest = (expressions: readonly FXExpr[]): FXRate =>
    expressions.reduce((rate, child) => Math.max(rate, rateOf(child)), 0);
  const rateOf = (expression: FXExpr): FXRate => {
    switch (expression.kind) {
      case "lit":
        return 0;
      case "ref":
        return expression.ref === "local"
          ? (rates.get(expression.name) ?? policy.pinned)
          : policy.rateOfRef(expression);
      case "raw":
        return expression.pure === true ? highest(expression.deps) : policy.pinned;
      case "call":
        return policy.isImpureCall(expression.fn) ? policy.pinned : highest(childrenOf(expression));
      // The highest of the children. Enumerated (not `default`) so a new kind must be classified
      // here, not silently inherit this rule and be moved where it must not go.
      case "bin":
      case "un":
      case "swizzle":
      case "column":
      case "construct":
      case "select":
        return highest(childrenOf(expression));
    }
  };
  for (const local of locals) {
    rates.set(local.name, rateOf(local.expr));
  }
  return rates;
}

/**
 * A rough ALU count of one expression - what moving it saves: every arithmetic, call, select and
 * raw node counts one; refs, literals and the pure data movement of swizzles, constructors and
 * column reads count nothing.
 */
export function operationCount(expression: FXExpr): number {
  const own = ((): number => {
    switch (expression.kind) {
      case "bin":
      case "un":
      case "call":
      case "select":
      case "raw":
        return 1;
      case "lit":
      case "ref":
      case "swizzle":
      case "column":
      case "construct":
        return 0;
    }
  })();
  return childrenOf(expression).reduce((sum, child) => sum + operationCount(child), own);
}

/**
 * The locals that cost nothing to define wherever they are read, so a placement defines them there
 * instead of carrying or lifting them: each constant (rate 0), and each free alias (no operation)
 * of at most `maxRate` that reads only such locals. `reads` are each local's local reads.
 */
export function freeEverywhere(
  locals: readonly FXRatedLocal[],
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  rates: ReadonlyMap<string, FXRate>,
  maxRate: FXRate,
): Set<string> {
  const free = new Set<string>();
  // Definition order: a local's reads are decided before it.
  for (const local of locals) {
    const rate = rates.get(local.name) ?? Infinity;
    if (
      rate === 0 ||
      (rate <= maxRate &&
        operationCount(local.expr) === 0 &&
        [...(reads.get(local.name) ?? [])].every((name) => free.has(name)))
    ) {
      free.add(local.name);
    }
  }
  return free;
}
