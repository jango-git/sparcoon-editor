/** Component count of a seed hash's result. */
export type FXSeedHashComponents = 1 | 2 | 3 | 4;

export const FX_SEED_HASH_COMPONENTS: readonly FXSeedHashComponents[] = [1, 2, 3, 4];

/** The registry function name for a result width, e.g. `seedHash3`. */
export function seedHashFunctionName(components: FXSeedHashComponents): string {
  return `seedHash${components.toString()}`;
}

/** The function a width prints as, in GLSL and in JS. */
export function seedHashGLSLName(
  components: FXSeedHashComponents,
): `fxSeedHash${FXSeedHashComponents}` {
  return `fxSeedHash${components}`;
}

/** The result type of each width. */
export const FX_SEED_HASH_TYPES = { 1: "float", 2: "vec2", 3: "vec3", 4: "vec4" } as const;

/**
 * Approximate op counts of one call by result width (standard tier: the key's three products,
 * xors and two PCG rounds, then a PCG round and a unit per further component).
 */
export const FX_SEED_HASH_CALL_COST: Readonly<Record<FXSeedHashComponents, number>> = {
  1: 24,
  2: 34,
  3: 44,
  4: 54,
};
