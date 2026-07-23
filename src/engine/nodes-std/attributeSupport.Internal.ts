import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import { assertValidAttributeName } from "../core/socket/FXAttribute";
import type { FXValueType } from "../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../core/socket/FXValueType";
import { FX_READABLE_CORE_BUILTINS } from "../core/socket/FXReadableBuiltins";
import { checkStructuralParam } from "../core/nodes/structuralParams.Internal";

/**
 * Shared support for the `read-attribute` twins (render/GPU, behavior/CPU): name resolution and
 * the `name`/`type` structural checks are identical, so they live here instead of hand-syncing both.
 */

/** The resolved source of a read-attribute node: a core builtin, or a reserved user attribute. */
export interface FXAttributeSource {
  readonly sourceName: string;
  readonly valueType: FXValueType;
  readonly targetInput: string;
  readonly attributeRequest: FXAttributeRequest | undefined;
}

/**
 * Resolves `name`/`type` to a read source: a core builtin (`position`/`age`/...) reads directly
 * (its type authoritative); otherwise it reserves a user attribute via `deriveTargetInput(name)`.
 */
export function resolveAttributeSource(
  name: string,
  type: FXValueType,
  deriveTargetInput: (name: string) => string,
): FXAttributeSource {
  const builtin = FX_READABLE_CORE_BUILTINS[name];
  if (builtin === undefined) {
    assertValidAttributeName(name, "read-attribute.name");
  }
  return {
    sourceName: name,
    valueType: builtin?.type ?? type,
    targetInput: builtin?.targetInput ?? deriveTargetInput(name),
    attributeRequest: builtin === undefined ? { name, type } : undefined,
  };
}

/**
 * The read-attribute `name`/`type` structural checks: both re-type by minting a fresh node id, so
 * an in-place change is rejected as `bad-param`. The placement param is inferred, checked separately.
 */
export function checkAttributeStructuralParams(
  parameters: Readonly<Record<string, unknown>>,
  sourceName: string,
  valueType: FXValueType,
): void {
  checkStructuralParam(parameters, "name", sourceName);
  checkStructuralParam(parameters, "type", valueType.id, NUMERIC_VALUE_TYPES);
}
