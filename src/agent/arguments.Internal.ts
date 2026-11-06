/**
 * Shape checks for plain argument values (numbers, vectors, option objects) the agent passes in.
 * A driver hands over untyped JSON, so these run before any command sees the value.
 */

import { AgentError } from "./errors";

export function requireFiniteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentError("invalid_argument", `${name} must be a finite number.`);
  }
  return value;
}

export function requireVector3(name: string, value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new AgentError("invalid_argument", `${name} must be an array of 3 finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** An integer in `[minimum, maximum]` (image sizes, grid columns). */
export function requireInteger(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  const integer = requireFiniteNumber(name, value);
  if (!Number.isInteger(integer) || integer < minimum || integer > maximum) {
    throw new AgentError(
      "invalid_argument",
      `${name} must be an integer in [${String(minimum)}, ${String(maximum)}].`,
    );
  }
  return integer;
}

/**
 * Checks an options/patch object names only `allowed` keys - a misspelt key would otherwise be
 * ignored without a trace.
 */
export function requireKnownKeys(name: string, value: object, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentError(
      "invalid_argument",
      `${name} has no ${unknown.map((key) => `"${key}"`).join(", ")} (known: ${allowed.join(", ")}).`,
    );
  }
}

/**
 * A private copy of a value the agent hands in, so the document never shares an array or object
 * the caller can still change afterwards. Refuses what is not plain data (functions, DOM nodes).
 */
export function copyPlainData<T>(name: string, value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new AgentError("invalid_argument", `${name} must be plain data.`);
  }
}
