/** Runtime type-guards / coercers for defending against corrupt persisted JSON; the `as*` helpers
 *  return the fallback on a malformed value rather than propagating it. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && Object(value) === value && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asFiniteNumber(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

/** A non-empty string, or `undefined` (a cleared/absent reference) for anything else. */
export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
