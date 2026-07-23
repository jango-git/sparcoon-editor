import type { FXBinOp, FXExpr, FXRefKind, FXUnOp } from "./FXExpr";
import type { FXGLSLTypeName, FXValueType } from "../socket/FXValueType";
import {
  FX_VALUE_TYPES,
  isIntType,
  isMatrixType,
  matrixDimension,
  resolveValueType,
} from "../socket/FXValueType";
import type { FXCompilerError, FXCompilerErrorCode } from "../compiler/FXCompilerError";
import { FXCompilerErrorException } from "../compiler/FXCompilerError";

/**
 * Typed constructors for {@link FXExpr} - the only sanctioned way to build the IR. Each
 * builder validates operand types and throws on mismatch; printers trust the tree as-is.
 */

/** Thrown by every builder on a type error, tagged with a code + params for the i18n resolver. */
function fail(
  code: FXCompilerErrorCode,
  message: string,
  params?: FXCompilerError["params"],
): never {
  throw new FXCompilerErrorException({
    code,
    message: `sparcoon IR: ${message}`,
    ...(params !== undefined ? { params } : {}),
  });
}

function isFloat(type: FXValueType): boolean {
  return type.id === "float";
}

/**
 * float/vec2/vec3/vec4 - matrices are excluded even though `mat2` shares `vec4`'s component
 * count (4): a matrix is never swizzled or splatted, it uses the dedicated matrix rules below.
 * `ivecN` is excluded the same way (`ivec2` also has 2 components) so it never qualifies for
 * swizzle/construct/float-splat here - int values are cast explicitly (`toInt`/`toFloat`), never
 * implicitly reshaped alongside float/vecN.
 */
function isVector(type: FXValueType): boolean {
  return !isMatrixType(type) && !isIntType(type) && type.components >= 2 && type.components <= 4;
}

/**
 * float/vecN, OR int/ivecN. `arithmeticResultType`'s only path an int/ivecN type can reach is
 * the `a.id === b.id` branch below (same-family arithmetic, valid GLSL in both the baseline and
 * standard tiers for `+`/`-`/`*`) - `isFloat`/`isVector` still only ever recognize the float
 * family, so the
 * float<->int splat branches can never fire for a mismatched pair; int<->float stays rejected.
 */
function isScalarOrVector(type: FXValueType): boolean {
  return isFloat(type) || isVector(type) || isIntType(type);
}

const COMPARISON_OPS: ReadonlySet<FXBinOp> = new Set<FXBinOp>(["lt", "le", "gt", "ge", "eq"]);
/** Ops for which a left-hand scalar may splat against a right-hand vector. */
const LEFT_SPLAT_OPS: ReadonlySet<FXBinOp> = new Set<FXBinOp>(["add", "mul"]);

/**
 * Result type for a matrix arithmetic op (column-major, mirrors GLSL - see the inline
 * comments below). JS backend scalarizes `mul` via `scalarizeMatrixMul`; add/sub/div pass through as-is.
 */
function matrixArithmeticResultType(op: FXBinOp, a: FXValueType, b: FXValueType): FXValueType {
  const aMatrix = isMatrixType(a);
  const bMatrix = isMatrixType(b);
  if (op === "mul") {
    if (aMatrix && bMatrix) {
      if (a.id !== b.id) {
        fail(
          "ir-matrix-mul-dimension-mismatch",
          `mul of matrices needs equal dimensions, got ${a.id} and ${b.id}`,
          { aType: a.id, bType: b.id },
        );
      }
      return a; // matN * matN -> matN
    }
    if (aMatrix && isFloat(b)) {
      return a;
    } // matN * float -> matN
    if (isFloat(a) && bMatrix) {
      return b;
    } // float * matN -> matN
    if (aMatrix && isVector(b)) {
      if (matrixDimension(a.components) !== b.components) {
        fail(
          "ir-matrix-vector-mul-width-mismatch",
          `mul ${a.id} * ${b.id}: matrix dimension must match the vector width`,
          { aType: a.id, bType: b.id },
        );
      }
      return b; // matN * vecN -> vecN
    }
    if (isVector(a) && bMatrix) {
      if (a.components !== matrixDimension(b.components)) {
        fail(
          "ir-vector-matrix-mul-width-mismatch",
          `mul ${a.id} * ${b.id}: vector width must match the matrix dimension`,
          { aType: a.id, bType: b.id },
        );
      }
      return a; // vecN * matN -> vecN
    }
    return fail("ir-matrix-mul-unsupported", `mul is not defined for ${a.id} and ${b.id}`, {
      aType: a.id,
      bType: b.id,
    });
  }
  if (op === "add" || op === "sub") {
    if (aMatrix && bMatrix && a.id === b.id) {
      return a; // matN +/- matN -> matN
    }
    return fail(
      "ir-matrix-add-sub-mismatch",
      `${op} of matrices needs two equal matrix types, got ${a.id} and ${b.id}`,
      { op, aType: a.id, bType: b.id },
    );
  }
  if (op === "div" && aMatrix && isFloat(b)) {
    return a; // matN / float -> matN
  }
  return fail("ir-matrix-op-unsupported", `${op} is not defined for ${a.id} and ${b.id}`, {
    op,
    aType: a.id,
    bType: b.id,
  });
}

