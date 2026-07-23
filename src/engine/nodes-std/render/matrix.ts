import { defineNode } from "../../core/nodes/defineNode";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import type { FXGLSLTypeName, FXValueType } from "../../core/socket/FXValueType";
import { FX_VALUE_TYPES, matrixDimension } from "../../core/socket/FXValueType";
import {
  CAMERA_MODEL_PARAM,
  cameraDirectionForModel,
  cameraModelReads,
  orthogonalTowardTarget,
} from "./cameraSupport.Internal";

/**
 * Standard-library matrix nodes: build, compose and apply `mat2`/`mat3`/`mat4` transforms. Most
 * are `domain: "shared"` (the JS/behavior backend lowers matrices via `scalarize`'s cofactor/
 * reindex formulas) - `view-matrix`/`inverse-view-matrix`/`align-to-velocity` are render-only (no
 * camera in behavior).
 */

const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;
const MAT2 = FX_VALUE_TYPES.mat2;
const MAT3 = FX_VALUE_TYPES.mat3;
const MAT4 = FX_VALUE_TYPES.mat4;

/** mat2 / mat3 / mat4 - the polymorphic constraint the pure matrix ops resolve `T` over. */
const MATRICES: readonly FXGLSLTypeName[] = ["mat2", "mat3", "mat4"];

/** `matN * matN`: N^3 multiplies + N^2*(N-1) adds (composition). */
function matrixMultiplyCost(resolvedT: FXValueType): number {
  const dimension = matrixDimension(resolvedT.components);
  return dimension ** 3 + dimension * dimension * (dimension - 1);
}

/** The only dimensions {@link MATRICES} resolves to (mat2/mat3/mat4), so per-dimension cost tables cover exactly these keys. */
type MatrixDimension = 2 | 3 | 4;

/**
 * Reads a per-dimension cost table at a dimension computed via {@link matrixDimension}. The three
 * literal-key branches let TypeScript prove each lookup non-null; `matrixDimension` is a general
 * sqrt-based helper with a wider `number` return type, so a dimension outside 2/3/4 here means the
 * caller's resolved type escaped the {@link MATRICES} constraint - an invariant violation, not a
 * normal code path.
 */
function costForMatrixDimension(
  costs: Readonly<Record<MatrixDimension, number>>,
  dimension: number,
): number {
  switch (dimension) {
    case 2:
      return costs[2];
    case 3:
      return costs[3];
    case 4:
      return costs[4];
    default:
      throw new Error("matrix dimension must be 2, 3, or 4");
  }
}

/** Hand-estimated cofactor-expansion op counts for the baseline-safe matrix inverse, by dimension. */
const MATRIX_INVERSE_COST = {
  2: 10,
  3: 45,
  4: 160,
} as const satisfies Record<MatrixDimension, number>;
function matrixInverseCost(resolvedT: FXValueType): number {
  return costForMatrixDimension(MATRIX_INVERSE_COST, matrixDimension(resolvedT.components));
}

/** Hand-estimated cofactor-expansion op counts for a matrix determinant, by dimension. */
const MATRIX_DETERMINANT_COST = {
  2: 3,
  3: 14,
  4: 50,
} as const satisfies Record<MatrixDimension, number>;
function matrixDeterminantCost(resolvedT: FXValueType): number {
  return costForMatrixDimension(MATRIX_DETERMINANT_COST, matrixDimension(resolvedT.components));
}

/**
 * Rotation matrix (mat3) about an arbitrary axis by `angle` (radians), via Rodrigues' formula.
 * The axis is normalized (a zero axis guards to length 1, yielding identity at angle 0).
 */
