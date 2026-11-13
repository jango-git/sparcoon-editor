import { refNames } from "../ir/visit.Internal";
import { liveLocals } from "./liveness.Internal";
import type { FXRate, FXRatedLocal } from "./rates.Internal";
import { freeEverywhere, operationCount } from "./rates.Internal";

/**
 * A two-stage SSA plan: `early` locals run first (once per vertex), `late` ones after (once per
 * fragment), each stage in definition order. A late local may read early ones - each such value
 * crosses between the stages - but never the reverse. `lateRoots` are the late stage's outputs
 * (the locals its result slots read), which keep what they read alive in the late stage.
 */
export interface FXTwoStagePlan<L extends FXRatedLocal> {
  readonly early: readonly L[];
  readonly late: readonly L[];
  readonly lateRoots: readonly string[];
}

/** A placed plan: each stage's locals in definition order, and the early locals the late stage
 *  reads across the boundary. A constant (or a free alias of what both stages read) is never
 *  carried: each stage reading one defines it. */
export interface FXPlacedPlan<L extends FXRatedLocal> {
  readonly early: readonly L[];
  readonly late: readonly L[];
  readonly crossing: readonly L[];
}

/** What {@link hoistToEarlyStage} needs from the backend beyond the plan. */
export interface FXHoistPolicy<L extends FXRatedLocal> {
  /** Every local's rate (see `classifyRates`), early and late alike; rate 0 is a constant. */
  readonly rates: ReadonlyMap<string, FXRate>;
  /** The highest rate a late local may have and still move: one constant across what an early
   *  invocation's outputs are spread over (render: a particle's primitive). */
  readonly maxRate: FXRate;
  /** The highest rate both stages read for free, with no carrying (render: a draw's uniforms). A
   *  local of at most this rate that costs nothing and reads only such locals is, like a constant,
   *  defined in each stage that reads it and never carried. */
  readonly sharedRate: FXRate;
  /**
   * Whether a candidate crossing - the early locals the late stage reads - fits what the backend
   * can carry between the stages, with `late` the late stage then. Called with the original
   * plan's crossing too: a plan that does not fit to begin with keeps only the moves that add
   * nothing to it.
   */
  fits(crossing: readonly L[], late: readonly L[]): boolean;
}

/**
 * Places a two-stage plan. Every late local the late stage's result reads whose value is
 * constant across an early invocation's span (0 < rate <= `maxRate`) moves to the early stage, so it is computed once per vertex
 * instead of once per fragment, and the late stage reads the result across the boundary instead.
 * A constant (rate 0) is not moved but defined in each stage that reads it - the compiler folds
 * it, where carrying it would only spend a varying. So is a free local both stages can read as it
 * is (rate <= `sharedRate`, no operation, reading only such locals): an alias of a uniform.
 *
 * A late local the late stage's result does not read is dropped.
 *
 * Then gives back to the late stage, one at a time and only from the top of a moved chain (a
 * moved local the late stage reads and no moved local does), what is not worth carrying:
 * - a move that saves nothing (pure data movement - an alias, a swizzle, a constructor): the
 *   late stage recomputes it for free, and what it reads may cross more tightly;
 * - while the crossing does not fit, the cheapest one.
 *
 * Definition order is kept within each stage, so every local still follows what it reads. The
 * locals themselves are not changed: only which stages hold them.
 */