function arithmeticResultType(op: FXBinOp, a: FXValueType, b: FXValueType): FXValueType {
  if (isMatrixType(a) || isMatrixType(b)) {
    return matrixArithmeticResultType(op, a, b);
  }
  if (!isScalarOrVector(a) || !isScalarOrVector(b)) {
    fail(
      "ir-arithmetic-bad-operand-type",
      `${op} expects float/vecN operands, got ${a.id} and ${b.id}`,
      { op, aType: a.id, bType: b.id },
    );
  }
  // GLSL's mod() builtin is float/vecN-only (int uses the "%" operator, which this IR does not
  // print for "mod" - see printBin). Reject here rather than silently type-checking int through
  // the same-id branch below and only failing later, at GLSL compile time, on the GPU.
  if (op === "mod" && (isIntType(a) || isIntType(b))) {
    fail(
      "ir-mod-int-unsupported",
      `mod is not defined for int/ivecN (GLSL's mod() has no integer overload)`,
    );
  }
  if (a.id === b.id) {
    return a; // T op T -> T
  }
  if (isVector(a) && isFloat(b)) {
    return a; // vecN op float -> vecN (splat), all arithmetic ops
  }
  if (isFloat(a) && isVector(b)) {
    if (LEFT_SPLAT_OPS.has(op)) {
      return b; // float op vecN -> vecN, only for add/mul
    }
    fail(
      "ir-arithmetic-no-left-splat",
      `${op} does not splat a scalar left operand against ${b.id}`,
      { op, bType: b.id },
    );
  }
  return fail("ir-arithmetic-type-mismatch", `${op} type mismatch: ${a.id} and ${b.id}`, {
    op,
    aType: a.id,
    bType: b.id,
  });
}

function binResultType(op: FXBinOp, a: FXValueType, b: FXValueType): FXValueType {
  if (COMPARISON_OPS.has(op)) {
    if (!isFloat(a) || !isFloat(b)) {
      fail(
        "ir-comparison-bad-operand-type",
        `comparison ${op} requires float operands, got ${a.id} and ${b.id}`,
        { op, aType: a.id, bType: b.id },
      );
    }
    return FX_VALUE_TYPES.float;
  }
  return arithmeticResultType(op, a, b);
}

function bin(op: FXBinOp, a: FXExpr, b: FXExpr): FXExpr {
  return { kind: "bin", type: binResultType(op, a.type, b.type), op, a, b };
}

/** A float literal. */
export function lit(value: number): FXExpr {
  return { kind: "lit", type: FX_VALUE_TYPES.float, values: [value] };
}

/** An `int` literal. `value` must already be an integer - GLSL has no implicit float->int narrowing. */
export function litInt(value: number): FXExpr {
  if (!Number.isInteger(value)) {
    fail("ir-int-literal-not-integer", `litInt expects an integer value, got ${value}`, { value });
  }
  return { kind: "lit", type: FX_VALUE_TYPES.int, values: [value] };
}

/** A vec2/vec3/vec4 literal, sized by the number of components given. */
export function litVec(...values: number[]): FXExpr {
  if (values.length < 2 || values.length > 4) {
    fail("ir-vector-literal-bad-width", `litVec needs 2..4 components, got ${values.length}`, {
      count: values.length,
    });
  }
  return {
    kind: "lit",
    type: vectorTypeForComponents(values.length, "litVec"),
    values: values.slice(),
  };
}

/** A named reference; how it prints is decided by {@link FXRefKind}. */
export function ref(kind: FXRefKind, name: string, type: FXValueType): FXExpr {
  return { kind: "ref", type, ref: kind, name };
}

/** `a + b`. `T+T`; `vecN+float`; `float+vecN`. */
export function add(a: FXExpr, b: FXExpr): FXExpr {
  return bin("add", a, b);
}

