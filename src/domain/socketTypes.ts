/**
 * Socket-type predicates the editor shares with the engine, so drop-validation and wire coloring
 * can't desync from the compiler's coercion rules; the editor never imports the engine directly.
 */

import { FX_VALUE_TYPES, isNumericType, isValueTypeId } from "../engine/core/socket/FXValueType";

/** Whether a resolved socket type string is one of the interconvertible numeric widths (float/vecN). */
export function isNumericSocketType(type: string): boolean {
  return isValueTypeId(type) && isNumericType(FX_VALUE_TYPES[type]);
}
