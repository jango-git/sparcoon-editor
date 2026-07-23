import { FXCompilerErrorException } from "../compiler/FXCompilerError";
import type { FXValueType } from "./FXValueType";

/**
 * A request to reserve a named per-particle attribute buffer alongside the packed `builtin`
 * state - written by a `store-attribute` node, read by a `read-attribute` node, matched by
 * name. One buffer per distinct name; only numeric (float/vecN) types are storable.
 */
export interface FXAttributeRequest {
  /** Matches {@link FX_ATTRIBUTE_NAME_PATTERN}. */
  readonly name: string;
  readonly type: FXValueType;
}

/** Legal attribute name: a lowercase letter followed by alphanumerics. */
export const FX_ATTRIBUTE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/** Whether `name` is a legal attribute name. */
export function isValidAttributeName(name: string): boolean {
  // Explicit type guard: a missing key reaches here as `undefined`, which `RegExp.test`
  // coerces to "undefined" - which matches the pattern, minting a bogus fx_undefined buffer.
  return typeof name === "string" && FX_ATTRIBUTE_NAME_PATTERN.test(name);
}

/**
 * Throws unless `name` is legal - used where a request is minted from serialized params,
 * so a malformed name fails loudly instead of corrupting a buffer key.
 */
export function assertValidAttributeName(name: string, context: string): void {
  if (!isValidAttributeName(name)) {
    throw new FXCompilerErrorException({
      code: "bad-attribute-name",
      message: `${context}: attribute name "${name}" must match ${FX_ATTRIBUTE_NAME_PATTERN.source}`,
    });
  }
}

/**
 * Canonical `+name:type+...` suffix folded into a compile target's name (sorted, so
 * order-independent) - moves the structural hash automatically when attributes change.
 */
export function canonicalAttributeSuffix(attributes: readonly FXAttributeRequest[]): string {
  if (attributes.length === 0) {
    return "";
  }
  const parts = [...attributes]
    .sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0))
    .map((attribute) => `${attribute.name}:${attribute.type.id}`);
  return `+${parts.join("+")}`;
}
