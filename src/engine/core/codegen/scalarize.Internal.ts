import type { FXExpr } from "../ir/FXExpr";
import type { FXValueType } from "../socket/FXValueType";
import { FX_VALUE_TYPES, isMatrixType, matrixDimension } from "../socket/FXValueType";

/**
 * Lowers a vector/matrix expr into one scalar expr per component (JS has no vectors). Names
 * follow {@link scalarComponentName}; the SSA layer must match this when naming its own locals.
 */
export function scalarize(expression: FXExpr): readonly FXExpr[] {
  switch (expression.kind) {
    case "lit":
      return expression.values.map(floatLiteral);
    case "ref":
      if (expression.type.components === 1) {
        return [expression];
      }
      return indices(expression.type.components).map((i) => ({
        kind: "ref",
        type: FLOAT,
        ref: expression.ref,
        name: scalarComponentName(expression.name, i),
      }));
    case "bin": {
      // `mat*mat` / `mat*vec` / `vec*mat` are reductions, not element-wise; the rest
      // (including `mat*float` and `mat +/- mat`) stay in the component-wise path below.
      if (expression.op === "mul") {
        const product = scalarizeMatrixMul(expression);
        if (product !== undefined) {
          return product;
        }
      }
      const a = scalarize(expression.a);
      const b = scalarize(expression.b);
      return indices(expression.type.components).map((i) => ({
        kind: "bin",
        type: FLOAT,
        op: expression.op,
        a: pick(a, i),
        b: pick(b, i),
      }));
    }
    case "un": {
      const a = scalarize(expression.a);
      return a.map((component) => ({ kind: "un", type: FLOAT, op: expression.op, a: component }));
    }
    case "call":
      return scalarizeCall(expression);
    case "swizzle": {
      const source = scalarize(expression.a);
      return [...expression.channels].map((channel) =>
        at(source, SWIZZLE_CHANNELS.indexOf(channel)),
      );
    }
    case "column": {
      // Column `index` of a matrix is its contiguous column-major slice (`col*n .. col*n + n`).
      const source = scalarize(expression.a);
      const dimension = expression.type.components;
      return source.slice(expression.index * dimension, expression.index * dimension + dimension);
    }
    case "construct":
      // A matrix from a single matrix arg is a resize (mat3(mat4)/mat4(mat3)); column and
      // scalar constructor forms just flatten (column-major).
      if (
        isMatrixType(expression.type) &&
        expression.args.length === 1 &&
        isMatrixType(at(expression.args, 0).type)
      ) {
        return resizeMatrix(scalarize(at(expression.args, 0)), expression.type.components);
      }
      return expression.args.flatMap(scalarize);
    case "select": {
      const condition = at(scalarize(expression.cond), 0);
      const a = scalarize(expression.a);
      const b = scalarize(expression.b);
      return indices(expression.type.components).map((i) => ({
        kind: "select",
        type: FLOAT,
        cond: condition,
        a: pick(a, i),
        b: pick(b, i),
      }));
    }
    case "raw":
      if (expression.type.components !== 1) {
        throw new Error(
          `sparcoon IR: raw ${expression.language} vector expression cannot be scalarized`,
        );
      }
      return [expression];
  }
}

/**
 * Component name for channel `index` of `base` (`x`/`y`/`z`/`w`, then `m<index>` past w for
 * matrices). Shared by this file's `ref`-expansion and the kernel's SSA materialize.
 */
export function scalarComponentName(base: string, index: number): string {
  return `${base}_${index < SWIZZLE_CHANNELS.length ? SWIZZLE_CHANNELS[index] : `m${index.toString()}`}`;
}

