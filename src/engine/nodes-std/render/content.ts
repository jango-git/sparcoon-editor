import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
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
    uv: fn.pureRaw(
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
 * Flow-map UV drift: moves a texture's content along `flow` (a UV-space direction per fragment - a
 * decoded flow texture, a noise field, a formula such as a swirl's tangent) without the endless
 * stretch of a plain scroll. Two phases half a cycle apart each drift up to `strength` along the
 * flow, `speed` cycles a second, and snap back; `blend` is `uvB`'s weight, 1 exactly when `uvA`
 * snaps and 0 when `uvB` does, so a snap is never seen. Sample one texture at `uvA` and at `uvB`
 * and mix the two by `blend`. `time` is the scene clock unless wired (a particle's age, say).
 */
export const fxFlowUV = defineNode({
  type: "flow-uv",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    flow: { type: "vec2", value: [1, 0] },
    time: { type: "float", default: { targetInput: "u_time" } },
    speed: { type: "float", value: 1, step: 0.05 },
    strength: { type: "float", value: 0.25, step: 0.01 },
  },
  outputs: {
    uvA: { type: "vec2" },
    uvB: { type: "vec2" },
    blend: { type: "float" },
  },
  params: {},
  // Both phases (mul + fract, add + fract: 4) + two drifted UVs (float mul + vec2 mul + vec2 sub:
  // 5 each, 10) + the blend weight (mul + sub + abs: 3).
  cost: 17,
  build: ({ inputs, local, fn }) => {
    const phaseA = local("fl_phase", fn.call("fract", fn.mul(inputs["time"], inputs["speed"])));
    const phaseB = fn.call("fract", fn.add(phaseA, fn.lit(0.5)));
    const drift = (phase: FXExpr): FXExpr =>
      fn.sub(inputs["uv"], fn.mul(inputs["flow"], fn.mul(phase, inputs["strength"])));
    return {
      uvA: drift(phaseA),
      uvB: drift(phaseB),
      blend: fn.call("abs", fn.sub(fn.lit(1), fn.mul(fn.lit(2), phaseA))),
    };
  },
});

/**
 * Polar UVs about `center`: `uv.x = atan2(d.y, d.x) / 2π + 0.5` (angle, 0..1 counterclockwise from
 * the -x seam), `uv.y = 2 * length(d)` (radius, 1 at the quad's edge), with `d = uv - center`.
 */
export const fxPolarUV = defineNode({
  type: "polar-uv",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    center: { type: "vec2", value: [0.5, 0.5] },
  },
  outputs: { uv: { type: "vec2" } },
  params: {},
  // The offset (2) + atan2 (4) + the angle's div + add (2) + length (5) + the radius' mul (1).
  cost: 14,
  build: ({ inputs, local, fn }) => {
    const offset = local("pl_d", fn.sub(inputs["uv"], inputs["center"]));
    const angle = fn.call("atan2", fn.swizzle(offset, "y"), fn.swizzle(offset, "x"));
    return {
      uv: fn.construct(
        VEC2,
        fn.add(fn.div(angle, fn.lit(2 * Math.PI)), fn.lit(0.5)),
        fn.mul(fn.call("length", offset), fn.lit(2)),
      ),
    };
  },
});

/**
 * How {@link fxAnimatedTexture} reads its ratio: once through by default - [0, 1] plays the sheet
 * first cell to last and holds the last (what a lifetime ratio means: a particle ends on its last
 * frame, never fading back into the first). `loop` instead `fract`-wraps any float to cycle the
 * sheet, with `current` wrapping past the last cell to the first so the fade stays continuous
 * across the seam.
 */
const FLIPBOOK_LOOP_PARAM = {
  kind: "structural",
  type: "flag",
  default: false,
} as const satisfies FXParamSpec;

// frame = the cell the playhead sits on; next = the cell after it; factor = how far between.
const FLIPBOOK_FRAME_ONCE = `vec3 fxAnimatedFrameOnce(float ratio, float totalFrames) {
  float framePos = clamp(ratio, 0.0, 1.0) * totalFrames;
  float last = totalFrames - 1.0;
  float frame = min(floor(framePos), last);
  return vec3(frame, min(frame + 1.0, last), framePos - frame);
}`;
const FLIPBOOK_FRAME_LOOP = `vec3 fxAnimatedFrameLoop(float ratio, float totalFrames) {
  float framePos = fract(ratio) * totalFrames;
  float frame = floor(framePos);
  return vec3(frame, mod(frame + 1.0, totalFrames), framePos - frame);
}`;

/**
 * The UV of cell `frame` (a whole number) of a `columns` x `rows` sheet, cells left to right, top
 * to bottom. The column is taken off the row rather than by `mod`: `mod(8.0, 8.0)` may come out
 * 7.99..., which would read the cell's right neighbour - a whole frame off.
 */
const FLIPBOOK_FRAME_UV = `vec2 fxFlipbookFrameUV(vec2 uv, float frame, float columns, float rows) {
  float row = floor((frame + 0.5) / columns);
  float column = frame - row * columns;
  return vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
}`;

