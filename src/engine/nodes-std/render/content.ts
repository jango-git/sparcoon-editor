import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Standard-library render content nodes (fixed-socket, fragment): UV transforms and a rim/edge
 * factor. Heavy GLSL with no IR form (the `mat2` rotation, the flipbook frame math) stays `raw`.
 */

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
const VEC3 = FX_VALUE_TYPES.vec3;

/** Rotates UVs about their center (0.5, 0.5) by a live angle (radians). */
export const fxRotateUV = defineNode({
  type: "rotate-uv",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    angle: { type: "float", value: 0, step: 0.05 },
  },
  outputs: { uv: { type: "vec2" } },
  params: {},
  // 4 trig calls (~16) + the mat2*vec2 rotation (~6) + the center offset (2 vec2 ops, ~4).
  cost: 26,
  build: ({ inputs, fn }) => ({
    // mat2(cos, sin, -sin, cos) is column-major for [[cos,-sin],[sin,cos]]; the mat2
    // constructor has no IR form, so it stays a raw GLSL expression.
    uv: fn.raw(
      VEC2,
      "glsl",
      "(mat2(cos($0), sin($0), -sin($0), cos($0)) * ($1 - 0.5) + 0.5)",
      inputs["angle"],
      inputs["uv"],
    ),
  }),
});

/** Tiles/offsets UVs, `uv = uv * tiles + offset`. */
export const fxTileUV = defineNode({
  type: "tile-uv",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    tiles: { type: "vec2", value: [2, 2] },
    offset: { type: "vec2", value: [0, 0] },
  },
  outputs: { uv: { type: "vec2" } },
  params: {},
  // A vec2 multiply + a vec2 add.
  cost: 4,
  build: ({ inputs, fn }) => ({
    uv: fn.add(fn.mul(inputs["uv"], inputs["tiles"]), inputs["offset"]),
  }),
});

/**
 * Sprite-sheet flipbook sampler with inter-frame blending: maps `lifetimeRatio` to the `previous`/
 * `current` frame UVs straddling the playhead plus a cross-fade `factor`. Any float is accepted -
 * `fract`-wrapped to loop the sheet, with `current` wrapping past the last cell to the first so the
 * fade stays continuous across the seam.
 */
export const fxAnimatedTexture = defineNode({
  type: "animated-texture",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    lifetimeRatio: { type: "float", value: 0, step: 0.01 },
    columns: { type: "float", value: 1, min: 1, max: 64, step: 1 },
    rows: { type: "float", value: 1, min: 1, max: 64, step: 1 },
  },
  outputs: {
    uvPrevious: { type: "vec2" },
    uvCurrent: { type: "vec2" },
    factor: { type: "float" },
  },
  params: {},
  // fxAnimatedFrameInfo (fract+mul(2) + floor(1) + mod-based wrap(add+mod=6) + subtract(1) = 10)
  // + the columns*rows multiply (1) + two fxFlipbookFrameUV calls (mod(5) + div+floor(3) + two
  // div-heavy components (3+5) = 16 each, so 32) = 43.
  cost: 43,
  build: ({ inputs, emitHelper, local, fn }) => {
    emitHelper(
      "animated-texture-frame",
      // previous = the cell the playhead sits on; current = next cell, wrapped mod totalFrames;
      // factor = distance between the two (see the node's doc comment for the loop-seam rationale).
      `vec3 fxAnimatedFrameInfo(float ratio, float totalFrames) {
        float framePos = fract(ratio) * totalFrames;
        float previous = floor(framePos);
        float current = mod(previous + 1.0, totalFrames);
        return vec3(previous, current, framePos - previous);
      }`,
    );
    emitHelper(
      "animated-texture-uv",
      `vec2 fxFlipbookFrameUV(vec2 uv, float frame, float columns, float rows) {
        float column = mod(frame, columns);
        float row = floor(frame / columns);
        return vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
      }`,
    );
    const frameInfo = local(
      "at_frame",
      fn.raw(
        VEC3,
        "glsl",
        "fxAnimatedFrameInfo($0, $1)",
        inputs["lifetimeRatio"],
        fn.mul(inputs["columns"], inputs["rows"]),
      ),
    );
    // frameInfo is $0: its .x (previous) / .y (current) channel feeds the frame index.
    const frameUV = (channel: "x" | "y"): FXExpr =>
      fn.raw(
        VEC2,
        "glsl",
        `fxFlipbookFrameUV($1, $0.${channel}, $2, $3)`,
        frameInfo,
        inputs["uv"],
        inputs["columns"],
        inputs["rows"],
      );
    return {
      uvPrevious: frameUV("x"),
      uvCurrent: frameUV("y"),
      factor: fn.raw(FLOAT, "glsl", "$0.z", frameInfo),
    };
  },
});

/** Camera-correct rim/edge factor, `pow(1 - saturate(dot(N, V)), power)`, with V the world-space
 *  view direction. Works for any camera since normals are world-space. */
export const fxFresnel = defineNode({
  type: "fresnel",
  domain: "render",
  stage: "fragment",
  category: "mask",
  inputs: {
    // [0,0,1] matches transform-direction's default: a "facing forward" placeholder normal.
    normal: { type: "vec3", required: true, value: [0, 0, 1] },
    power: { type: "float", value: 3, min: 0, max: 16, step: 0.1 },
  },
  outputs: { out: { type: "float" } },
  params: {},
  // sub(3) + 2 vec3 normalizes (5 per component = 15 each) + dot(5) + saturate(1) + sub(1) +
  // pow(4) = 44.
  cost: 44,
  reads: ["cameraPosition", "worldPosition"],
  build: ({ inputs, target, local, fn }) => {
    const viewDirection = local(
      "fr_v",
      fn.call("normalize", fn.sub(target.read("cameraPosition"), target.read("worldPosition"))),
    );
    const facing = fn.call(
      "saturate",
      fn.call("dot", fn.call("normalize", inputs["normal"]), viewDirection),
    );
    const rim = fn.sub(fn.lit(1), facing);
    return { out: fn.call("pow", rim, inputs["power"]) };
  },
});

/** All standard render content node definitions. */
export const FX_RENDER_CONTENT_NODES: readonly FXNodeDefinition[] = [
  fxRotateUV,
  fxTileUV,
  fxAnimatedTexture,
  fxFresnel,
];