function scalarizeCall(expression: Extract<FXExpr, { kind: "call" }>): readonly FXExpr[] {
  switch (expression.fn) {
    case "length": {
      const components = scalarize(at(expression.args, 0));
      return [sqrtF(sumOfSquares(components))];
    }
    case "dot": {
      const a = scalarize(at(expression.args, 0));
      const b = scalarize(at(expression.args, 1));
      return [sumOfProducts(a, b)];
    }
    case "normalize": {
      const components = scalarize(at(expression.args, 0));
      const magnitude = sqrtF(sumOfSquares(components));
      return components.map((component) => binF("div", component, magnitude));
    }
    case "cross": {
      // vec3 x vec3: c = (ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx).
      const a = scalarize(at(expression.args, 0));
      const b = scalarize(at(expression.args, 1));
      const term = (
        firstAIndex: number,
        firstBIndex: number,
        secondAIndex: number,
        secondBIndex: number,
      ): FXExpr =>
        binF(
          "sub",
          binF("mul", at(a, firstAIndex), at(b, firstBIndex)),
          binF("mul", at(a, secondAIndex), at(b, secondBIndex)),
        );
      return [term(1, 2, 2, 1), term(2, 0, 0, 2), term(0, 1, 1, 0)];
    }
    case "noise": {
      // Vector-in / scalar-output: pass the input's components as separate scalar args to a
      // scalar `noise` call (printed as `fxNoise1`/`fxNoise2`/`fxNoise3`), rather than per-component.
      const components = scalarize(at(expression.args, 0));
      return [{ kind: "call", type: FLOAT, fn: "noise", args: components }];
    }
    case "fbm3": {
      // Same shape as `noise` above, plus the trailing scalar `octaves` arg passed through as-is.
      const position = scalarize(at(expression.args, 0));
      const octaves = scalarize(at(expression.args, 1));
      return [{ kind: "call", type: FLOAT, fn: "fbm3", args: [...position, ...octaves] }];
    }
    case "transpose": {
      // Pure component reindex, no arithmetic: column-major flat index `col*n + row`, so the
      // transpose's (col c, row r) entry is the source's (col r, row c) = `m[r*n + c]`.
      const matrix = scalarize(at(expression.args, 0));
      const dimension = matrixDimension(matrix.length);
      const output: FXExpr[] = [];
      for (let c = 0; c < dimension; c += 1) {
        for (let r = 0; r < dimension; r += 1) {
          output.push(at(matrix, r * dimension + c));
        }
      }
      return output;
    }
    case "determinant":
      return [scalarizeDeterminant(scalarize(at(expression.args, 0)))];
    case "inverse":
      return scalarizeInverse(scalarize(at(expression.args, 0)));
    default: {
      // Every other registered function is element-wise.
      const argComponents = expression.args.map(scalarize);
      return indices(expression.type.components).map((i) => ({
        kind: "call",
        type: FLOAT,
        fn: expression.fn,
        args: argComponents.map((arg) => pick(arg, i)),
      }));
    }
  }
}

const FLOAT = FX_VALUE_TYPES.float;
const SWIZZLE_CHANNELS = "xyzw";

function floatLiteral(value: number): FXExpr {
  return { kind: "lit", type: FLOAT, values: [value] };
}

function binF(op: "add" | "sub" | "mul" | "div", a: FXExpr, b: FXExpr): FXExpr {
  return { kind: "bin", type: FLOAT, op, a, b };
}

function negF(a: FXExpr): FXExpr {
  return { kind: "un", type: FLOAT, op: "neg", a };
}

function sqrtF(a: FXExpr): FXExpr {
  return { kind: "call", type: FLOAT, fn: "sqrt", args: [a] };
}

function sumOfSquares(components: readonly FXExpr[]): FXExpr {
  return components
    .map((component) => binF("mul", component, component))
    .reduce((accumulator, square) => binF("add", accumulator, square));
}

function sumOfProducts(a: readonly FXExpr[], b: readonly FXExpr[]): FXExpr {
  return a
    .map((component, i) => binF("mul", component, at(b, i)))
    .reduce((accumulator, product) => binF("add", accumulator, product));
}

