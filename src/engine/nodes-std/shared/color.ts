import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import type { FXGradientData } from "../../core/nodes/FXParamSpec";
import { DEFAULT_GRADIENT } from "../../core/nodes/FXParamSpec";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Color / gradient nodes (color-ramp, combine/split-color, hsl-adjust), shared by both backends.
 * A `gradient` param bakes inline into a piecewise `mix` chain (structural).
 */

/**
 * Evaluates a color gradient at scalar `t` as a piecewise-linear `mix` chain (positions are
 * compile-time constants, only `t` is runtime); a zero-width segment collapses to a hard edge.
 */
function evalGradient(gradient: FXGradientData, t: FXExpr, fn: FXExprBuilderApi): FXExpr {
  const stops = [...gradient.stops].sort((a, b) => a.position - b.position);
  const colorLit = (components: readonly number[]): FXExpr =>
    fn.litVec(components[0] ?? 0, components[1] ?? 0, components[2] ?? 0, components[3] ?? 1);
  // Guarded above (coerce rejects an empty gradient), but stay defensive: opaque white.
  const firstStop = stops[0];
  let rgba: FXExpr = firstStop !== undefined ? colorLit(firstStop.color) : fn.litVec(1, 1, 1, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const currentStop = stops[i];
    const nextStop = stops[i + 1];
    if (currentStop === undefined || nextStop === undefined) {
      throw new Error("gradient stop index out of bounds");
    }
    const span = nextStop.position - currentStop.position;
    const inverseSpan = span > 1e-6 ? 1 / span : 1e6;
    const localT = fn.call(
      "clamp",
      fn.mul(fn.sub(t, fn.lit(currentStop.position)), fn.lit(inverseSpan)),
      fn.lit(0),
      fn.lit(1),
    );
    rgba = fn.call("mix", rgba, colorLit(nextStop.color), localT);
  }
  return rgba;
}

/**
 * Color Ramp: maps a scalar `t` through an editable color gradient, emitting the sampled color
 * as an RGBA `vec4`. Bakes inline (no LUT/texture), so it works in both backends.
 */
export const fxColorRamp = defineNode({
  type: "color-ramp",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "color",
  inputs: { t: { type: "float", value: 0, min: 0, max: 1, step: 0.01 } },
  outputs: { color: { type: "vec4" } },
  params: {
    gradient: {
      kind: "structural",
      type: "gradient",
      default: DEFAULT_GRADIENT,
    },
  },
  // Each of the (stops - 1) segments bakes a localT clamp (sub+mul+clamp(2) = 4) + a vec4 mix
  // (3 per channel, matching fxMix's sub+mul+add weight, times 4 channels = 12), so 16 per
  // segment. Scales with the gradient's stop count, not a flat weight - a bigger gradient costs more.
  cost: ({ params }) => Math.max(1, (params.gradient as FXGradientData).stops.length - 1) * 16,
  build: ({ inputs, params, fn, local }) => ({
    color: local("rampColor", evalGradient(params.gradient, inputs["t"], fn)),
  }),
});

/**
 * Combine Color: assembles an RGB `vec3` and a scalar `alpha` into a single RGBA `vec4` - the
 * inverse of Split Color. A bare node emits opaque white, `vec4(1, 1, 1, 1)`.
 */
export const fxCombineColor = defineNode({
  type: "combine-color",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "color",
  inputs: {
    rgb: { type: "vec3", value: [1, 1, 1], min: 0, max: 1, step: 0.01, color: true },
    alpha: { type: "float", value: 1, min: 0, max: 1, step: 0.01 },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // `construct` assembles a vector from parts - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    color: fn.construct(FX_VALUE_TYPES.vec4, inputs["rgb"], inputs["alpha"]),
  }),
});

/**
 * Split Color: breaks an RGBA `vec4` color into its RGB `vec3` and scalar `alpha` - the
 * inverse of Combine Color, for routing the alpha (opacity) apart from the color.
 */
export const fxSplitColor = defineNode({
  type: "split-color",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "color",
  inputs: { color: { type: "vec4", value: [1, 1, 1, 1], color: true } },
  outputs: { rgb: { type: "vec3" }, alpha: { type: "float" } },
  params: {},
  // A swizzle is a re-index, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    rgb: fn.swizzle(inputs["color"], "xyz"),
    alpha: fn.swizzle(inputs["color"], "w"),
  }),
});

/**
 * Branchless HSL => RGB (`h`/`s`/`l` in `[0, 1]`, hue wraps via `mod`): a base RGB triangle
 * `clamp(|mod(h*6 + [0,4,2], 6) - 3| - 1, 0, 1)` is scaled by chroma `(1 - |2l - 1|)*s` and
 * biased by lightness: `rgb = (tri - 0.5) * chroma + l`.
 */
