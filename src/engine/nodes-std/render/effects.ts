import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import type { FXExpr } from "../../core/ir/FXExpr";
import { litVec } from "../../core/ir/FXExprBuilder";
import type { FXGLSLHelperName } from "../../core/ir/FXHelpers.Internal";
import { FX_NOISE_CALL_COST } from "../../core/ir/noise/FXValueNoise.Internal";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Standard-library render effect nodes (fragment): compositing, masks, normals. GLSL with no IR
 * form (blend math, noise, spherical normal) is emitted as `raw` over `emitHelper`-installed helpers.
 */

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;

/** The blend modes `blend` implements - the single source for its enum options and switch. */
const BLEND_MODES = ["normal", "add", "multiply", "screen"] as const;
type FXBlendMode = (typeof BLEND_MODES)[number];

/** Op-count estimate per mode's formula (see the `switch` in `fxBlend.build`). */
const BLEND_MODE_COST: Readonly<Record<FXBlendMode, number>> = {
  // alpha composite (sub+mul+add = 3) + rgb lerp (two vec3*scalar terms + a vec3 add = 13) +
  // a vec3/scalar divide (2 per component = 6) = 23.
  normal: 23,
  add: 4, // vec4 add
  multiply: 4, // vec4 multiply
  screen: 16, // 3 vec4 subtracts + a vec4 multiply, 4 per component each
};

/** Composites `blend` over `base` with a chosen (structural) mode. */
export const fxBlend = defineNode({
  type: "blend",
  domain: "render",
  stage: "fragment",
  category: "color",
  inputs: {
    base: { type: "vec4", required: true, value: [1, 1, 1, 1], color: true },
    blend: { type: "vec4", required: true, value: [1, 1, 1, 1], color: true },
  },
  outputs: { color: { type: "vec4" } },
  params: {
    mode: {
      kind: "structural",
      type: "enum",
      options: BLEND_MODES,
      default: "normal",
    },
  },
  cost: ({ params: parameters }) => BLEND_MODE_COST[parameters.mode as FXBlendMode],
  build: ({ inputs, params: parameters, emitHelper, fn }) => {
    const base = inputs["base"];
    const blend = inputs["blend"];
    // Exhaustive over BLEND_MODES: a missing case is a `never` compile error.
    const mode = parameters.mode as FXBlendMode;
    switch (mode) {
      case "normal":
        emitHelper("FX_GLSL_BLEND_NORMAL");
        return { color: fn.pureRaw(VEC4, "glsl", "fxBlendNormal($0, $1)", base, blend) };
      case "add":
        return { color: fn.add(base, blend) };
      case "multiply":
        return { color: fn.mul(base, blend) };
      case "screen": {
        const one = litVec(1, 1, 1, 1);
        return { color: fn.sub(one, fn.mul(fn.sub(one, base), fn.sub(one, blend))) };
      }
      default: {
        // Unreachable: coerce rejects other values.
        const unreachable: never = mode;
        throw new FXCompilerErrorException({
          code: "unhandled-blend-mode",
          message: `blend: unsupported mode "${String(unreachable)}"`,
          params: { mode: String(unreachable) },
        });
      }
    }
  },
});

