import type { FXCompilerError } from "./FXCompilerError";
import type { FXValueType } from "../socket/FXValueType";
import { FX_VALUE_TYPES } from "../socket/FXValueType";

/**
 * A plain identifier: what a target input/buffer `name` must be. Both backends splice it verbatim
 * into generated source, so a non-identifier only blows up in the backend's own compiler.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks that `type` is one of the canonical {@link FX_VALUE_TYPES}. Keyed on `glslTypeName`
 * (not `id`) since that is the spelling spliced verbatim into generated source.
 */
export function valueTypeError(
  targetName: string,
  type: FXValueType,
  label: string,
): FXCompilerError | undefined {
  const canonical = (FX_VALUE_TYPES as Record<string, FXValueType | undefined>)[type.glslTypeName];
  if (canonical?.components !== type.components) {
    return {
      code: "unknown-target-value-type",
      message: `target "${targetName}" ${label} has an unknown value type "${type.glslTypeName}" (${type.components.toString()} component(s)); use the canonical FX_VALUE_TYPES entries`,
      params: {
        targetName,
        label,
        glslTypeName: type.glslTypeName,
        components: type.components,
      },
    };
  }
  return undefined;
}

/** Whether `value` is a plain object (usable for property access). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  // `typeof null === "object"` too; every other "object" value is truthy, so this excludes
  // exactly the null case without writing the literal (banned - see naming-convention rules).
  return typeof value === "object" && Boolean(value);
}

/** Whether `value` looks like an {@link FXValueType} (a `components` count at least). */
export function isValueTypeShape(value: unknown): boolean {
  return isRecord(value) && typeof value["components"] === "number";
}

/** One `malformed-target-shape` error naming the structural `path` that failed `expected`. */
export function shapeError(name: string, path: string, expected: string): FXCompilerError {
  return {
    code: "malformed-target-shape",
    message: `target "${name}" is malformed: ${path} must be ${expected}`,
    params: { targetName: name, path, expected },
  };
}

/** Deterministic order for a token list by its JSON encoding (target-signature sorting). */
export function byJSON(first: unknown, second: unknown): number {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  return firstJson < secondJson ? -1 : firstJson > secondJson ? 1 : 0;
}
