/**
 * Approximate op counts of one value-noise call by coordinate width, hand-counted from the
 * standard-tier source (`FX_GLSL_STANDARD_NOISE`, `FX_GLSL_STANDARD_NOISED`); baseline lands in
 * the same range.
 */
export const FX_NOISE_CALL_COST: Readonly<Record<number, number>> = { 1: 35, 2: 79, 3: 151 };
export const FX_NOISED_CALL_COST: Readonly<Record<number, number>> = { 2: 91, 3: 190 };
