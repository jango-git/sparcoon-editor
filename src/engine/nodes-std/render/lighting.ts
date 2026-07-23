import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition, FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Lighting-as-nodes (Blender-BSDF style): a lighting node shades a color via a runtime
 * **intrinsic** - `build` emits a bare call with no body, so the IR never sees Three-specific
 * light code. `lightingIntrinsic` lets `collectLightingRequirements` union the graph's needs into
 * the artifact's capability, so the runtime material defines exactly those `fx_`-ABI functions.
 */

const VEC4 = FX_VALUE_TYPES.vec4;

/** Adds an unlit emission color on top of a shaded color: emission rgb is added and the shaded alpha
 *  is kept, so a default-black emission is a no-op. Emission bypasses lighting by construction. */
function withEmission(shaded: FXExpr, emission: FXExpr, fn: FXExprBuilderApi): FXExpr {
  return fn.add(shaded, fn.construct(VEC4, fn.swizzle(emission, "xyz"), fn.lit(0)));
}

/** Diffuse Lambert shading (direct + indirect + shadows) applied to the input color. */
export const fxLambertShading = defineNode({
  type: "lambert-shading",
  domain: "render",
  stage: "fragment",
  category: "lighting",
  inputs: {
    color: { type: "vec4", value: [1, 1, 1, 1], color: true },
    // Unconnected -> the world-space `geometryNormal` builtin (the particle's surface normal).
    normal: { type: "vec3", required: false },
    emission: { type: "vec4", value: [0, 0, 0, 1], color: true },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // The runtime intrinsic evaluates direct lights + shadows + an indirect probe - a genuinely
  // heavy black box (a real per-scene-light loop, not statically countable); ~60 is a rough
  // order-of-magnitude, plus the emission vec4 add (4).
  cost: 64,
  reads: ["geometryNormal"],
  lightingIntrinsic: "fxLambertShade",
  build: ({ inputs, target, fn }) => ({
    color: withEmission(
      fn.raw(
        VEC4,
        "glsl",
        "fxLambertShade($0, $1)",
        inputs["color"],
        inputs["normal"] ?? target.read("geometryNormal"),
      ),
      inputs["emission"],
      fn,
    ),
  }),
});

/** Indirect-only diffuse shading (ambient + light probe / SH + hemisphere; no direct lights/shadows). */
export const fxAmbientShading = defineNode({
  type: "ambient-shading",
  domain: "render",
  stage: "fragment",
  category: "lighting",
  inputs: {
    color: { type: "vec4", value: [1, 1, 1, 1], color: true },
    normal: { type: "vec3", required: false },
    emission: { type: "vec4", value: [0, 0, 0, 1], color: true },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // Indirect-only (no direct-light loop or shadow sampling), so cheaper than Lambert's ~60;
  // still a probe/hemisphere evaluation, plus the emission vec4 add (4).
  cost: 34,
  reads: ["geometryNormal"],
  lightingIntrinsic: "fxAmbientShade",
  build: ({ inputs, target, fn }) => ({
    color: withEmission(
      fn.raw(
        VEC4,
        "glsl",
        "fxAmbientShade($0, $1)",
        inputs["color"],
        inputs["normal"] ?? target.read("geometryNormal"),
      ),
      inputs["emission"],
      fn,
    ),
  }),
});

/** All standard lighting node definitions. */
export const FX_RENDER_LIGHTING_NODES: readonly FXNodeDefinition[] = [
  fxLambertShading,
  fxAmbientShading,
];