function reduceSum(terms: readonly FXExpr[]): FXExpr {
  return terms.reduce((accumulator, term) => binF("add", accumulator, term));
}

function isFloatType(type: FXValueType): boolean {
  return type.id === "float";
}

/**
 * Lowers matrix `mul` to scalar reductions (column-major, flat index `col*n + row`); returns
 * `undefined` for element-wise cases (`mat*float`/no matrix), which fall through to `bin`.
 */
function scalarizeMatrixMul(
  expression: Extract<FXExpr, { kind: "bin" }>,
): readonly FXExpr[] | undefined {
  const aType = expression.a.type;
  const bType = expression.b.type;
  const aIsMatrix = isMatrixType(aType);
  const bIsMatrix = isMatrixType(bType);
  if (!aIsMatrix && !bIsMatrix) {
    return undefined; // vector/scalar mul - element-wise
  }
  if (isFloatType(aType) || isFloatType(bType)) {
    return undefined; // mat*float / float*mat - element-wise scale
  }
  const a = scalarize(expression.a);
  const b = scalarize(expression.b);
  if (aIsMatrix && bIsMatrix) {
    // mat*mat: output(col c, row r) = sum_k A(k, r) * B(c, k).
    const dimension = matrixDimension(aType.components);
    const output: FXExpr[] = [];
    for (let c = 0; c < dimension; c += 1) {
      for (let r = 0; r < dimension; r += 1) {
        output.push(
          reduceSum(
            indices(dimension).map((k) =>
              binF("mul", at(a, k * dimension + r), at(b, c * dimension + k)),
            ),
          ),
        );
      }
    }
    return output;
  }
  if (aIsMatrix) {
    // mat*vec: output(r) = sum_c A(c, r) * v(c).
    const dimension = matrixDimension(aType.components);
    return indices(dimension).map((r) =>
      reduceSum(indices(dimension).map((c) => binF("mul", at(a, c * dimension + r), at(b, c)))),
    );
  }
  // vec*mat (row vector): output(c) = sum_r v(r) * B(c, r).
  const dimension = matrixDimension(bType.components);
  return indices(dimension).map((c) =>
    reduceSum(indices(dimension).map((r) => binF("mul", at(a, r), at(b, c * dimension + r)))),
  );
}

/**
 * Resizes a matrix (`mat3(mat4)`/`mat4(mat3)`): copies the upper-left block, fills grown
 * diagonal with 1 / off-diagonal with 0 - matching GLSL's matrix-from-matrix constructor.
 */
function resizeMatrix(source: readonly FXExpr[], targetComponents: number): readonly FXExpr[] {
  const sourceDimension = matrixDimension(source.length);
  const destinationDimension = matrixDimension(targetComponents);
  const output: FXExpr[] = [];
  for (let c = 0; c < destinationDimension; c += 1) {
    for (let r = 0; r < destinationDimension; r += 1) {
      output.push(
        c < sourceDimension && r < sourceDimension
          ? at(source, c * sourceDimension + r)
          : floatLiteral(c === r ? 1 : 0),
      );
    }
  }
  return output;
}

/** The twelve shared 2x2 minors of a mat4 (`b00..b11`), column-major access `a(col, row)`. */
function mat4Minors(
  a: (col: number, row: number) => FXExpr,
): readonly [
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
  FXExpr,
] {
  const minor = (
    c1: number,
    r1: number,
    c2: number,
    r2: number,
    c3: number,
    r3: number,
    c4: number,
    r4: number,
  ): FXExpr => binF("sub", binF("mul", a(c1, r1), a(c2, r2)), binF("mul", a(c3, r3), a(c4, r4)));
  return [
    minor(0, 0, 1, 1, 0, 1, 1, 0), // b00 = a00*a11 - a01*a10
    minor(0, 0, 1, 2, 0, 2, 1, 0), // b01
    minor(0, 0, 1, 3, 0, 3, 1, 0), // b02
    minor(0, 1, 1, 2, 0, 2, 1, 1), // b03
    minor(0, 1, 1, 3, 0, 3, 1, 1), // b04
    minor(0, 2, 1, 3, 0, 3, 1, 2), // b05
    minor(2, 0, 3, 1, 2, 1, 3, 0), // b06
    minor(2, 0, 3, 2, 2, 2, 3, 0), // b07
    minor(2, 0, 3, 3, 2, 3, 3, 0), // b08
    minor(2, 1, 3, 2, 2, 2, 3, 1), // b09
    minor(2, 1, 3, 3, 2, 3, 3, 1), // b10
    minor(2, 2, 3, 3, 2, 3, 3, 2), // b11
  ];
}

