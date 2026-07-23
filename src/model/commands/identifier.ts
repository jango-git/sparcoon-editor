/**
 * Stable id generation, reused across snapshots so the library can reconcile instances by id.
 * The counter starts at 0/session, so it MUST be seeded from any loaded document (see {@link seedIdentifierCounter}) or a re-mint silently overwrites a restored node.
 */

let counter = 0;

export function nextIdentifier(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/**
 * Raises the counter above every `<prefix>_<n>` id in `ids`, so later mints can't collide with a
 * loaded document. Shared across prefixes (`node_`, `conn_`), so any numeric suffix counts.
 */
export function seedIdentifierCounter(ids: Iterable<string>): void {
  for (const id of ids) {
    const suffix = /_(\d+)$/.exec(id)?.[1];
    if (suffix !== undefined) {
      counter = Math.max(counter, Number(suffix));
    }
  }
}
