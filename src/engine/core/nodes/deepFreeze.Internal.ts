/**
 * Recursively freezes a value/nested structure. `describe()`'s returned metadata shares
 * references with the live param schema, so this stops a mutating consumer from corrupting it.
 */
export function deepFreeze<T>(value: T): T {
  // A null is also `typeof "object"`; the truthy check excludes it.
  if (typeof value === "object" && value && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
