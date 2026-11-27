import { refNames } from "../ir/visit.Internal";
import type { FXRatedLocal } from "./rates.Internal";

/**
 * The locals `roots` read, transitively, themselves among them - only these are worth computing.
 * `locals` are in definition order (a local reads only earlier ones); `reads` holds the locals each
 * one reads directly.
 */
export function liveLocals(
  locals: readonly FXRatedLocal[],
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  roots: Iterable<string>,
): Set<string> {
  const live = new Set(roots);
  for (const local of [...locals].reverse()) {
    if (live.has(local.name)) {
      for (const name of reads.get(local.name) ?? []) {
        live.add(name);
      }
    }
  }
  return live;
}

/** `locals` without those `roots` do not read (dead-code elimination), in definition order. */
export function withoutDeadLocals<L extends FXRatedLocal>(
  locals: readonly L[],
  roots: Iterable<string>,
): L[] {
  const reads = new Map(
    locals.map((local) => [local.name, refNames(local.expr, "local", new Set())] as const),
  );
  const live = liveLocals(locals, reads, roots);
  return locals.filter((local) => live.has(local.name));
}