function hslToRgb(h: FXExpr, s: FXExpr, l: FXExpr, fn: FXExprBuilderApi): FXExpr {
  const shifted = fn.add(fn.litVec(0, 4, 2), fn.mul(h, fn.lit(6))); // vec3 + float (h*6 splat)
  const wrapped = fn.mod(shifted, fn.lit(6));
  const tri = fn.call(
    "clamp",
    fn.sub(fn.call("abs", fn.sub(wrapped, fn.lit(3))), fn.lit(1)),
    fn.lit(0),
    fn.lit(1),
  );
  const chroma = fn.mul(
    fn.sub(fn.lit(1), fn.call("abs", fn.sub(fn.mul(l, fn.lit(2)), fn.lit(1)))),
    s,
  );
  return fn.add(fn.mul(fn.sub(tri, fn.lit(0.5)), chroma), l);
}

/**
 * Branchless RGB => HSL, the inverse of {@link hslToRgb}. The hue sextant is picked with `eq`
 * indicators instead of a branch; a tiny epsilon on each denominator keeps a grey input finite.
 */
function rgbToHsl(
  color: FXExpr,
  fn: FXExprBuilderApi,
  local: (hint: string, expr: FXExpr) => FXExpr,
): { h: FXExpr; s: FXExpr; l: FXExpr } {
  const r = local("rgb_r", fn.swizzle(color, "x"));
  const g = local("rgb_g", fn.swizzle(color, "y"));
  const b = local("rgb_b", fn.swizzle(color, "z"));
  const maxChannel = local("rgb_max", fn.call("max", r, fn.call("max", g, b)));
  const minChannel = local("rgb_min", fn.call("min", r, fn.call("min", g, b)));
  const delta = local("rgb_d", fn.sub(maxChannel, minChannel));
  const deltaSafe = local("rgb_dSafe", fn.add(delta, fn.lit(1e-10)));
  const l = local("rgb_l", fn.mul(fn.add(maxChannel, minChannel), fn.lit(0.5)));
  // Which channel is the max drives the hue sextant (one-hot selectors).
  const selectorR = local("rgb_selR", fn.eq(maxChannel, r));
  const selectorG = local("rgb_selG", fn.mul(fn.sub(fn.lit(1), selectorR), fn.eq(maxChannel, g)));
  const selectorB = local("rgb_selB", fn.sub(fn.sub(fn.lit(1), selectorR), selectorG));
  const hR = fn.mod(fn.div(fn.sub(g, b), deltaSafe), fn.lit(6)); // wrap the red sextant into [0,6)
  const hG = fn.add(fn.div(fn.sub(b, r), deltaSafe), fn.lit(2));
  const hB = fn.add(fn.div(fn.sub(r, g), deltaSafe), fn.lit(4));
  const h6 = fn.add(fn.add(fn.mul(selectorR, hR), fn.mul(selectorG, hG)), fn.mul(selectorB, hB));
  const h = local("rgb_h", fn.div(h6, fn.lit(6)));
  // s = chroma / (1 - |2l - 1|); the denominator only vanishes where chroma already is 0.
  const denominator = fn.add(
    fn.sub(fn.lit(1), fn.call("abs", fn.sub(fn.mul(l, fn.lit(2)), fn.lit(1)))),
    fn.lit(1e-10),
  );
  const s = local("rgb_s", fn.div(delta, denominator));
  return { h, s, l };
}

/**
 * HSL Adjust: shifts an RGBA color's hue (additive, wraps via `fract`), saturation and lightness
 * (1 = keep, 0 = greyscale/black). Round-trips RGB -> HSL -> RGB entirely inline; alpha passes through.
 */
export const fxHslAdjust = defineNode({
  type: "hsl-adjust",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "color",
  inputs: {
    color: { type: "vec4", value: [1, 1, 1, 1], color: true },
    hueShift: { type: "float", value: 0, min: -1, max: 1, step: 0.01 },
    saturation: { type: "float", value: 1, min: 0, max: 2, step: 0.01 },
    lightness: { type: "float", value: 1, min: 0, max: 2, step: 0.01 },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // Flat: rgbToHsl (44: 2 max/min pairs, the l/delta/selector bookkeeping, 3 sextant slopes
  // each a divide+modulo, and the final hue/saturation divides) + hslToRgb (48: the wrap +
  // Hermite-less triangle wave is per-channel over vec3) + the hue-wrap/clamp adjustments (8).
  cost: 100,
  build: ({ inputs, local, fn }) => {
    const { h, s, l } = rgbToHsl(inputs["color"], fn, local);
    const h2 = fn.call("fract", fn.add(h, inputs["hueShift"]));
    const s2 = fn.call("clamp", fn.mul(s, inputs["saturation"]), fn.lit(0), fn.lit(1));
    const l2 = fn.call("clamp", fn.mul(l, inputs["lightness"]), fn.lit(0), fn.lit(1));
    const rgb = local("hslRgb", hslToRgb(h2, s2, l2, fn));
    return { color: fn.construct(FX_VALUE_TYPES.vec4, rgb, fn.swizzle(inputs["color"], "w")) };
  },
});