export const fxRotationMatrix = defineNode({
  type: "rotation-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    axis: { type: "vec3", value: [0, 1, 0] },
    angle: { type: "float", value: 0, step: 0.05 },
  },
  outputs: { out: { type: "mat3" } },
  params: {},
  // Flat: axis normalize (length(7) + zero-guard(2) + per-component divide(6) = 15) + cos/sin (8)
  // + the six shared double-multiply products (2 each = 12) + three single multiplies (3) + the
  // nine-entry column assembly (9) = 48.
  cost: 48,
  build: ({ inputs, local, fn }) => {
    const axisLength = local("rm_al", fn.call("length", inputs["axis"]));
    const safeAxisLength = fn.select(fn.eq(axisLength, fn.lit(0)), fn.lit(1), axisLength);
    const normalizedAxis = local("rm_n", fn.div(inputs["axis"], safeAxisLength));
    const x = local("rm_x", fn.swizzle(normalizedAxis, "x"));
    const y = local("rm_y", fn.swizzle(normalizedAxis, "y"));
    const z = local("rm_z", fn.swizzle(normalizedAxis, "z"));
    const cosineAngle = local("rm_c", fn.call("cos", inputs["angle"]));
    const sineAngle = local("rm_s", fn.call("sin", inputs["angle"]));
    const oneMinusCosine = local("rm_t", fn.sub(fn.lit(1), cosineAngle));
    // Shared products, materialized so each appears once across the nine entries.
    const oneMinusCosineTimesXX = local("rm_txx", fn.mul(fn.mul(oneMinusCosine, x), x));
    const oneMinusCosineTimesYY = local("rm_tyy", fn.mul(fn.mul(oneMinusCosine, y), y));
    const oneMinusCosineTimesZZ = local("rm_tzz", fn.mul(fn.mul(oneMinusCosine, z), z));
    const oneMinusCosineTimesXY = local("rm_txy", fn.mul(fn.mul(oneMinusCosine, x), y));
    const oneMinusCosineTimesYZ = local("rm_tyz", fn.mul(fn.mul(oneMinusCosine, y), z));
    const oneMinusCosineTimesXZ = local("rm_txz", fn.mul(fn.mul(oneMinusCosine, x), z));
    const sineTimesX = local("rm_sx", fn.mul(sineAngle, x));
    const sineTimesY = local("rm_sy", fn.mul(sineAngle, y));
    const sineTimesZ = local("rm_sz", fn.mul(sineAngle, z));
    const column0 = fn.construct(
      VEC3,
      fn.add(oneMinusCosineTimesXX, cosineAngle),
      fn.add(oneMinusCosineTimesXY, sineTimesZ),
      fn.sub(oneMinusCosineTimesXZ, sineTimesY),
    );
    const column1 = fn.construct(
      VEC3,
      fn.sub(oneMinusCosineTimesXY, sineTimesZ),
      fn.add(oneMinusCosineTimesYY, cosineAngle),
      fn.add(oneMinusCosineTimesYZ, sineTimesX),
    );
    const column2 = fn.construct(
      VEC3,
      fn.add(oneMinusCosineTimesXZ, sineTimesY),
      fn.sub(oneMinusCosineTimesYZ, sineTimesX),
      fn.add(oneMinusCosineTimesZZ, cosineAngle),
    );
    return { out: fn.construct(MAT3, column0, column1, column2) };
  },
});

/**
 * Rotation matrix (mat3) from Euler angles (radians) in Three's default **XYZ** intrinsic order,
 * mirroring `THREE.Matrix4.makeRotationFromEuler`, so it matches an emitter's Euler transform.
 */
