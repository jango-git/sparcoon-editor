/**
 * Id generation. The counter restarts each session, so it must be seeded from a loaded document
 * with {@link seedIdentifierCounter}, or a new id can overwrite a restored node.
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
