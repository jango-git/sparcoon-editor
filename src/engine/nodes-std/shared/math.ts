import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES } from "../../core/socket/FXValueType";
import { fxColorRamp, fxCombineColor, fxHslAdjust, fxSplitColor } from "./color";
import { fxRamp } from "./curveBake";
import { fxCurlNoise, fxNoise } from "./noise";

/**
 * Standard-library **type-polymorphic** math nodes, shared by the render and behavior backends.
 * One `mix`/`clamp`/`binary-op`/... node serves `float`/`vec2`/`vec3`/`vec4`: the socket type
 * variable `"T"` is unified per instance by `resolveGenerics`. Each is `domain: "shared"`.
 */

/** float / vec2 / vec3 / vec4 - the full numeric constraint (and the `constant` type menu). */
const NUMERIC = NUMERIC_VALUE_TYPES;
/** vec2 / vec3 / vec4 - for vector-only nodes (scale, split, combine, dot, length). */
const VECTORS: readonly FXGLSLTypeName[] = ["vec2", "vec3", "vec4"];

type FXBinaryOperation =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "min"
  | "max"
  | "power"
  | "modulo"
  | "atan2"
  | "step"
  | "cross";

type FXUnaryOperation =
  | "negate"
  | "abs"
  | "sign"
  | "floor"
  | "ceil"
  | "round"
  | "fract"
  | "sqrt"
  | "sin"
  | "cos"
  | "tan"
  | "asin"
  | "acos"
  | "atan"
  | "exp"
  | "log"
  | "one-minus"
  | "saturate"
  | "normalize";

const BINARY_OPERATIONS: readonly FXBinaryOperation[] = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "min",
  "max",
  "power",
  "modulo",
  "atan2",
  "step",
  "cross",
];

const UNARY_OPERATIONS: readonly FXUnaryOperation[] = [
  "negate",
  "abs",
  "sign",
  "floor",
  "ceil",
  "round",
  "fract",
  "sqrt",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "exp",
  "log",
  "one-minus",
  "saturate",
  "normalize",
];

const COMPONENTS = ["x", "y", "z", "w"] as const;

/**
 * Cost weights for the math nodes below, in a rough "one scalar float ALU op" unit - so a
 * `binary-op` "add" on a `vec3` costs 3. `cross` is a fixed 9, not per-component.
 */
const BINARY_OPERATION_COST_PER_COMPONENT: Readonly<Record<FXBinaryOperation, number>> = {
  add: 1,
  subtract: 1,
  multiply: 1,
  min: 1,
  max: 1,
  step: 1,
  divide: 2, // reciprocal + multiply
  modulo: 5, // x - y*floor(x/y): divide(2) + floor(1) + multiply(1) + subtract(1)
  power: 4, // transcendental (pow)
  atan2: 4, // transcendental; float-only, so "per component" is moot here
  cross: 0, // handled as CROSS_COST below instead - not per-component
};
const CROSS_COST = 9;

function binaryOperationCost(operation: string, resolvedT: FXValueType): number {
  return operation === "cross"
    ? CROSS_COST
    : BINARY_OPERATION_COST_PER_COMPONENT[operation as FXBinaryOperation] * resolvedT.components;
}

/** Cheap (~1 ALU op) vs. transcendental (~4) unary functions; `normalize` folds dot+sqrt+divide. */
const UNARY_OPERATION_COST_PER_COMPONENT: Readonly<Record<FXUnaryOperation, number>> = {
  negate: 1,
  abs: 1,
  sign: 1,
  floor: 1,
  ceil: 1,
  round: 1,
  fract: 1,
  "one-minus": 1,
  saturate: 1,
  sqrt: 2,
  sin: 4,
  cos: 4,
  tan: 4,
  asin: 4,
  acos: 4,
  atan: 4,
  exp: 4,
  log: 4,
  normalize: 5,
};