export const fxEulerToRotation = defineNode({
  type: "euler-to-rotation",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { angles: { type: "vec3", value: [0, 0, 0], step: 0.05 } },
  outputs: { out: { type: "mat3" } },
  params: {},
  // 6 trig calls (~24) + the nine-entry assembly (~20).
  cost: 44,
  build: ({ inputs, local, fn }) => {
    const cosineX = local("e2r_a", fn.call("cos", fn.swizzle(inputs["angles"], "x")));
    const sineX = local("e2r_b", fn.call("sin", fn.swizzle(inputs["angles"], "x")));
    const cosineY = local("e2r_c", fn.call("cos", fn.swizzle(inputs["angles"], "y")));
    const sineY = local("e2r_d", fn.call("sin", fn.swizzle(inputs["angles"], "y")));
    const cosineZ = local("e2r_e", fn.call("cos", fn.swizzle(inputs["angles"], "z")));
    const sineZ = local("e2r_f", fn.call("sin", fn.swizzle(inputs["angles"], "z")));
    // Shared products, materialized once (they recur across the nine entries).
    const cosineXCosineZ = local("e2r_ae", fn.mul(cosineX, cosineZ));
    const cosineXSineZ = local("e2r_af", fn.mul(cosineX, sineZ));
    const sineXCosineZ = local("e2r_be", fn.mul(sineX, cosineZ));
    const sineXSineZ = local("e2r_bf", fn.mul(sineX, sineZ));
    // Column-major: column j is (m[0][j], m[1][j], m[2][j]).
    const column0 = fn.construct(
      VEC3,
      fn.mul(cosineY, cosineZ),
      fn.add(cosineXSineZ, fn.mul(sineXCosineZ, sineY)),
      fn.sub(sineXSineZ, fn.mul(cosineXCosineZ, sineY)),
    );
    const column1 = fn.construct(
      VEC3,
      fn.neg(fn.mul(cosineY, sineZ)),
      fn.sub(cosineXCosineZ, fn.mul(sineXSineZ, sineY)),
      fn.add(sineXCosineZ, fn.mul(cosineXSineZ, sineY)),
    );
    const column2 = fn.construct(
      VEC3,
      sineY,
      fn.neg(fn.mul(sineX, cosineY)),
      fn.mul(cosineX, cosineY),
    );
    return { out: fn.construct(MAT3, column0, column1, column2) };
  },
});

/** Normalizes `v`, guarding a zero length to a divisor of 1 (matches {@link fxRotationMatrix}'s axis guard). */
function safeNormalize(
  hint: string,
  v: FXExpr,
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  const length = local(`${hint}l`, fn.call("length", v));
  const safeLength = fn.select(fn.eq(length, fn.lit(0)), fn.lit(1), length);
  return local(hint, fn.div(v, safeLength));
}

/** Cyclic x/y/z order used to resolve an axis collision and the sign of a cross-product column. */
const AXES: readonly string[] = ["x", "y", "z"];

/**
 * The `axis` structural param of {@link fxAlignToVelocity}: which local axis gets rotated to
 * point along `velocity`. Default `"z"` matches the engine's forward-axis convention (see
 * `transform-direction`'s default direction).
 */
const ALIGN_AXIS_PARAM = {
  kind: "structural",
  type: "enum",
  options: ["x", "y", "z"],
  default: "z",
} as const satisfies FXParamSpec;

/** Sign of the `velocity`-aligned axis: unflipped points along `velocity`, flipped against it. */
const ALIGN_FLIP_PARAM = {
  kind: "structural",
  type: "flag",
  default: false,
} as const satisfies FXParamSpec;

/**
 * Which of the two axes not claimed by `axis` faces the camera (the third is the cross-product
 * of the other two). A collision with `axis` (both pointing at the same local axis) resolves to
 * the next axis in {@link AXES} order - see {@link resolveAlignAxes}.
 */
const ALIGN_CAMERA_AXIS_PARAM = {
  kind: "structural",
  type: "enum",
  options: ["x", "y", "z"],
  default: "y",
} as const satisfies FXParamSpec;

/**
 * Resolves the three basis-column axes for {@link fxAlignToVelocity}: `velocityAxis` (= `axis`),
 * `cameraAxis` (bumped to the next {@link AXES} entry on a collision with `axis`), and whichever
 * axis is left for the cross-product-derived column. `derivedFromVelocityFirst` says whether that
 * column is `cross(aligned, reference)` (true) or `cross(reference, aligned)` (false) - whichever
 * keeps the assembled matrix a proper (determinant +1) rotation for this placement: true when
 * `(velocityAxis, cameraAxis, derivedAxis)` is a cyclic rotation of `AXES`, false otherwise.
 */
