import type { FXValueType } from "./FXValueType";
import { FX_VALUE_TYPES } from "./FXValueType";

/**
 * Host builtins a `read-attribute` node may read as a value source - shared by both backends,
 * mapping a lowercase editor name to its target input and fixed type. Unlike a user attribute,
 * a builtin reads existing host state (no buffer allocated) and its name cannot be shadowed.
 */
export const FX_READABLE_CORE_BUILTINS: Readonly<
  Record<string, { readonly targetInput: string; readonly type: FXValueType }>
> = {
  position: { targetInput: "PARTICLE_POSITION", type: FX_VALUE_TYPES.vec3 },
  age: { targetInput: "PARTICLE_AGE", type: FX_VALUE_TYPES.float },
  lifetime: { targetInput: "PARTICLE_LIFETIME", type: FX_VALUE_TYPES.float },
  id: { targetInput: "PARTICLE_ID", type: FX_VALUE_TYPES.float },
};
