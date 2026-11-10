import { FX_LIGHTING_INTRINSIC, type FXLightingIntrinsicName } from "sparcoon/editor";
import { defineNode } from "../../core/nodes/defineNode";
import type {
  FXExprBuilderApi,
  FXNodeDefinition,
  FXResolvedInputs,
} from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Lighting-as-nodes (Blender-BSDF style): a lighting node shades a color via a runtime
 * **intrinsic** - `build` emits a bare call with no body, so the IR never sees Three-specific
 * light code. `lightingIntrinsic` lets `collectRenderCapabilities` union the graph's needs into
 * the artifact's capability, so the runtime material defines exactly those `fx`-ABI functions.
 */

const VEC4 = FX_VALUE_TYPES.vec4;

/** The inputs every lighting node opens with: the color to shade and the normal to shade it by. */
const SHADED_INPUTS = {
  color: { type: "vec4", value: [1, 1, 1, 1], color: true },
  // Unconnected -> the world-space `geometryNormal` builtin (the particle's surface normal).
  normal: { type: "vec3", required: false },
} as const;

/** The input every lighting node closes with: unlit color added on top. */
const EMISSION_INPUT = {
  emission: { type: "vec4", value: [0, 0, 0, 1], color: true },
} as const;

type FXShadedInputs = typeof SHADED_INPUTS & typeof EMISSION_INPUT;

/** The descriptor fields {@link shading} fills in. */
interface FXShadingParts<I extends FXShadedInputs> {
  readonly reads: readonly string[];
  readonly lightingIntrinsic: FXLightingIntrinsicName;
  readonly build: (args: {
    inputs: FXResolvedInputs<FXShadedInputs> & FXResolvedInputs<I>;
    target: { read: (name: string) => FXExpr };
    fn: FXExprBuilderApi;
  }) => Record<string, FXExpr>;
}

/**
 * The lighting part of a lighting node's descriptor: the intrinsic it calls, the normal it falls
 * back to, and its build - `intrinsic(color, normal, ...settings(inputs))` with the emission added
 * on top. Emission rgb is added and the shaded alpha kept, so a default-black emission is a no-op,
 * and it bypasses lighting by construction. `settings` picks the intrinsic's further arguments, in
 * its parameter order.
 */
function shading<I extends FXShadedInputs>(
  intrinsic: FXLightingIntrinsicName,
  settings: (inputs: FXResolvedInputs<I>) => readonly FXExpr[] = () => [],
): FXShadingParts<I> {
  return {
    reads: ["geometryNormal"],
    lightingIntrinsic: intrinsic,
    build: ({ inputs, target, fn }): Record<string, FXExpr> => {
      const extra = settings(inputs);
      const placeholders = ["$0", "$1", ...extra.map((_, index) => `$${index + 2}`)];
      const shaded = fn.raw(
        VEC4,
        "glsl",
        `${intrinsic}(${placeholders.join(", ")})`,
        inputs.color,
        inputs.normal ?? target.read("geometryNormal"),
        ...extra,
      );
      const emission = fn.construct(VEC4, fn.swizzle(inputs.emission, "xyz"), fn.lit(0));
      return { color: fn.add(shaded, emission) };
    },
  };
}

/** Diffuse Lambert shading (direct + indirect + shadows) applied to the input color. */
export const fxLambertShading = defineNode({
  type: "lambert-shading",
  domain: "render",
  stage: "fragment",
  category: "lighting",
  inputs: { ...SHADED_INPUTS, ...EMISSION_INPUT },
  outputs: { color: { type: "vec4" } },
  params: {},
  // The runtime intrinsic evaluates direct lights + shadows + an indirect probe - a genuinely
  // heavy black box (a real per-scene-light loop, not statically countable); ~60 is a rough
  // order-of-magnitude, plus the emission vec4 add (4).
  cost: 64,
  ...shading(FX_LIGHTING_INTRINSIC.lambert),
});

const HALF_LIT_INPUTS = {
  ...SHADED_INPUTS,
  wrap: { type: "float", value: 1, min: 0, max: 1, step: 0.01 },
  // In Lambert's units: 1 glows as bright as a fully lit face.
  scatter: { type: "float", value: 0.5, min: 0, max: 2, step: 0.01 },
  focus: { type: "float", value: 8, min: 1, max: 64, step: 0.5 },
  ...EMISSION_INPUT,
} as const;

/**
 * Lambert with a soft terminator and light scattered through toward the camera - smoke, dust,
 * clouds: `wrap` lifts the unlit side (0 = Lambert, 1 = half-Lambert), `scatter` adds the glow of a
 * light behind the particle and `focus` narrows it around the light's direction.
 */
export const fxHalfLitShading = defineNode({
  type: "half-lit-shading",
  domain: "render",
  stage: "fragment",
  category: "lighting",
  inputs: HALF_LIT_INPUTS,
  outputs: { color: { type: "vec4" } },
  params: {},
  // Lambert's light loop with a wrapped term and a scatter pow per light, plus the input clamps.
  cost: 72,
  ...shading<typeof HALF_LIT_INPUTS>(FX_LIGHTING_INTRINSIC.halfLit, (inputs) => [
    inputs.wrap,
    inputs.scatter,
    inputs.focus,
  ]),
});

/** Indirect-only diffuse shading (ambient + light probe / SH + hemisphere; no direct lights/shadows). */
export const fxAmbientShading = defineNode({
  type: "ambient-shading",
  domain: "render",
  stage: "fragment",
  category: "lighting",
  inputs: { ...SHADED_INPUTS, ...EMISSION_INPUT },
  outputs: { color: { type: "vec4" } },
  params: {},
  // Indirect-only (no direct-light loop or shadow sampling), so cheaper than Lambert's ~60;
  // still a probe/hemisphere evaluation, plus the emission vec4 add (4).
  cost: 34,
  ...shading(FX_LIGHTING_INTRINSIC.ambient),
});

/** All standard lighting node definitions. */
export const FX_RENDER_LIGHTING_NODES: readonly FXNodeDefinition[] = [
  fxLambertShading,
  fxHalfLitShading,
  fxAmbientShading,
];