/** The sheet's frame count: `frames` when set (above 0), else every cell of the grid. */
function sheetFrames(fn: FXExprBuilderApi, frames: FXExpr, columns: FXExpr, rows: FXExpr): FXExpr {
  return fn.pureRaw(FLOAT, "glsl", "($0 > 0.5 ? floor($0 + 0.5) : $1 * $2)", frames, columns, rows);
}

/** The `frames` input both flipbook nodes share: how many cells the sheet uses, 0 = all of them. */
const FRAMES_INPUT = { type: "float", value: 0, min: 0, max: 4096, step: 1 } as const;

/**
 * Sprite-sheet flipbook sampler with inter-frame blending: maps `lifetimeRatio` over the sheet's
 * `frames` (every cell when 0) to the UV of the frame the playhead is on (`uvFrame`), of the one
 * after it (`uvNext`), and how far between (`factor`) - once through or looping (see
 * {@link FLIPBOOK_LOOP_PARAM}). Mix `uvFrame`'s sample to `uvNext`'s by `factor` to cross-fade.
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
    frames: FRAMES_INPUT,
  },
  outputs: {
    uvFrame: { type: "vec2" },
    uvNext: { type: "vec2" },
    factor: { type: "float" },
  },
  params: { loop: FLIPBOOK_LOOP_PARAM },
  // Frame info (once: clamp+mul(2) + floor(1) + sub(1) + two min(2) + add(1) + sub(1) = 8; loop:
  // fract+mul(2) + floor(1) + mod-based wrap(add+mod=6) + subtract(1) = 10) + the frame count
  // (compare + select + floor/add or multiply, 3) + two fxFlipbookFrameUV calls (row: add + div +
  // floor (4), column: mul + sub (2), two div-heavy components (3+5) = 14 each, so 28).
  cost: ({ params }) => (params.loop === true ? 10 : 8) + 3 + 28,
  build: ({ inputs, params, emitHelper, local, fn }) => {
    const frameFunction = params.loop ? "fxAnimatedFrameLoop" : "fxAnimatedFrameOnce";
    emitHelper(
      `animated-texture-${frameFunction}`,
      params.loop ? FLIPBOOK_FRAME_LOOP : FLIPBOOK_FRAME_ONCE,
    );
    emitHelper("animated-texture-uv", FLIPBOOK_FRAME_UV);
    const frameInfo = local(
      "at_frame",
      fn.pureRaw(
        VEC3,
        "glsl",
        `${frameFunction}($0, $1)`,
        inputs["lifetimeRatio"],
        sheetFrames(fn, inputs["frames"], inputs["columns"], inputs["rows"]),
      ),
    );
    // frameInfo is $0: its .x (this frame) / .y (the next) channel feeds the frame index.
    const frameUV = (channel: "x" | "y"): FXExpr =>
      fn.pureRaw(
        VEC2,
        "glsl",
        `fxFlipbookFrameUV($1, $0.${channel}, $2, $3)`,
        frameInfo,
        inputs["uv"],
        inputs["columns"],
        inputs["rows"],
      );
    return {
      uvFrame: frameUV("x"),
      uvNext: frameUV("y"),
      factor: fn.pureRaw(FLOAT, "glsl", "$0.z", frameInfo),
    };
  },
});

/**
 * One cell of a sprite sheet by its number: `frame` (any float: rounded down, then wrapped round
 * the sheet's `frames`, every cell when 0) to that cell's UV - no cross-fade, so a frame never
 * smears into its neighbour. For picking frames by hand: a random one per particle, one stepped at
 * a rate of its own, one per state.
 */
export const fxFlipbookFrame = defineNode({
  type: "flipbook-frame",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {
    uv: { type: "vec2", default: { targetInput: "p_uv" } },
    frame: { type: "float", value: 0, step: 1 },
    columns: { type: "float", value: 1, min: 1, max: 64, step: 1 },
    rows: { type: "float", value: 1, min: 1, max: 64, step: 1 },
    frames: FRAMES_INPUT,
  },
  outputs: { uv: { type: "vec2" } },
  params: {},
  // The frame count (3) + floor + the wrap (floor, add, div, floor, mul, sub: 7) + one
  // fxFlipbookFrameUV call (14).
  cost: 3 + 8 + 14,
  build: ({ inputs, emitHelper, local, fn }) => {
    emitHelper("animated-texture-uv", FLIPBOOK_FRAME_UV);
    const total = local(
      "fb_frames",
      sheetFrames(fn, inputs["frames"], inputs["columns"], inputs["rows"]),
    );
    // Wrapped as the column is (see FLIPBOOK_FRAME_UV), not by `mod`, which may land on `total`
    const cell = fn.pureRaw(
      FLOAT,
      "glsl",
      "(floor($0) - $1 * floor((floor($0) + 0.5) / $1))",
      inputs["frame"],
      total,
    );
    return {
      uv: fn.pureRaw(
        VEC2,
        "glsl",
        "fxFlipbookFrameUV($0, $1, $2, $3)",
        inputs["uv"],
        cell,
        inputs["columns"],
        inputs["rows"],
      ),
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
  fxFlowUV,
  fxPolarUV,
  fxAnimatedTexture,
  fxFlipbookFrame,
  fxFresnel,
];