function binaryExpr(operation: string, a: FXExpr, b: FXExpr, fn: FXExprBuilderApi): FXExpr {
  switch (operation as FXBinaryOperation) {
    case "add":
      return fn.add(a, b);
    case "subtract":
      return fn.sub(a, b);
    case "multiply":
      return fn.mul(a, b);
    case "divide":
      return fn.div(a, b);
    case "min":
      return fn.call("min", a, b);
    case "max":
      return fn.call("max", a, b);
    case "power":
      return fn.call("pow", a, b);
    case "modulo":
      return fn.mod(a, b);
    case "atan2":
      return fn.call("atan2", a, b);
    // step(edge, x): `a` is the edge, `b` the value - returns b >= a ? 1 : 0.
    case "step":
      return fn.call("step", a, b);
    // vec3-only; fn.call rejects the other resolved T with its own ir-no-matching-overload error.
    case "cross":
      return fn.call("cross", a, b);
  }
}

function unaryExpr(operation: string, x: FXExpr, fn: FXExprBuilderApi): FXExpr {
  switch (operation as FXUnaryOperation) {
    case "negate":
      return fn.neg(x);
    case "abs":
    case "sign":
    case "floor":
    case "ceil":
    case "round":
    case "fract":
    case "sqrt":
    case "sin":
    case "cos":
    case "tan":
    case "asin":
    case "acos":
    case "atan":
    case "exp":
    case "log":
    case "normalize":
      return fn.call(operation, x);
    case "one-minus":
      return fn.call("oneMinus", x);
    case "saturate":
      return fn.call("saturate", x);
  }
}

/** Constant value of the node's type `T`, baked in as a compile-time literal. */
export const fxConstant = defineNode({
  type: "constant",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "source",
  generic: { constraint: NUMERIC },
  // A `constant` is a compile-time literal, NOT a uniform: it bakes into the code and spends
  // no slot (to drive a value at runtime, use a Timeline Value instead).
  inputs: { value: { type: "T", value: 0 } },
  outputs: { out: { type: "T" } },
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      // `color` is a UI alias for `vec4`: the engine resolves it to `vec4` (color == vec4),
      // the editor just edits it with a color picker instead of four raw fields.
      options: [...NUMERIC, "color"],
      default: "float",
    },
  },
  // A compile-time literal - bakes into the code, spends no ALU op at runtime.
  cost: 0,
  build: ({ inputs }) => ({ out: inputs["value"] }),
});

/**
 * Two-input, same-type operation, `out = op(a, b)`. `a`/`b` carry an editable inline default,
 * sized to whatever `T` the other (connected) input resolves - no `type` param pins it up front.
 */
export const fxBinaryOp = defineNode({
  type: "binary-op",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    a: { type: "T", required: true, value: 0 },
    b: { type: "T", required: true, value: 0 },
  },
  outputs: { out: { type: "T" } },
  params: {
    op: {
      kind: "structural",
      type: "enum",
      options: BINARY_OPERATIONS,
      default: "add",
    },
  },
  cost: ({ params, resolvedT }) => binaryOperationCost(params.op as string, resolvedT),
  build: ({ inputs, params, fn }) => ({ out: binaryExpr(params.op, inputs["a"], inputs["b"], fn) }),
});

/** `out = a + b * scale` - adds a value scaled by a factor (e.g. `position + velocity * dt`). */
export const fxAddScaledVector = defineNode({
  type: "add-scaled-vector",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    a: { type: "T", required: true, value: 0 },
    b: { type: "T", required: true, value: 0 },
    scale: { type: "float", value: 1 },
  },
  outputs: { out: { type: "T" } },
  params: {},
  // 1 multiply + 1 add per component (a fused multiply-add).
  cost: ({ resolvedT }) => 2 * resolvedT.components,
  build: ({ inputs, fn }) => ({ out: fn.add(inputs["a"], fn.mul(inputs["b"], inputs["scale"])) }),
});