export function resolveAlignAxes(
  axis: string,
  cameraAxis: string,
): {
  velocityAxis: string;
  cameraAxis: string;
  derivedAxis: string;
  derivedFromVelocityFirst: boolean;
} {
  const velocityIndex = AXES.indexOf(axis);
  // (velocityIndex + 1) % 3 is 0/1/2 for every possible AXES.indexOf result (-1 included), so this
  // always lands inside AXES's three entries; the guard documents that instead of asserting past it.
  const nextAxis = AXES[(velocityIndex + 1) % 3];
  if (nextAxis === undefined) {
    throw new Error("axis cycle index landed outside the AXES table");
  }
  const resolvedCameraAxis = cameraAxis === axis ? nextAxis : cameraAxis;
  const cameraIndex = AXES.indexOf(resolvedCameraAxis);
  // AXES has 3 entries and this excludes at most 2 (axis, resolvedCameraAxis), so a match always
  // remains; the guard documents that instead of asserting past it.
  const derivedAxis = AXES.find(
    (candidate) => candidate !== axis && candidate !== resolvedCameraAxis,
  );
  if (derivedAxis === undefined) {
    throw new Error("no axis remained after excluding the velocity and camera axes");
  }
  return {
    velocityAxis: axis,
    cameraAxis: resolvedCameraAxis,
    derivedAxis,
    derivedFromVelocityFirst: cameraIndex === (velocityIndex + 1) % 3,
  };
}

/**
 * A rotation (`mat3`) that both aims one local axis along `velocity` and turns another to face
 * the camera as closely as it can while staying orthogonal to the aligned axis - a combined
 * velocity-stretch + billboard, e.g. a spark aligned edge-on to its direction of travel while
 * still showing its widest face to the camera. `axis` picks the velocity-aligned axis (`flip`
 * reverses its sign); `cameraAxis` picks which of the remaining two faces the camera; the third
 * is the cross-product of the other two (see {@link resolveAlignAxes}). `cameraModel` swaps the
 * cheap parallel view-forward for the true per-particle camera direction (see
 * {@link cameraDirectionForModel}); either way the camera-facing axis is built through
 * {@link orthogonalTowardTarget}, which stays well-behaved even when the camera direction nears
 * the velocity axis (see that function's doc comment). Zero `velocity` is a separate, unrelated
 * degenerate case, still guarded by {@link safeNormalize}.
 */
export const fxAlignToVelocity = defineNode({
  type: "align-to-velocity",
  domain: "render",
  stage: "param",
  category: "matrix",
  inputs: {
    velocity: { type: "vec3", value: [0, 0, 0] },
    // The "point" camera model only: where this particle actually renders. Unconnected -> the raw
    // simulated PARTICLE_POSITION; override when the graph renders it somewhere else (e.g.
    // attached to the emitter via fxTransformPoint(fxWorldMatrix, ...)), or the camera direction
    // is wrong. Deliberately `required: false` with no `targetInput` default (see
    // cameraDirectionForModel) so this node stays legal on a target without PARTICLE_POSITION as
    // long as cameraModel never resolves to "point".
    position: { type: "vec3", required: false },
  },
  outputs: { out: { type: "mat3" } },
  params: {
    axis: ALIGN_AXIS_PARAM,
    flip: ALIGN_FLIP_PARAM,
    cameraAxis: ALIGN_CAMERA_AXIS_PARAM,
    cameraModel: CAMERA_MODEL_PARAM,
  },
  // normalize velocity (length(7) + guard(2) + divide(6) = 15) + optional flip negate (3) +
  // camera direction (parallel: transpose(0) + mat3*vec3(15) = 15; point: sub(3) + normalize(15)
  // = 18) + orthogonalTowardTarget (cross(9) + length(7) + smoothstep(8) + fallback cross
  // (helper-pick guard(3) + cross(9) = 12) + mix(9) + final cross+normalize (9 +
  // unguarded-normalize(length(7)+divide(6))=13 = 22) = 67) + one cross product for the derived
  // axis (9).
  cost: ({ params }) =>
    15 + (params.flip === true ? 3 : 0) + (params.cameraModel === "point" ? 18 : 15) + 67 + 9,
  reads: (params) => cameraModelReads(params["cameraModel"]),
  build: ({ inputs, params, target, local, fn }) => {
    const flippedVelocity = params.flip
      ? local("atv_fv", fn.neg(inputs["velocity"]))
      : inputs["velocity"];
    const aligned = safeNormalize("atv_a", flippedVelocity, local, fn);

    const cameraDirection = cameraDirectionForModel(
      params.cameraModel,
      inputs["position"],
      target,
      local,
      fn,
    );
    const reference = local("atv_r", orthogonalTowardTarget(aligned, cameraDirection, local, fn));

    const axes = resolveAlignAxes(params.axis, params.cameraAxis);
    const derived = local(
      "atv_d",
      axes.derivedFromVelocityFirst
        ? fn.call("cross", aligned, reference)
        : fn.call("cross", reference, aligned),
    );
    // velocityAxis/cameraAxis/derivedAxis are a permutation of "x"/"y"/"z" (see resolveAlignAxes),
    // so this covers every column; the guard documents that instead of asserting past it.
    const columns: Partial<Record<string, FXExpr>> = {
      [axes.velocityAxis]: aligned,
      [axes.cameraAxis]: reference,
      [axes.derivedAxis]: derived,
    };
    const columnX = columns["x"];
    const columnY = columns["y"];
    const columnZ = columns["z"];
    if (columnX === undefined || columnY === undefined || columnZ === undefined) {
      throw new Error("align-to-velocity axis assignment did not cover x, y, and z");
    }
    return { out: fn.construct(MAT3, columnX, columnY, columnZ) };
  },
});

