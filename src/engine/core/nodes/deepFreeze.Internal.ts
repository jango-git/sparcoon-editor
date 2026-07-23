/**
 * Recursively freezes a value/nested structure. `describe()`'s returned metadata shares
 * references with the live param schema, so this stops a mutating consumer from corrupting it.
 */
export function deepFreeze<T>(value: T): T {
  // `typeof null === "object"` too; the truthy check on `value` excludes exactly that case
  // without writing the banned null literal (metadata may genuinely carry a null, see
  // FXSocketSpec.default's three-state encoding).
  if (typeof value === "object" && value && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
