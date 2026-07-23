import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Shared render-only support for nodes that build a camera-facing rotation basis
 * (`align-to-velocity`, `look-at-camera`'s locked-axis branches): the two camera-direction
 * models, and the numerically robust "turn an axis toward a target direction while staying
 * orthogonal to a fixed axis" primitive both nodes need. Render-only - the behavior target has
 * no camera.
 */

const MAT3 = FX_VALUE_TYPES.mat3;

/**
 * `"parallel"`: one shared view-forward direction for every particle - exact under an
 * orthographic camera, the common cheap approximation under perspective. `"point"`: the true
 * per-particle direction to the camera, exact under perspective at the cost of a per-particle
 * position read.
 */
export const CAMERA_MODEL_PARAM = {
  kind: "structural",
  type: "enum",
  options: ["parallel", "point"],
  default: "parallel",
} as const satisfies FXParamSpec;

/** The builtins a node needs for the chosen {@link CAMERA_MODEL_PARAM} value. */
export function cameraModelReads(model: unknown): readonly string[] {
  return model === "point" ? ["PARTICLE_POSITION", "cameraPosition"] : ["viewMatrix"];
}

/**
 * Below this `sin(theta)` (theta = angle between a fixed axis and its target direction),
 * {@link orthogonalTowardTarget} blends toward its degeneracy-safe fallback instead of trusting
 * the direct construction - see that function's doc comment for why. Deliberately tiny (~0.06
 * degrees of `theta`, not the few degrees a first guess might reach for): the fallback direction
 * is an arbitrary, sweep-independent choice, so blending toward it can swing the result by up to
 * ~180 degrees over the transition (unavoidable - no continuous choice of this axis exists over
 * every possible approach direction, the same obstruction as the hairy ball theorem). Making the
 * transition this narrow does not remove that swing, it compresses it into a band of camera
 * movement far smaller than one rendered frame typically covers - imperceptible - while staying
 * roughly 1000x above float32's cross-product noise floor (~1e-6 for unit-vector operands),
 * comfortably clear of the numerical instability this whole primitive exists to avoid. Exported
 * so tests can sweep the exact boundary this constant defines.
 */
export const CAMERA_AXIS_DEGENERACY_THRESHOLD = 0.001;

/**
 * view-space `(0,0,1)` rotated to world - the shared camera-forward direction, the same for every
 * particle. Cheap approximation compared to {@link pointCameraDirection}.
 */
function parallelCameraDirection(
  target: { read: (name: string) => FXExpr },
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  const toWorld = local(
    "cam_tw",
    fn.call("transpose", fn.construct(MAT3, target.read("viewMatrix"))),
  );
  return local("cam_pd", fn.mul(toWorld, fn.litVec(0, 0, 1)));
}

/**
 * `normalize(cameraPosition - position)` - the true per-particle camera direction, accurate under
 * perspective unlike {@link parallelCameraDirection}'s parallel approximation. `position` is the
 * consuming node's own optional `position` input - `undefined` when left unwired, in which case
 * this falls back to reading `PARTICLE_POSITION` directly (kept a build-time fallback, not an
 * input-socket `targetInput` default, so a node placed on a target without `PARTICLE_POSITION`,
 * e.g. a VFX mesh, stays legal as long as it never resolves to the "point" model - see
 * `cameraModelReads`). Override it when the graph renders a particle somewhere other than its raw
 * simulated position (e.g. attached to the emitter via `fxTransformPoint(fxWorldMatrix, ...)`),
 * or this direction is computed from the wrong point.
 */
function pointCameraDirection(
  position: FXExpr | undefined,
  target: { read: (name: string) => FXExpr },
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  const effectivePosition = position ?? target.read("PARTICLE_POSITION");
  const toCamera = local("cam_tc", fn.sub(target.read("cameraPosition"), effectivePosition));
  const length = local("cam_l", fn.call("length", toCamera));
  const safeLength = fn.select(fn.eq(length, fn.lit(0)), fn.lit(1), length);
  return local("cam_pd", fn.div(toCamera, safeLength));
}

/** The world-space camera direction for the given {@link CAMERA_MODEL_PARAM} value. `position`
 *  feeds the "point" branch only - see {@link pointCameraDirection}. */
export function cameraDirectionForModel(
  model: string,
  position: FXExpr | undefined,
  target: { read: (name: string) => FXExpr },
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  return model === "point"
    ? pointCameraDirection(position, target, local, fn)
    : parallelCameraDirection(target, local, fn);
}

/**
 * A world axis never within ~2.5 degrees of parallel to `fixedAxis` (a unit vector): world Z,
 * unless `fixedAxis` is already that close to Z, in which case world X. Deterministic and
 * independent of the target direction, so {@link orthogonalTowardTarget}'s fallback agrees across
 * neighboring particles near the singularity instead of drifting with per-particle camera noise.
 */
function stableHelperAxis(fixedAxis: FXExpr, fn: FXExprBuilderApi): FXExpr {
  const closeToWorldZ = fn.lt(fn.call("abs", fn.swizzle(fixedAxis, "z")), fn.lit(0.999));
  return fn.select(closeToWorldZ, fn.litVec(0, 0, 1), fn.litVec(1, 0, 0));
}

/**
 * Turns an axis orthogonal to `fixedAxis` (a unit vector) as close to `targetDirection` as
 * possible - the shared primitive behind `align-to-velocity`'s camera-facing axis and
 * `look-at-camera`'s locked-axis branches (`axis: "all"` has no fixed axis and does not use this).
 *
 * No formula makes "targetDirection exactly parallel to fixedAxis" well-defined - no unique
 * orthogonal answer exists there, the same singularity as an up-vector parallel to a `lookAt`
 * camera's forward axis (and, deeper down, the same obstruction as the hairy ball theorem: no
 * choice of this axis can vary continuously over every possible approach direction at once). This
 * does not remove that singularity - nothing can - it replaces float-noise-dominated garbage
 * right at it with a deterministic, always-finite, always-orthogonal answer, compressed into a
 * band of `targetDirection` narrow enough that the transition itself is imperceptible (see
 * {@link CAMERA_AXIS_DEGENERACY_THRESHOLD}):
 *
 * - Built cross-then-cross (`derived = cross(fixedAxis, targetDirection)`, then
 *   `normalize(cross(derived, fixedAxis))`), not subtract-then-normalize Gram-Schmidt - one lossy
 *   step instead of a subtract-then-cross chain.
 * - `length(derived)` is `sin(theta)` - a legitimate degeneracy signal, not noise - `smoothstep`-
 *   blended against {@link stableHelperAxis}'s always-safe cross product (guaranteed >= ~0.045 in
 *   magnitude by construction) rather than gated by a hard branch, so nearby particles/frames
 *   agree with each other instead of a chaotic, per-particle-noise-dependent answer.
 */
export function orthogonalTowardTarget(
  fixedAxis: FXExpr,
  targetDirection: FXExpr,
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  const directCross = local("otc_d", fn.call("cross", fixedAxis, targetDirection));
  const confidence = local(
    "otc_c",
    fn.call(
      "smoothstep",
      fn.lit(0),
      fn.lit(CAMERA_AXIS_DEGENERACY_THRESHOLD),
      fn.call("length", directCross),
    ),
  );
  const fallbackCross = local(
    "otc_f",
    fn.call("cross", fixedAxis, stableHelperAxis(fixedAxis, fn)),
  );
  const blended = local("otc_b", fn.call("mix", fallbackCross, directCross, confidence));
  return fn.call("normalize", fn.call("cross", blended, fixedAxis));
}