/** Diagonal scale matrix (mat3) from a per-axis scale vector. */
export const fxScaleMatrix = defineNode({
  type: "scale-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { scale: { type: "vec3", value: [1, 1, 1] } },
  outputs: { out: { type: "mat3" } },
  params: {},
  // Swizzle + construct - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => {
    const scaleX = fn.swizzle(inputs["scale"], "x");
    const scaleY = fn.swizzle(inputs["scale"], "y");
    const scaleZ = fn.swizzle(inputs["scale"], "z");
    const zero = fn.lit(0);
    return {
      out: fn.construct(
        MAT3,
        fn.construct(VEC3, scaleX, zero, zero),
        fn.construct(VEC3, zero, scaleY, zero),
        fn.construct(VEC3, zero, zero, scaleZ),
      ),
    };
  },
});

/**
 * Assembles a `matN` from N column vectors (column-major) - the concrete engine arm of the
 * editor's `combine` facade for a matrix `type` (see `nodeFamilies`); unconnected columns
 * default to the identity, so a bare node yields the identity matrix.
 */
export const fxCombineMat2 = defineNode({
  type: "combine-mat2",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    x: { type: "vec2", value: [1, 0] },
    y: { type: "vec2", value: [0, 1] },
  },
  outputs: { out: { type: "mat2" } },
  params: {},
  // `construct` assembles a matrix from columns - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({ out: fn.construct(MAT2, inputs["x"], inputs["y"]) }),
});

/** Assembles a mat3 from three column vectors (column-major). See {@link fxCombineMat2}. */
export const fxCombineMat3 = defineNode({
  type: "combine-mat3",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    x: { type: "vec3", value: [1, 0, 0] },
    y: { type: "vec3", value: [0, 1, 0] },
    z: { type: "vec3", value: [0, 0, 1] },
  },
  outputs: { out: { type: "mat3" } },
  params: {},
  // `construct` assembles a matrix from columns - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    out: fn.construct(MAT3, inputs["x"], inputs["y"], inputs["z"]),
  }),
});

/** Assembles a mat4 from four column vectors (column-major). See {@link fxCombineMat2}. */
export const fxCombineMat4 = defineNode({
  type: "combine-mat4",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    x: { type: "vec4", value: [1, 0, 0, 0] },
    y: { type: "vec4", value: [0, 1, 0, 0] },
    z: { type: "vec4", value: [0, 0, 1, 0] },
    w: { type: "vec4", value: [0, 0, 0, 1] },
  },
  outputs: { out: { type: "mat4" } },
  params: {},
  // `construct` assembles a matrix from columns - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    out: fn.construct(MAT4, inputs["x"], inputs["y"], inputs["z"], inputs["w"]),
  }),
});