/** `a - b`. `T-T`; `vecN-float`. */
export function sub(a: FXExpr, b: FXExpr): FXExpr {
  return bin("sub", a, b);
}

/** `a * b`. `T*T`; `vecN*float`; `float*vecN`. */
export function mul(a: FXExpr, b: FXExpr): FXExpr {
  return bin("mul", a, b);
}

/** `a / b`. `T/T`; `vecN/float`. */
export function div(a: FXExpr, b: FXExpr): FXExpr {
  return bin("div", a, b);
}

/** `mod(a, b)`. `T%T`; `vecN%float`. */
export function mod(a: FXExpr, b: FXExpr): FXExpr {
  return bin("mod", a, b);
}

/** `a < b` -> float (1.0/0.0). Both operands must be float. */
export function lt(a: FXExpr, b: FXExpr): FXExpr {
  return bin("lt", a, b);
}

/** `a <= b` -> float. */
export function le(a: FXExpr, b: FXExpr): FXExpr {
  return bin("le", a, b);
}

/** `a > b` -> float. */
export function gt(a: FXExpr, b: FXExpr): FXExpr {
  return bin("gt", a, b);
}

/** `a >= b` -> float. */
export function ge(a: FXExpr, b: FXExpr): FXExpr {
  return bin("ge", a, b);
}

/** `a == b` -> float. */
export function eq(a: FXExpr, b: FXExpr): FXExpr {
  return bin("eq", a, b);
}

/** `-a`. Preserves the operand's float/vecN type. */
export function neg(a: FXExpr): FXExpr {
  if (!isScalarOrVector(a.type)) {
    fail("ir-negate-bad-operand", `neg expects a float/vecN operand, got ${a.type.id}`, {
      typeId: a.type.id,
    });
  }
  const op: FXUnOp = "neg";
  return { kind: "un", type: a.type, op, a };
}

/** Resolves a call into the function registry to a typed IR node (see {@link createCall}). */
export type FXCallResolver = (fn: string, ...args: FXExpr[]) => FXExpr;

/**
 * Builds a `call` resolver bound to one function-signature registry - each backend passes its
 * own map instead of relying on a shared mutable global, so there's no import-order coupling.
 */
export function createCall(
  signatures: ReadonlyMap<string, readonly FXCallSignature[]>,
): FXCallResolver {
  return (fn, ...args) => {
    const overloads = signatures.get(fn);
    if (overloads === undefined) {
      fail("ir-unknown-function", `unknown function "${fn}"`, { name: fn });
    }
    const argumentTypes = args.map((argument) => argument.type.id);
    const match = overloads.find(
      (signature) =>
        signature.args.length === argumentTypes.length &&
        signature.args.every((expected, i) => expected === argumentTypes[i]),
    );
    if (match === undefined) {
      fail(
        "ir-no-matching-overload",
        `no signature of "${fn}" accepts (${argumentTypes.join(", ")})`,
        { name: fn, argumentTypes: argumentTypes.join(", ") },
      );
    }
    return { kind: "call", type: resolveValueType(match.result), fn, args: args.slice() };
  };
}

/**
 * Component selection/reorder; the channel count fixes the result type (`"x"`->float,
 * `"xy"`->vec2, ...) and each channel must be within the source's component count.
 */
export function swizzle(a: FXExpr, channels: string): FXExpr {
  if (channels.length < 1 || channels.length > 4) {
    fail("ir-swizzle-bad-channel-count", `swizzle needs 1..4 channels, got "${channels}"`, {
      channels,
    });
  }
  // The source must be a vector: `(1.0).x` is invalid GLSL, and the channel-range
  // check below (`index < components`) alone lets a scalar `.x` through (0 < 1).
  if (!isVector(a.type)) {
    fail("ir-swizzle-bad-source", `swizzle needs a vec2/vec3/vec4 source, got ${a.type.id}`, {
      typeId: a.type.id,
    });
  }
  const sourceComponents = a.type.components;
  for (const channel of channels) {
    const index = SWIZZLE_CHANNELS.indexOf(channel);
    if (index === -1) {
      fail(
        "ir-swizzle-unknown-channel",
        `invalid swizzle channel "${channel}" (expected x/y/z/w)`,
        { channel },
      );
    }
    if (index >= sourceComponents) {
      fail(
        "ir-swizzle-channel-out-of-range",
        `swizzle channel "${channel}" out of range for ${a.type.id}`,
        { channel, typeId: a.type.id },
      );
    }
  }
  return {
    kind: "swizzle",
    type: vectorTypeForComponents(channels.length, "swizzle"),
    a,
    channels,
  };
}

