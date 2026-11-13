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
