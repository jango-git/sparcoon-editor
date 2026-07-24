import type { FXValueType } from "./FXValueType";
import { FX_VALUE_TYPES } from "./FXValueType";

/**
 * The four host builtins `builtin-attribute` exposes at once, one output socket each -
 * shared by both backends, mapping a lowercase name to its target input and fixed type. Unlike
 * a user attribute, a builtin reads existing host state directly (no buffer allocated), so its
 * name is reserved and cannot be declared as a custom attribute (see `isReservedAttributeName`).
 */
export const FX_READABLE_CORE_BUILTINS: Readonly<
  Record<string, { readonly targetInput: string; readonly type: FXValueType }>
> = {
  position: { targetInput: "PARTICLE_POSITION", type: FX_VALUE_TYPES.vec3 },
  age: { targetInput: "PARTICLE_AGE", type: FX_VALUE_TYPES.float },
  lifetime: { targetInput: "PARTICLE_LIFETIME", type: FX_VALUE_TYPES.float },
  id: { targetInput: "PARTICLE_ID", type: FX_VALUE_TYPES.float },
};