/** Scalar determinant of a mat2/mat3/mat4 (column-major flat components). */
function scalarizeDeterminant(matrix: readonly FXExpr[]): FXExpr {
  const dimension = matrixDimension(matrix.length);
  const a = (c: number, r: number): FXExpr => at(matrix, c * dimension + r);
  const mul = (x: FXExpr, y: FXExpr): FXExpr => binF("mul", x, y);
  if (dimension === 2) {
    return reduceSum([mul(a(0, 0), a(1, 1)), negF(mul(a(0, 1), a(1, 0)))]);
  }
  if (dimension === 3) {
    const b0 = binF("sub", mul(a(2, 2), a(1, 1)), mul(a(1, 2), a(2, 1)));
    const b1 = binF("sub", mul(a(1, 2), a(2, 0)), mul(a(2, 2), a(1, 0)));
    const b2 = binF("sub", mul(a(2, 1), a(1, 0)), mul(a(1, 1), a(2, 0)));
    return reduceSum([mul(a(0, 0), b0), mul(a(0, 1), b1), mul(a(0, 2), b2)]);
  }
  const b = mat4Minors(a);
  return reduceSum([
    mul(b[0], b[11]),
    negF(mul(b[1], b[10])),
    mul(b[2], b[9]),
    mul(b[3], b[8]),
    negF(mul(b[4], b[7])),
    mul(b[5], b[6]),
  ]);
}

/**
 * Column-major inverse of a mat2/mat3/mat4 (`adjugate / determinant`). `determinant` (and mat4's
 * twelve `b*` minors) is one shared object, so CSE emits it once per particle, not once per component.
 */