/**
 * Extracts column `index` of a matrix as a `vecN` (`m[i]`, column-major). GLSL indexes a
 * matrix natively; the JS backend lowers it in `scalarize`.
 */
export function column(a: FXExpr, index: number): FXExpr {
  if (!isMatrixType(a.type)) {
    fail("ir-column-bad-source", `column needs a mat2/mat3/mat4 source, got ${a.type.id}`, {
      typeId: a.type.id,
    });
  }
  const dimension = matrixDimension(a.type.components);
  if (!Number.isInteger(index) || index < 0 || index >= dimension) {
    fail(
      "ir-column-index-out-of-range",
      `column index ${index.toString()} out of range for ${a.type.id} (0..${(dimension - 1).toString()})`,
      { index, typeId: a.type.id, maxIndex: dimension - 1 },
    );
  }
  return { kind: "column", type: vectorTypeForComponents(dimension, "column"), a, index };
}

/**
 * Assembles a vec2/vec3/vec4 from scalars and/or shorter vectors. The arguments'
 * total component count must equal the target vector's width.
 */
export function construct(type: FXValueType, ...args: FXExpr[]): FXExpr {
  if (isMatrixType(type)) {
    return constructMatrix(type, args);
  }
  if (!isVector(type)) {
    fail(
      "ir-construct-bad-target-type",
      `construct target must be vec2/vec3/vec4, got ${type.id}`,
      {
        typeId: type.id,
      },
    );
  }
  let total = 0;
  for (const argument of args) {
    if (!isScalarOrVector(argument.type)) {
      fail(
        "ir-construct-bad-argument-type",
        `construct argument must be float/vecN, got ${argument.type.id}`,
        { typeId: argument.type.id },
      );
    }
    total += argument.type.components;
  }
  if (total !== type.components) {
    fail(
      "ir-construct-component-count-mismatch",
      `construct(${type.id}) needs ${type.components} components, got ${total}`,
      { typeId: type.id, expected: type.components, got: total },
    );
  }
  return { kind: "construct", type, args: args.slice() };
}

/**
 * Assembles a `matN` from one of three GLSL matrix-constructor forms (columns, N^2 scalars,
 * or a matrix to resize) - validated strictly so a bare component-count sum can't accept `mat2(vec4)`.
 */
function constructMatrix(type: FXValueType, args: readonly FXExpr[]): FXExpr {
  const dimension = matrixDimension(type.components);
  const [firstArgument] = args;
  const single =
    args.length === 1 && firstArgument !== undefined && isMatrixType(firstArgument.type);
  const columns =
    args.length === dimension &&
    args.every((argument) => isVector(argument.type) && argument.type.components === dimension);
  const scalars =
    args.length === dimension * dimension && args.every((argument) => isFloat(argument.type));
  if (!single && !columns && !scalars) {
    fail(
      "ir-construct-matrix-bad-form",
      `construct(${type.id}) needs ${dimension} vec${dimension.toString()} columns, ` +
        `${(dimension * dimension).toString()} floats, or a single matrix to resize`,
      { typeId: type.id, dimension, scalarCount: dimension * dimension },
    );
  }
  return { kind: "construct", type, args: args.slice() };
}

/**
 * Adapts a numeric expression to `target` (see the per-branch comments below). A non-numeric
 * mismatch throws only as a backstop; {@link areTypesCompatible} already rejects it upstream.
 */
export function coerceNumeric(expr: FXExpr, target: FXValueType): FXExpr {
  const from = expr.type;
  if (from.id === target.id) {
    return expr;
  }
  // int/ivecN never implicitly interconverts with float/vecN, even when a component count
  // happens to line up (`ivec2`<->`vec2`) - the padding path below would otherwise construct
  // right through it. A cross-family value crosses only through an explicit toInt/toFloat cast.
  if (isIntType(from) || isIntType(target)) {
    fail(
      "ir-no-implicit-int-float-conversion",
      `cannot implicitly convert ${from.id} to ${target.id} - use an explicit int/float cast`,
      { fromType: from.id, targetType: target.id },
    );
  }
  if (!isScalarOrVector(from) || !isScalarOrVector(target)) {
    fail("ir-bad-numeric-conversion", `cannot convert ${from.id} to ${target.id}`, {
      fromType: from.id,
      targetType: target.id,
    });
  }
  if (isFloat(from)) {
    // float -> vecN: splat the scalar across every component.
    return construct(target, ...Array.from({ length: target.components }, () => expr));
  }
  if (isFloat(target)) {
    // vecN -> float: the first component.
    return swizzle(expr, "x");
  }
  if (target.components < from.components) {
    // wider -> narrower: keep the leading components, drop the rest.
    return swizzle(expr, SWIZZLE_CHANNELS.slice(0, target.components));
  }
  // narrower -> wider: keep the components, pad the missing tail with zeros.
  const padding = Array.from({ length: target.components - from.components }, () => lit(0));
  return construct(target, expr, ...padding);
}

