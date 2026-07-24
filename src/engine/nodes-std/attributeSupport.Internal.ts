import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import { assertValidAttributeName } from "../core/socket/FXAttribute";
import type { FXValueType } from "../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../core/socket/FXValueType";
import { checkStructuralParam } from "../core/nodes/structuralParams.Internal";

/**
 * Shared support for the `custom-attribute` twins (render/GPU, behavior/CPU): name
 * resolution and the `name`/`type` structural checks are identical, so they live here instead
 * of hand-syncing both. A core builtin (position/age/lifetime/id) has its own dedicated
 * `builtin-attribute` node and never reaches this path.
 */

/** The resolved source of a custom-attribute node: always a reserved user attribute. */
export interface FXAttributeSource {
  readonly sourceName: string;
  readonly valueType: FXValueType;
  readonly targetInput: string;
  readonly attributeRequest: FXAttributeRequest;
}

/** Resolves `name`/`type` to a read source, reserving the attribute via `deriveTargetInput(name)`. */
export function resolveAttributeSource(
  name: string,
  type: FXValueType,
  deriveTargetInput: (name: string) => string,
): FXAttributeSource {
  assertValidAttributeName(name, "custom-attribute.name");
  return {
    sourceName: name,
    valueType: type,
    targetInput: deriveTargetInput(name),
    attributeRequest: { name, type },
  };
}

/**
 * The custom-attribute `name`/`type` structural checks: both re-type by minting a fresh
 * node id, so an in-place change is rejected as `bad-param`. The placement param is inferred,
 * checked separately.
 */
export function checkAttributeStructuralParams(
  parameters: Readonly<Record<string, unknown>>,
  sourceName: string,
  valueType: FXValueType,
): void {
  checkStructuralParam(parameters, "name", sourceName);
  checkStructuralParam(parameters, "type", valueType.id, NUMERIC_VALUE_TYPES);
}