/** Single-input, same-type function, `out = op(x)`. */
export const fxUnaryOp = defineNode({
  type: "unary-op",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: { x: { type: "T", required: true } },
  outputs: { out: { type: "T" } },
  params: {
    op: {
      kind: "structural",
      type: "enum",
      options: UNARY_OPERATIONS,
      default: "abs",
    },
  },
  cost: ({ params, resolvedT }) =>
    UNARY_OPERATION_COST_PER_COMPONENT[params.op as FXUnaryOperation] * resolvedT.components,
  build: ({ inputs, params, fn }) => ({ out: unaryExpr(params.op, inputs["x"], fn) }),
});

/** `out = clamp(x, lo, hi)`; lo/hi are scalars, default 0/1 (a bare node saturates). */
export const fxClamp = defineNode({
  type: "clamp",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    x: { type: "T", required: true },
    lo: { type: "float", value: 0 },
    hi: { type: "float", value: 1 },
  },
  outputs: { out: { type: "T" } },
  params: {},
  // A min + a max per component.
  cost: ({ resolvedT }) => 2 * resolvedT.components,
  build: ({ inputs, fn }) => ({ out: fn.call("clamp", inputs["x"], inputs["lo"], inputs["hi"]) }),
});

/**
 * Linear interpolation, `out = mix(a, b, t)`; scalar `t` defaults to 0.5. Like `binary-op`,
 * `a`/`b` also carry an inline pin value sized to whichever side is actually connected.
 */
export const fxMix = defineNode({
  type: "mix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    a: { type: "T", required: true, value: 0 },
    b: { type: "T", required: true, value: 0 },
    t: { type: "float", value: 0.5 },
  },
  outputs: { out: { type: "T" } },
  params: {},
  // a + t*(b - a): a subtract + a multiply + an add per component.
  cost: ({ resolvedT }) => 3 * resolvedT.components,
  build: ({ inputs, fn }) => ({ out: fn.call("mix", inputs["a"], inputs["b"], inputs["t"]) }),
});

/** GLSL `smoothstep(edge0, edge1, x)`; scalar edges default to 0/1. */
export const fxSmoothstep = defineNode({
  type: "smoothstep",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    edge0: { type: "float", value: 0 },
    edge1: { type: "float", value: 1 },
    x: { type: "T", required: true },
  },
  outputs: { out: { type: "T" } },
  params: {},
  // ~3 flat for the edge guard/degenerate check, plus the Hermite polynomial (clamp(2) + a
  // few multiplies/subtracts, ~8) per component.
  cost: ({ resolvedT }) => 3 + 8 * resolvedT.components,
  build: ({ inputs, fn }) => {
    // Guard degenerate edges (edge0 == edge1): smoothstep is undefined/NaN there. Nudge edge1
    // by an epsilon so the span is non-zero (a hard step).
    const edge0 = inputs["edge0"];
    const edge1 = inputs["edge1"];
    const guardedEdge1 = fn.select(fn.eq(edge1, edge0), fn.add(edge0, fn.lit(1e-6)), edge1);
    return { out: fn.call("smoothstep", edge0, guardedEdge1, inputs["x"]) };
  },
});

/** Linear remap between scalar ranges; bounds default to [0,1] -> [0,1] (input not clamped). */
export const fxRemap = defineNode({
  type: "remap",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: NUMERIC },
  inputs: {
    x: { type: "T", required: true },
    inMin: { type: "float", value: 0 },
    inMax: { type: "float", value: 1 },
    outMin: { type: "float", value: 0 },
    outMax: { type: "float", value: 1 },
  },
  outputs: { out: { type: "T" } },
  params: {},
  // 4 flat: span subtract(1) + guard eq(1) + select(1) + (outMax-outMin) subtract(1). Then per
  // component: subtract(1) + divide(2) + multiply(1) + add(1) = 5.
  cost: ({ resolvedT }) => 4 + 5 * resolvedT.components,
  build: ({ inputs, fn }) => {
    // Guard the denominator so a degenerate input range (inMax == inMin) can't divide by zero;
    // the epsilon makes the output a ~1e6-scaled ramp instead, but it stays finite.
    const span = fn.sub(inputs["inMax"], inputs["inMin"]);
    const denom = fn.select(fn.eq(span, fn.lit(0)), fn.lit(1e-6), span);
    const t = fn.div(fn.sub(inputs["x"], inputs["inMin"]), denom);
    return { out: fn.add(inputs["outMin"], fn.mul(t, fn.sub(inputs["outMax"], inputs["outMin"]))) };
  },
});