/** Multiplies alpha by a soft circular mask centered on the UV. */
export const fxSphericalClip = defineNode({
  type: "spherical-clip",
  domain: "render",
  stage: "fragment",
  category: "mask",
  inputs: {
    color: { type: "vec4", value: [1, 1, 1, 1], color: true },
    innerRadius: { type: "float", value: 0.3, min: 0, max: 0.5, step: 0.01 },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // distance (sub(2)+length(5)=7) + smoothstep (3 flat guard + 8 per component, scalar = 11) +
  // a vec4 multiply (4) = 22.
  cost: 22,
  reads: ["p_uv"],
  build: ({ inputs, target, emitHelper, fn }) => {
    emitHelper("FX_GLSL_SPHERICAL_CLIP");
    const clip = fn.pureRaw(
      VEC4,
      "glsl",
      "fxApplySphericalClip($0, $1)",
      target.read("p_uv"),
      inputs["innerRadius"],
    );
    return { color: fn.mul(inputs["color"], clip) };
  },
});

/** Erodes alpha with a noise field advancing over the particle lifetime (dissolve). */
export const fxDissolve = defineNode({
  type: "dissolve",
  domain: "render",
  stage: "fragment",
  category: "mask",
  inputs: {
    color: { type: "vec4", required: true, value: [1, 1, 1, 1], color: true },
    scale: { type: "float", value: 4, min: 0, max: 64, step: 0.5 },
    edge: { type: "float", value: 0.1, min: 0, max: 2, step: 0.01 },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // progress (3) + uv*scale (2) + vec2 noise + remap (2) + edge guard (1) + span add (1) +
  // smoothstep (11) + alpha multiply (1).
  cost: 21 + (FX_NOISE_CALL_COST[2] ?? 0),
  reads: ["PARTICLE_AGE", "PARTICLE_LIFETIME", "p_uv"],
  build: ({ inputs, target, local, fn }) => {
    const progress = local(
      "dissolveProgress",
      fn.call("saturate", fn.div(target.read("PARTICLE_AGE"), target.read("PARTICLE_LIFETIME"))),
    );
    // The shared noise primitive returns [-1, 1]; remap to [0, 1] to compare against progress.
    const noiseValue = fn.add(
      fn.mul(fn.call("noise", fn.mul(target.read("p_uv"), inputs["scale"])), fn.lit(0.5)),
      fn.lit(0.5),
    );
    // max(edge, 1e-4) keeps the smoothstep span non-zero (edge has min 0), so a zero edge is a
    // hard cut rather than undefined GLSL / a NaN alpha.
    const edgeSpan = fn.call("max", inputs["edge"], fn.lit(1e-4));
    const mask = fn.call("smoothstep", progress, fn.add(progress, edgeSpan), noiseValue);
    return {
      color: fn.construct(
        VEC4,
        fn.swizzle(inputs["color"], "xyz"),
        fn.mul(fn.swizzle(inputs["color"], "w"), mask),
      ),
    };
  },
});

/**
 * Fades over `distance` world units in front of the opaque scene: 0 where the fragment touches it,
 * 1 from `distance` away - soft particles times alpha, an intersection glow as one minus it. The
 * runtime defines `fxDepthFade` from the depth of whichever camera draws, and gives 1 (a hard
 * edge) where that camera has none. Reading depth, a graph with it renders only in `blending`.
 */
export const fxDepthFade = defineNode({
  type: "depth-fade",
  domain: "render",
  stage: "fragment",
  category: "mask",
  inputs: {
    distance: { type: "float", value: 0.5, min: 0, max: 10, step: 0.05 },
  },
  outputs: { fade: { type: "float" } },
  params: {},
  // One depth fetch, two window-depth decodes (~5 each), the gap, the divide and the clamp.
  cost: 16,
  readsSceneDepth: true,
  build: ({ inputs, fn }) => ({
    fade: fn.raw(FLOAT, "glsl", "fxDepthFade($0)", inputs["distance"]),
  }),
});

/** Fades a color's contribution by its own brightness (dark pixels drop out). */
export const fxLightnessBlendingMask = defineNode({
  type: "lightness-blending-mask",
  domain: "render",
  stage: "fragment",
  category: "mask",
  inputs: {
    color: { type: "vec4", required: true, value: [1, 1, 1, 1], color: true },
    edge0: { type: "float", value: 0.3, min: 0, max: 2, step: 0.01 },
    edge1: { type: "float", value: 0.7, min: 0, max: 2, step: 0.01 },
  },
  outputs: { color: { type: "vec4" } },
  params: {},
  // A luminance dot(vec3, 2*3-1=5) + the edge1 guard (add+max=2) + smoothstep (3 flat guard + 8
  // per component, scalar = 11) + a vec4 multiply(4) = 22.
  cost: 22,
  build: ({ inputs, emitHelper, fn }) => {
    emitHelper("FX_GLSL_LIGHTNESS_BLENDING_MASK");
    const mask = fn.pureRaw(
      FLOAT,
      "glsl",
      "fxLightnessBlendingMask($0, $1, $2)",
      inputs["color"],
      inputs["edge0"],
      inputs["edge1"],
    );
    return { color: fn.mul(inputs["color"], mask) };
  },
});

/** Emits the shared surface-frame helper and rotates a tangent-space normal into world. */
function tangentToWorldNormal(
  tangentNormal: FXExpr,
  target: { read: (name: string) => FXExpr },
  emitHelper: (helper: FXGLSLHelperName) => void,
  fn: FXExprBuilderApi,
): FXExpr {
  emitHelper("FX_GLSL_TANGENT_TO_WORLD_NORMAL");
  return fn.pureRaw(
    VEC3,
    "glsl",
    "fxTangentToWorldNormal($0, $1, $2)",
    tangentNormal,
    target.read("geometryNormal"),
    target.read("geometryTangent"),
  );
}

/** The particle's world-space surface normal (the `geometryNormal` builtin) - the runtime always
 *  computes it, and it's the base of the surface frame every tangent-space normal rotates through. */
export const fxSurfaceNormal = defineNode({
  type: "surface-normal",
  domain: "render",
  stage: "fragment",
  category: "normal",
  inputs: {},
  outputs: { normal: { type: "vec3" } },
  params: {},
  cost: 0,
  reads: ["geometryNormal"],
  build: ({ target }) => ({ normal: target.read("geometryNormal") }),
});

/** Derives a rounded (spherical) surface normal from the billboard UV, in tangent space rotated to
 *  world through the shared surface frame - correct even when the billboard has roll. */
export const fxSphericalNormal = defineNode({
  type: "spherical-normal",
  domain: "render",
  stage: "fragment",
  category: "normal",
  inputs: {},
  outputs: { normal: { type: "vec3" } },
  params: {},
  // The UV->tangent-normal reconstruction (centeredUV(4) + dot(vec2,3) + sub+max(2) + sqrt(2) +
  // normalize(vec3,15) = 26) + rotating it into world through the shared surface frame (two vec3
  // normalizes(15 each) + a dot(5) + a scale+subtract(6) + a fixed cross product(9) + a mat3*vec3
  // transform(15) = 80 - see `tangentToWorldNormal`) = 106.
  cost: 106,
  reads: ["p_uv", "geometryNormal", "geometryTangent"],
  build: ({ target, emitHelper, fn }) => {
    emitHelper("FX_GLSL_SPHERICAL_NORMAL");
    const tangentNormal = fn.pureRaw(
      VEC3,
      "glsl",
      "fxComputeSphericalNormal($0)",
      target.read("p_uv"),
    );
    return { normal: tangentToWorldNormal(tangentNormal, target, emitHelper, fn) };
  },
});

/** Interprets a sampled color as a tangent-space normal map and rotates it into world space. Feed
 *  it a Texture node's color; `strength` scales the xy tilt (0 = flat). */
export const fxNormalMap = defineNode({
  type: "normal-map",
  domain: "render",
  stage: "fragment",
  category: "normal",
  inputs: {
    // Packed normal data (r,g,b -> tangent xyz), not a color to pick - the default is a flat
    // ("no bump") map: packed (0.5, 0.5, 1) unpacks to tangent (0, 0, 1).
    color: { type: "vec4", required: true, value: [0.5, 0.5, 1, 1] },
    strength: { type: "float", value: 1, min: 0, max: 4, step: 0.05 },
  },
  outputs: { normal: { type: "vec3" } },
  params: {},
  // Unpacking the sample (vec3 mul+sub(6) + a partial vec2 .xy scale(2) = 8) + rotating it into
  // world through the shared surface frame (80 - see `tangentToWorldNormal`, same cost as
  // `spherical-normal`'s) = 88.
  cost: 88,
  reads: ["geometryNormal", "geometryTangent"],
  build: ({ inputs, target, emitHelper, fn }) => {
    emitHelper("FX_GLSL_UNPACK_NORMAL");
    const tangentNormal = fn.pureRaw(
      VEC3,
      "glsl",
      "fxUnpackNormal($0, $1)",
      inputs["color"],
      inputs["strength"],
    );
    return { normal: tangentToWorldNormal(tangentNormal, target, emitHelper, fn) };
  },
});

/** All standard render effect node definitions. */
export const FX_RENDER_EFFECT_NODES: readonly FXNodeDefinition[] = [
  fxBlend,
  fxSphericalClip,
  fxDissolve,
  fxDepthFade,
  fxLightnessBlendingMask,
  fxSurfaceNormal,
  fxSphericalNormal,
  fxNormalMap,
];