/**
 * Explicit `float -> int` cast (GLSL `int(x)`, truncates toward zero) - the only sanctioned way
 * an int value enters a graph from a float one; no implicit int<->float coercion, ever. Scalar-only
 * for now; no `vecN -> ivecN` form yet.
 */
export function toInt(expr: FXExpr): FXExpr {
  if (!isFloat(expr.type)) {
    fail("ir-to-int-bad-operand", `toInt expects a float operand, got ${expr.type.id}`, {
      typeId: expr.type.id,
    });
  }
  return raw(FX_VALUE_TYPES.int, "glsl", "int($0)", expr);
}

/** Explicit `int -> float` cast (GLSL `float(x)`) - the inverse of {@link toInt}. */
export function toFloat(expr: FXExpr): FXExpr {
  if (expr.type.id !== "int") {
    fail("ir-to-float-bad-operand", `toFloat expects an int operand, got ${expr.type.id}`, {
      typeId: expr.type.id,
    });
  }
  return raw(FX_VALUE_TYPES.float, "glsl", "float($0)", expr);
}

/** Branchless select: `cond ? a : b`. `cond` is float; `a`/`b` share a type. */
export function select(condition: FXExpr, a: FXExpr, b: FXExpr): FXExpr {
  if (!isFloat(condition.type)) {
    fail(
      "ir-select-condition-not-float",
      `select condition must be float, got ${condition.type.id}`,
      { typeId: condition.type.id },
    );
  }
  if (a.type.id !== b.type.id) {
    fail(
      "ir-select-branch-type-mismatch",
      `select branches must share a type, got ${a.type.id} and ${b.type.id}`,
      { aType: a.type.id, bType: b.type.id },
    );
  }
  return { kind: "select", type: a.type, cond: condition, a, b };
}

/**
 * Escape hatch for code the IR can't express; `deps` substitute into `code` as `$0`, `$1`, ...
 * The author declares `type`/`language` and owns correctness.
 */
export function raw(
  type: FXValueType,
  language: "glsl" | "js",
  code: string,
  ...dependencies: FXExpr[]
): FXExpr {
  return { kind: "raw", type, language, code, deps: dependencies.slice() };
}

/** One overload of a registry function: exact argument types -> result type. */
export interface FXCallSignature {
  readonly args: readonly FXGLSLTypeName[];
  readonly result: FXGLSLTypeName;
}

/**
 * The signature-independent builders (everything but `call`), collected so a per-backend builder
 * can be assembled from them plus a registry-bound `call` (see {@link createBuilders}).
 */
const pureExprBuilders = {
  lit,
  litInt,
  litVec,
  ref,
  add,
  sub,
  mul,
  div,
  mod,
  lt,
  le,
  gt,
  ge,
  eq,
  neg,
  swizzle,
  column,
  construct,
  coerceNumeric,
  toInt,
  toFloat,
  select,
  raw,
};

/**
 * The IR-builder facade handed to a node's `build`: the pure builders plus a `call` bound to a
 * function-signature registry. Backend-specific only in `call`'s registry (see {@link createBuilders}).
 */
export type FXExprBuilderApi = typeof pureExprBuilders & { readonly call: FXCallResolver };

/** Assembles a builder facade whose `call` resolves against `signatures`. */
export function createBuilders(
  signatures: ReadonlyMap<string, readonly FXCallSignature[]>,
): FXExprBuilderApi {
  return { ...pureExprBuilders, call: createCall(signatures) };
}

const SWIZZLE_CHANNELS = "xyzw";

function vectorTypeForComponents(components: number, context: string): FXValueType {
  switch (components) {
    case 1:
      return FX_VALUE_TYPES.float;
    case 2:
      return FX_VALUE_TYPES.vec2;
    case 3:
      return FX_VALUE_TYPES.vec3;
    case 4:
      return FX_VALUE_TYPES.vec4;
    default:
      return fail("ir-bad-vector-width", `${context} supports 1..4 components, got ${components}`, {
        context,
        count: components,
      });
  }
}
