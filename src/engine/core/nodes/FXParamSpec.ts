import type { FXGLSLTypeName } from "../socket/FXValueType";

/**
 * Serializable 1D animation curve, free of `three` types - the persisted counterpart of
 * runtime `FXCurve1DConfig`. Positions normalize into `[0, 1]`; ordering not required
 * (the sampler sorts).
 */
export interface FXCurveData {
  readonly points: readonly {
    readonly position: number;
    readonly value: number;
    /**
     * `"smooth"` = Catmull-Rom tangent, `"sharp"` = corner (linear on both sides). Absent
     * = smooth. Only the inline curve param honors this - a LUT-baked curve samples linearly.
     */
    readonly interpolation?: "smooth" | "sharp";
  }[];
}

/** One gradient stop: a normalized position and its linear RGBA color. */
export interface FXGradientStop {
  readonly position: number;
  /** Linear, each channel in `[0, 1]` - sRGB/hex is an editor authoring concern. */
  readonly color: readonly [number, number, number, number];
}

/**
 * Serializable color gradient, the color counterpart of {@link FXCurveData}. Unlike a curve
 * (a live LUT binding), a gradient bakes inline as a piecewise-linear `mix` chain, so it
 * participates in the structural hash and editing it recompiles.
 */
export interface FXGradientData {
  /** Ordering not required - the builder sorts by position. */
  readonly stops: readonly FXGradientStop[];
}

/** Default identity curve (0 => 1, both anchors smooth) used when a curve node is first created. */
export const DEFAULT_CURVE: FXCurveData = {
  points: [
    { position: 0, value: 0, interpolation: "smooth" },
    { position: 1, value: 1, interpolation: "smooth" },
  ],
};

/** Default black=>white ramp used when a color-ramp node is first created. */
export const DEFAULT_GRADIENT: FXGradientData = {
  stops: [
    { position: 0, color: [0, 0, 0, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ],
};

/**
 * Declarative description of a node parameter, consumed by {@link defineNode}. `value` is
 * live-tunable (uniform/binding rebind, no recompile); `structural` changes code shape and
 * participates in `cacheKey` (recompile). Texture params are absent - those nodes carry
 * `three` resources and stay hand-written.
 */
export type FXParamSpec =
  | FXFloatParamSpec
  | FXVectorParamSpec
  | FXGenericValueParamSpec
  | FXInlineCurveParamSpec
  | FXGradientParamSpec
  | FXEnumParamSpec
  | FXFlagParamSpec
  | FXValueTypeParamSpec;

/** A single live-tunable float, optionally clamped to `[min, max]`. */
export interface FXFloatParamSpec {
  readonly kind: "value";
  readonly type: "float";
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  /** Editor hint: increment per chevron click / value change per pixel of scrub. */
  readonly step?: number;
}

/** A live-tunable fixed-length vector. `default.length` fixes the component count. */
export interface FXVectorParamSpec {
  readonly kind: "value";
  readonly type: "vec2" | "vec3" | "vec4";
  readonly default: readonly number[];
  /** Editor hint: per-component lower bound applied to every field (e.g. `0` for a color). */
  readonly min?: number;
  /** Editor hint: per-component upper bound applied to every field (e.g. `1` for a color). */
  readonly max?: number;
  /** Editor hint: per-component increment/scrub step applied to every field. */
  readonly step?: number;
}

/**
 * A live-tunable value whose width follows the node's generic type `T` (sized by its
 * structural `valueType` param). `default` seeds the starting form; it reshapes to the
 * current width when the type param changes.
 */
export interface FXGenericValueParamSpec {
  readonly kind: "value";
  readonly type: "generic";
  readonly default: number | readonly number[];
}

/**
 * A scalar animation curve baked inline into the node's code (a piecewise-linear `mix`
 * chain over pre-sampled points, so it works in both backends) - the float counterpart of
 * {@link FXGradientParamSpec}. `structural`: participates in {@link cacheKey} and recompiles.
 */
export interface FXInlineCurveParamSpec {
  readonly kind: "structural";
  readonly type: "curve";
  readonly default: FXCurveData;
}

/**
 * A color gradient baked inline into the node's code (a piecewise `mix` chain). `structural`:
 * participates in {@link cacheKey} and editing it recompiles.
 */
export interface FXGradientParamSpec {
  readonly kind: "structural";
  readonly type: "gradient";
  readonly default: FXGradientData;
}

/** A structural choice from a fixed set of string options. */
export interface FXEnumParamSpec {
  readonly kind: "structural";
  readonly type: "enum";
  readonly options: readonly string[];
  readonly default: string;
}

/** A structural boolean flag. */
export interface FXFlagParamSpec {
  readonly kind: "structural";
  readonly type: "flag";
  readonly default: boolean;
}

/**
 * A structural GLSL-type choice (drives generic-node code shape) - a concrete GLSL type, or
 * the UI-only `"color"` alias, which resolves to `vec4` (color == vec4) so a color-picker
 * `vec4` can be offered distinct from a raw four-field one.
 */
export interface FXValueTypeParamSpec {
  readonly kind: "structural";
  readonly type: "valueType";
  readonly options: readonly (FXGLSLTypeName | "color")[];
  readonly default: FXGLSLTypeName | "color";
}