/**
 * Splits a `matN` into its N column vectors (column-major) - the inverse of `combine-mat{N}` and
 * the concrete engine arm of the editor's `split` facade for a matrix input (see `nodeFamilies`).
 */
export const fxSplitMat2 = defineNode({
  type: "split-mat2",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { v: { type: "mat2", required: true } },
  outputs: {
    x: { type: "vec2" },
    y: { type: "vec2" },
  },
  params: {},
  // `column` extracts a column - a re-index, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    x: fn.column(inputs["v"], 0),
    y: fn.column(inputs["v"], 1),
  }),
});

/** Splits a mat3 into its three column vectors (column-major). See {@link fxSplitMat2}. */
export const fxSplitMat3 = defineNode({
  type: "split-mat3",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { v: { type: "mat3", required: true } },
  outputs: {
    x: { type: "vec3" },
    y: { type: "vec3" },
    z: { type: "vec3" },
  },
  params: {},
  // `column` extracts a column - a re-index, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    x: fn.column(inputs["v"], 0),
    y: fn.column(inputs["v"], 1),
    z: fn.column(inputs["v"], 2),
  }),
});

/** Splits a mat4 into its four column vectors (column-major). See {@link fxSplitMat2}. */
export const fxSplitMat4 = defineNode({
  type: "split-mat4",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { v: { type: "mat4", required: true } },
  outputs: {
    x: { type: "vec4" },
    y: { type: "vec4" },
    z: { type: "vec4" },
    w: { type: "vec4" },
  },
  params: {},
  // `column` extracts a column - a re-index, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    x: fn.column(inputs["v"], 0),
    y: fn.column(inputs["v"], 1),
    z: fn.column(inputs["v"], 2),
    w: fn.column(inputs["v"], 3),
  }),
});

/** Affine translation matrix (mat4) from an offset; identity rotation/scale. */
export const fxTranslationMatrix = defineNode({
  type: "translation-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { offset: { type: "vec3", value: [0, 0, 0] } },
  outputs: { out: { type: "mat4" } },
  params: {},
  // `construct` assembles a matrix from columns - a data reshuffle, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({
    // Column-major: the translation lives in the fourth column (with w = 1).
    out: fn.construct(
      MAT4,
      fn.litVec(1, 0, 0, 0),
      fn.litVec(0, 1, 0, 0),
      fn.litVec(0, 0, 1, 0),
      fn.construct(VEC4, inputs["offset"], fn.lit(1)),
    ),
  }),
});

/** Matrix product `a * b` (composition) of two same-dimension matrices. */
export const fxMatrixMultiply = defineNode({
  type: "matrix-multiply",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  generic: { constraint: MATRICES },
  inputs: {
    a: { type: "T", required: true },
    b: { type: "T", required: true },
  },
  outputs: { out: { type: "T" } },
  params: {},
  cost: ({ resolvedT }) => matrixMultiplyCost(resolvedT),
  build: ({ inputs, fn }) => ({ out: fn.mul(inputs["a"], inputs["b"]) }),
});

/** Matrix transpose. */
export const fxTranspose = defineNode({
  type: "transpose",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  generic: { constraint: MATRICES },
  inputs: { m: { type: "T", required: true } },
  outputs: { out: { type: "T" } },
  params: {},
  // A reindex, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({ out: fn.call("transpose", inputs["m"]) }),
});

/** Matrix inverse (baseline-safe helper; result is undefined for a singular matrix). */
export const fxInverse = defineNode({
  type: "inverse",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  generic: { constraint: MATRICES },
  inputs: { m: { type: "T", required: true } },
  outputs: { out: { type: "T" } },
  params: {},
  cost: ({ resolvedT }) => matrixInverseCost(resolvedT),
  build: ({ inputs, fn }) => ({ out: fn.call("inverse", inputs["m"]) }),
});

