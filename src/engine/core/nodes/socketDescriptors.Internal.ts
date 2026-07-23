import * as fxExprBuilders from "../ir/FXExprBuilder";
import type { FXSocketDescriptor } from "../socket/FXSocket";
import type { FXGLSLTypeName, FXSocketType } from "../socket/FXValueType";
import { resolveValueType } from "../socket/FXValueType";
import type { FXSocketSpec, FXTargetInputDefault } from "./FXSocketSpec";

export function toSocketType(
  specification: FXSocketSpec,
  constraint: readonly FXGLSLTypeName[] | undefined,
): FXSocketType {
  if (specification.type === "T") {
    if (constraint === undefined) {
      throw new Error('FXNodeDefinition: a "T" socket requires a generic constraint');
    }
    return { generic: "T", constraint };
  }
  return resolveValueType(specification.type);
}

/**
 * The default expression a socket descriptor advertises - only a presence marker for
 * validation (`defaultValue === undefined`); the real per-instance literal is resolved
 * separately by `editableInputLiteral` against the live override and resolved type.
 */
export function socketDefaultExpr(specification: FXSocketSpec): FXSocketSpec["default"] {
  if (specification.value === undefined) {
    return specification.default;
  }
  if (typeof specification.value === "number") {
    return fxExprBuilders.lit(specification.value);
  }
  return specification.value.length >= 2
    ? fxExprBuilders.litVec(...specification.value)
    : fxExprBuilders.lit(specification.value[0] ?? 0);
}

export function toSocketDescriptors(
  specifications: Readonly<Record<string, FXSocketSpec>>,
  constraint: readonly FXGLSLTypeName[] | undefined,
): readonly FXSocketDescriptor[] {
  return Object.entries(specifications).map(([key, specification]) => ({
    key,
    type: toSocketType(specification, constraint),
    ...(specification.label !== undefined ? { label: specification.label } : {}),
    ...(specification.required !== undefined ? { required: specification.required } : {}),
    // Validation checks `defaultValue === undefined` to decide whether a required-but-
    // unconnected input is an error, so the socket default must carry onto the descriptor.
    defaultValue: socketDefaultExpr(specification),
  }));
}

export function isTargetInputDefault(value: unknown): value is FXTargetInputDefault {
  // `typeof null === "object"` too; `!value` excludes exactly that case without writing the
  // banned null literal.
  if (typeof value !== "object" || !value) {
    return false;
  }
  return "targetInput" in value;
}