function scalarizeInverse(matrix: readonly FXExpr[]): readonly FXExpr[] {
  const dimension = matrixDimension(matrix.length);
  const a = (c: number, r: number): FXExpr => at(matrix, c * dimension + r);
  const mul = (x: FXExpr, y: FXExpr): FXExpr => binF("mul", x, y);
  const sub = (x: FXExpr, y: FXExpr): FXExpr => binF("sub", x, y);
  const over = (numerator: FXExpr, determinant: FXExpr): FXExpr =>
    binF("div", numerator, determinant);
  if (dimension === 2) {
    const determinant = reduceSum([mul(a(0, 0), a(1, 1)), negF(mul(a(0, 1), a(1, 0)))]);
    return [a(1, 1), negF(a(0, 1)), negF(a(1, 0)), a(0, 0)].map((numerator) =>
      over(numerator, determinant),
    );
  }
  if (dimension === 3) {
    const b0 = sub(mul(a(2, 2), a(1, 1)), mul(a(1, 2), a(2, 1)));
    const b1 = sub(mul(a(1, 2), a(2, 0)), mul(a(2, 2), a(1, 0)));
    const b2 = sub(mul(a(2, 1), a(1, 0)), mul(a(1, 1), a(2, 0)));
    const determinant = reduceSum([mul(a(0, 0), b0), mul(a(0, 1), b1), mul(a(0, 2), b2)]);
    const numerators = [
      b0,
      sub(mul(a(0, 2), a(2, 1)), mul(a(2, 2), a(0, 1))),
      sub(mul(a(1, 2), a(0, 1)), mul(a(0, 2), a(1, 1))),
      b1,
      sub(mul(a(2, 2), a(0, 0)), mul(a(0, 2), a(2, 0))),
      sub(mul(a(0, 2), a(1, 0)), mul(a(1, 2), a(0, 0))),
      b2,
      sub(mul(a(0, 1), a(2, 0)), mul(a(2, 1), a(0, 0))),
      sub(mul(a(1, 1), a(0, 0)), mul(a(0, 1), a(1, 0))),
    ];
    return numerators.map((numerator) => over(numerator, determinant));
  }
  const b = mat4Minors(a);
  const determinant = reduceSum([
    mul(b[0], b[11]),
    negF(mul(b[1], b[10])),
    mul(b[2], b[9]),
    mul(b[3], b[8]),
    negF(mul(b[4], b[7])),
    mul(b[5], b[6]),
  ]);
  const three = (x: FXExpr, y: FXExpr, z: FXExpr): FXExpr => reduceSum([x, y, z]);
  const numerators = [
    three(mul(a(1, 1), b[11]), negF(mul(a(1, 2), b[10])), mul(a(1, 3), b[9])),
    three(mul(a(0, 2), b[10]), negF(mul(a(0, 1), b[11])), negF(mul(a(0, 3), b[9]))),
    three(mul(a(3, 1), b[5]), negF(mul(a(3, 2), b[4])), mul(a(3, 3), b[3])),
    three(mul(a(2, 2), b[4]), negF(mul(a(2, 1), b[5])), negF(mul(a(2, 3), b[3]))),
    three(mul(a(1, 2), b[8]), negF(mul(a(1, 0), b[11])), negF(mul(a(1, 3), b[7]))),
    three(mul(a(0, 0), b[11]), negF(mul(a(0, 2), b[8])), mul(a(0, 3), b[7])),
    three(mul(a(3, 2), b[2]), negF(mul(a(3, 0), b[5])), negF(mul(a(3, 3), b[1]))),
    three(mul(a(2, 0), b[5]), negF(mul(a(2, 2), b[2])), mul(a(2, 3), b[1])),
    three(mul(a(1, 0), b[10]), negF(mul(a(1, 1), b[8])), mul(a(1, 3), b[6])),
    three(mul(a(0, 1), b[8]), negF(mul(a(0, 0), b[10])), negF(mul(a(0, 3), b[6]))),
    three(mul(a(3, 0), b[4]), negF(mul(a(3, 1), b[2])), mul(a(3, 3), b[0])),
    three(mul(a(2, 1), b[2]), negF(mul(a(2, 0), b[4])), negF(mul(a(2, 3), b[0]))),
    three(mul(a(1, 1), b[7]), negF(mul(a(1, 0), b[9])), negF(mul(a(1, 2), b[6]))),
    three(mul(a(0, 0), b[9]), negF(mul(a(0, 1), b[7])), mul(a(0, 2), b[6])),
    three(mul(a(3, 1), b[1]), negF(mul(a(3, 0), b[3])), negF(mul(a(3, 2), b[0]))),
    three(mul(a(2, 0), b[3]), negF(mul(a(2, 1), b[1])), mul(a(2, 2), b[0])),
  ];
  return numerators.map((numerator) => over(numerator, determinant));
}

/** Splat-aware component pick: a length-1 array (scalar) feeds every component. */
function pick(components: readonly FXExpr[], index: number): FXExpr {
  return components.length === 1 ? at(components, 0) : at(components, index);
}

/** Indexes a component array at a position the caller's shape guarantees is in range. */
function at(components: readonly FXExpr[], index: number): FXExpr {
  const component = components[index];
  if (component === undefined) {
    throw new Error(
      `sparcoon IR: component index ${index.toString()} out of range (length ${components.length.toString()})`,
    );
  }
  return component;
}

function indices(count: number): number[] {
  return [...Array(count).keys()];
}