/** Matrix determinant as a scalar. */
export const fxDeterminant = defineNode({
  type: "determinant",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  generic: { constraint: MATRICES },
  inputs: { m: { type: "T", required: true } },
  outputs: { out: { type: "float" } },
  params: {},
  cost: ({ resolvedT }) => matrixDeterminantCost(resolvedT),
  build: ({ inputs, fn }) => ({ out: fn.call("determinant", inputs["m"]) }),
});

/** Transforms a point by a mat4 (affine: applies translation via `w = 1`), returns a vec3. */
export const fxTransformPoint = defineNode({
  type: "transform-point",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    m: { type: "mat4", required: true },
    p: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { out: { type: "vec3" } },
  params: {},
  // mat4 * vec4: 16 multiplies + 12 adds.
  cost: 28,
  build: ({ inputs, local, fn }) => {
    const homogeneous = local(
      "tp_h",
      fn.mul(inputs["m"], fn.construct(VEC4, inputs["p"], fn.lit(1))),
    );
    return { out: fn.swizzle(homogeneous, "xyz") };
  },
});

/** Transforms a direction by a mat3 (linear, no translation), returns a vec3. */
export const fxTransformDirection = defineNode({
  type: "transform-direction",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {
    m: { type: "mat3", required: true },
    v: { type: "vec3", value: [0, 0, 1] },
  },
  outputs: { out: { type: "vec3" } },
  params: {},
  // mat3 * vec3: 9 multiplies + 6 adds.
  cost: 15,
  build: ({ inputs, fn }) => ({ out: fn.mul(inputs["m"], inputs["v"]) }),
});

/**
 * Normal matrix (mat3) from a model mat4: `transpose(inverse(mat3(model)))`. Transforms normals
 * correctly under non-uniform scale/shear, where the plain rotation part would skew them off the surface.
 */
export const fxNormalMatrix = defineNode({
  type: "normal-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { model: { type: "mat4", required: true } },
  outputs: { out: { type: "mat3" } },
  params: {},
  // mat3(model) extraction + transpose are both reindexes (0); the mat3 inverse dominates.
  cost: MATRIX_INVERSE_COST[3],
  build: ({ inputs, local, fn }) => {
    const upper = local("nm_upper", fn.construct(MAT3, inputs["model"]));
    return { out: fn.call("transpose", fn.call("inverse", upper)) };
  },
});

/**
 * The rotation/scale part of a mat4 (its upper-left 3x3 block, translation dropped) -
 * `mat3(model)`. Feeds `transform-direction`, which needs a `mat3`: a direction has no
 * position, so translation must not apply to it.
 */
export const fxMatrixToMat3 = defineNode({
  type: "matrix-to-mat3",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: { m: { type: "mat4", required: true } },
  outputs: { out: { type: "mat3" } },
  params: {},
  // A resize (upper-left block copy) - a reindex, not arithmetic.
  cost: 0,
  build: ({ inputs, fn }) => ({ out: fn.construct(MAT3, inputs["m"]) }),
});

/**
 * The object's world (model) matrix as a mat4 source, reading the `modelMatrix` builtin - Three's
 * uniform in render, the emitter's `matrixWorld` in behavior. Transforms object-space into world space.
 */
export const fxWorldMatrix = defineNode({
  type: "world-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {},
  outputs: { out: { type: "mat4" } },
  params: {},
  // A builtin read, no arithmetic.
  cost: 0,
  reads: ["modelMatrix"],
  build: ({ target }) => ({ out: target.read("modelMatrix") }),
});

/**
 * The inverse of the world matrix (world -> object space), as `inverse(modelMatrix)`. Nothing
 * supplies an inverse-model uniform, so it is derived - in behavior the kernel hoists it once per
 * call (`modelMatrix` is particle-invariant), not per particle.
 */
export const fxInverseWorldMatrix = defineNode({
  type: "inverse-world-matrix",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "matrix",
  inputs: {},
  outputs: { out: { type: "mat4" } },
  params: {},
  cost: MATRIX_INVERSE_COST[4],
  reads: ["modelMatrix"],
  build: ({ target, fn }) => ({ out: fn.call("inverse", target.read("modelMatrix")) }),
});

