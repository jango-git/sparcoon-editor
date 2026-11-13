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

/**
 * The target input a random seeds from by default - every target has it: a particle's id on a
 * particle or trail and in a behavior kernel, the mesh's own seed on a VFX mesh.
 */
export const FX_RANDOM_SEED_INPUT = "RANDOM_SEED";