export function hoistToEarlyStage<L extends FXRatedLocal>(
  plan: FXTwoStagePlan<L>,
  policy: FXHoistPolicy<L>,
): FXPlacedPlan<L> {
  const all = [...plan.early, ...plan.late];
  const reads = new Map(all.map((local) => [local.name, refNames(local.expr, "local", new Set())]));
  /** What `names` read directly, with `also` added. */
  const readBy = (names: Iterable<string>, also: Iterable<string> = []): Set<string> => {
    const read = new Set(also);
    for (const name of names) {
      for (const each of reads.get(name) ?? []) {
        read.add(each);
      }
    }
    return read;
  };
  const rateOf = (local: L): number => policy.rates.get(local.name) ?? Infinity;
  // Defined in each stage that reads it, never carried.
  const everywhere = freeEverywhere(all, reads, policy.rates, policy.sharedRate);
  const early = new Set(plan.early.map((local) => local.name));

  // What the late stage's result reads, transitively. Nothing else of the late stage is kept: a
  // dead local would only spend a varying on what it reads.
  const live = liveLocals(plan.late, reads, plan.lateRoots);
  const lateLive = plan.late.filter((local) => live.has(local.name));
  const moved = new Set(
    lateLive
      .filter((local) => !everywhere.has(local.name) && rateOf(local) <= policy.maxRate)
      .map((local) => local.name),
  );

  /** The late stage's own locals (none defined everywhere) while `moved` holds what it does. */
  const lateNow = (): L[] =>
    lateLive.filter((local) => !moved.has(local.name) && !everywhere.has(local.name));
  /** The early locals (originally there or moved) the late stage reads; what is defined
   *  everywhere never crosses. */
  const crossingOf = (late: readonly L[], carried: ReadonlySet<string>): L[] => {
    const read = readBy(
      late.map((local) => local.name),
      plan.lateRoots,
    );
    return all.filter(
      (local) =>
        read.has(local.name) &&
        !everywhere.has(local.name) &&
        (early.has(local.name) || carried.has(local.name)),
    );
  };
  // A moved local the late stage reads and no moved local does: giving it back keeps every moved
  // local's reads in the early stage.
  const tops = (): L[] => {
    const readByMoved = readBy(moved);
    return crossingOf(lateNow(), moved).filter(
      (local) => moved.has(local.name) && !readByMoved.has(local.name),
    );
  };

  for (let free = tops().find(isFree); free !== undefined; free = tops().find(isFree)) {
    moved.delete(free.name);
  }

  // The plan as it came, nothing moved.
  const original = crossingOf(
    lateLive.filter((local) => !everywhere.has(local.name)),
    new Set(),
  );
  const originalFits = policy.fits(original, lateNow());
  const fitsNow = (): boolean => {
    const crossing = crossingOf(lateNow(), moved);
    return originalFits ? policy.fits(crossing, lateNow()) : crossing.length <= original.length;
  };
  while (moved.size > 0 && !fitsNow()) {
    const cheapest = tops().reduce<L | undefined>(
      (best, local) =>
        best === undefined || operationCount(local.expr) < operationCount(best.expr) ? local : best,
      undefined,
    );
    if (cheapest === undefined) {
      break;
    }
    moved.delete(cheapest.name);
  }

  // Each stage defines the everywhere locals it reads itself: the late stage those its own locals
  // and roots read, the early stage also those the moved locals read. Definition order is kept.
  const late = lateNow();
  const lateNeeds = withEverywhere(
    late.map((local) => local.name),
    plan.lateRoots,
    everywhere,
    reads,
  );
  const earlyNeeds = withEverywhere(moved, [], everywhere, reads);
  return {
    early: all.filter(
      (local) =>
        early.has(local.name) ||
        moved.has(local.name) ||
        (everywhere.has(local.name) && earlyNeeds.has(local.name)),
    ),
    late: all.filter(
      (local) => late.includes(local) || (everywhere.has(local.name) && lateNeeds.has(local.name)),
    ),
    crossing: crossingOf(late, moved),
  };
}

/**
 * The everywhere locals a stage defines itself: those its own locals (`defined`) read, transitively,
 * and those among `alsoRead` (what its result reads directly). Only through what the stage defines:
 * a value it reads across the boundary brings nothing of what that value read.
 */
function withEverywhere(
  defined: Iterable<string>,
  alsoRead: Iterable<string>,
  everywhere: ReadonlySet<string>,
  reads: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const closure = new Set(defined);
  for (const name of alsoRead) {
    if (everywhere.has(name)) {
      closure.add(name);
    }
  }
  const pending = [...closure];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    for (const read of reads.get(name) ?? []) {
      if (everywhere.has(read) && !closure.has(read)) {
        closure.add(read);
        pending.push(read);
      }
    }
  }
  return closure;
}

function isFree(local: FXRatedLocal): boolean {
  return operationCount(local.expr) === 0;
}