/** Splits a vector into its float components (`x`, `y`, `z`, `w` up to its width). */
export const fxSplit = defineNode({
  type: "split",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: VECTORS },
  inputs: { v: { type: "T", required: true } },
  outputs: {
    x: { type: "float" },
    y: { type: "float" },
    z: { type: "float" },
    w: { type: "float" },
  },
  params: {},
  // A swizzle is a re-index, not arithmetic.
  cost: 0,
  build: ({ inputs, resolvedT, fn }) => {
    const output: Record<string, FXExpr> = {};
    for (const component of COMPONENTS.slice(0, resolvedT.components)) {
      output[component] = fn.swizzle(inputs["v"], component);
    }
    return output;
  },
});

/** Assembles float components into a vector (`vecN(x, y, ...)`); the width is `type`. */
export const fxCombine = defineNode({
  type: "combine",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: VECTORS },
  inputs: {
    x: { type: "float", value: 0 },
    y: { type: "float", value: 0 },
    z: { type: "float", value: 0 },
    w: { type: "float", value: 1 },
  },
  outputs: { out: { type: "T" } },
  params: {
    type: {
      kind: "structural",
      type: "valueType",
      options: VECTORS,
      default: "vec3",
    },
  },
  // `construct` assembles a vector from parts - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, resolvedT, fn }) => {
    const parts: FXExpr[] = [];
    for (const component of COMPONENTS.slice(0, resolvedT.components)) {
      parts.push(inputs[component]);
    }
    return { out: fn.construct(resolvedT, ...parts) };
  },
});

/**
 * `out = dot(a, b)` - the scalar dot product of two same-typed vectors. `a`/`b` carry an
 * inline pin value like `binary-op`'s, sized to whichever side is connected.
 */
export const fxDot = defineNode({
  type: "dot",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: VECTORS },
  inputs: {
    a: { type: "T", required: true, value: 0 },
    b: { type: "T", required: true, value: 0 },
  },
  outputs: { out: { type: "float" } },
  params: {},
  // N multiplies + (N - 1) adds.
  cost: ({ resolvedT }) => 2 * resolvedT.components - 1,
  build: ({ inputs, fn }) => ({ out: fn.call("dot", inputs["a"], inputs["b"]) }),
});

/** `out = length(v)` - the Euclidean length of a vector as a float. */
export const fxLength = defineNode({
  type: "length",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "math",
  generic: { constraint: VECTORS },
  inputs: { v: { type: "T", required: true } },
  outputs: { out: { type: "float" } },
  params: {},
  // dot(v, v) - see `fxDot` - plus a sqrt.
  cost: ({ resolvedT }) => 2 * resolvedT.components + 1,
  build: ({ inputs, fn }) => ({ out: fn.call("length", inputs["v"]) }),
});

/** All type-polymorphic shared math node definitions. */
export const FX_SHARED_MATH_NODES: readonly FXNodeDefinition[] = [
  fxConstant,
  fxBinaryOp,
  fxAddScaledVector,
  fxUnaryOp,
  fxClamp,
  fxMix,
  fxSmoothstep,
  fxRemap,
  fxSplit,
  fxCombine,
  fxDot,
  fxLength,
  fxColorRamp,
  fxRamp,
  fxCombineColor,
  fxSplitColor,
  fxHslAdjust,
  fxNoise,
  fxCurlNoise,
];