/**
 * The object's world-space linear velocity (units/second), reading the `objectVelocity` builtin -
 * derived once per tick from the emitter/mesh's `matrixWorld`, never from (emitter-local) `PARTICLE_POSITION`.
 */
export const fxObjectVelocity = defineNode({
  type: "object-velocity",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "vec3" } },
  params: {},
  // A builtin read, no arithmetic.
  cost: 0,
  reads: ["objectVelocity"],
  build: ({ target }) => ({ out: target.read("objectVelocity") }),
});

/**
 * The object's world-space torque (rotation axis * radians/second - an angular velocity, not a
 * moment of force), reading the `objectAngularVelocity` builtin. See {@link fxObjectVelocity} for
 * the world-vs-local composition note.
 */
export const fxObjectAngularVelocity = defineNode({
  type: "object-angular-velocity",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "vec3" } },
  params: {},
  cost: 0,
  reads: ["objectAngularVelocity"],
  build: ({ target }) => ({ out: target.read("objectAngularVelocity") }),
});

/**
 * The world-space velocity of a point rigidly attached to the object at `offset` from its origin:
 * `velocity + cross(torque, offset)`. `offset` must be world-space (no conversion performed here)
 * - a local `PARTICLE_POSITION` offset needs converting first, or the cross product is meaningless.
 */
export const fxObjectPointVelocity = defineNode({
  type: "point-velocity",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "source",
  inputs: {
    velocity: { type: "vec3", default: { targetInput: "objectVelocity" } },
    torque: { type: "vec3", default: { targetInput: "objectAngularVelocity" } },
    offset: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { out: { type: "vec3" } },
  params: {},
  // cross (9: 6 multiplies + 3 subtracts) + vec3 add (3).
  cost: 12,
  build: ({ inputs, fn }) => ({
    out: fn.add(inputs["velocity"], fn.call("cross", inputs["torque"], inputs["offset"])),
  }),
});

/**
 * The world->view matrix as a mat4 source, reading the `viewMatrix` builtin (render-only: the
 * behavior target has no camera). Authoring stays in world; this is for explicit transforms
 * into the view space the runtime shades in.
 */
export const fxViewMatrix = defineNode({
  type: "view-matrix",
  domain: "render",
  stage: "param",
  category: "matrix",
  inputs: {},
  outputs: { out: { type: "mat4" } },
  params: {},
  // A builtin read, no arithmetic.
  cost: 0,
  reads: ["viewMatrix"],
  build: ({ target }) => ({ out: target.read("viewMatrix") }),
});

/** The inverse of the view matrix (view -> world space), as `inverse(viewMatrix)`. Render-only. */
export const fxInverseViewMatrix = defineNode({
  type: "inverse-view-matrix",
  domain: "render",
  stage: "param",
  category: "matrix",
  inputs: {},
  outputs: { out: { type: "mat4" } },
  params: {},
  cost: MATRIX_INVERSE_COST[4],
  reads: ["viewMatrix"],
  build: ({ target, fn }) => ({ out: fn.call("inverse", target.read("viewMatrix")) }),
});

/** All standard render matrix node definitions. */
export const FX_RENDER_MATRIX_NODES: readonly FXNodeDefinition[] = [
  fxRotationMatrix,
  fxEulerToRotation,
  fxAlignToVelocity,
  fxScaleMatrix,
  fxCombineMat2,
  fxCombineMat3,
  fxCombineMat4,
  fxSplitMat2,
  fxSplitMat3,
  fxSplitMat4,
  fxTranslationMatrix,
  fxMatrixMultiply,
  fxTranspose,
  fxInverse,
  fxDeterminant,
  fxTransformPoint,
  fxTransformDirection,
  fxNormalMatrix,
  fxMatrixToMat3,
  fxWorldMatrix,
  fxInverseWorldMatrix,
  fxObjectVelocity,
  fxObjectAngularVelocity,
  fxObjectPointVelocity,
  fxViewMatrix,
  fxInverseViewMatrix,
];
