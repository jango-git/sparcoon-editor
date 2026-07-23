/**
 * Shared code-emission helpers for the concrete behavior nodes: JS fragments the CPU kernel
 * hoists once per phase (see {@link FXCompiledKernelPhase.helpers}).
 * @internal
 */

/** Dedup key + name of the shared LUT sampler, `fxSampleLut(lut, t)` -> float. */
export const SAMPLE_LUT_FN_NAME = "fxSampleLut";

/**
 * Source of the shared curve-LUT sampler: clamps `t` to [0, 1] and interpolates the array.
 * Reads `lut.length` directly, so one helper serves any resolution.
 */
export const SAMPLE_LUT_HELPER_SOURCE = `function ${SAMPLE_LUT_FN_NAME}(lut, t) {
  const n = lut.length;
  const last = n - 1;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = clamped * last;
  const i = Math.floor(x);
  const f = x - i;
  const a = lut[i];
  const b = lut[i + 1 < n ? i + 1 : last];
  return a + (b - a) * f;
}`;
