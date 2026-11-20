import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";

/**
 * Camera-direction models and `orthogonalTowardTarget`, shared by `align-to-velocity` and
 * `look-at-camera`. Render-only, the behavior target has no camera.
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
 * Below this `sin(theta)` (theta is the angle between the fixed axis and the target direction),
 * orthogonalTowardTarget blends toward a fallback axis. About 0.06 degrees, roughly 1000x the
 * float32 cross-product noise (~1e-6). The fallback is arbitrary, so the result can swing up to 180
 * degrees across the band, which is kept far narrower than one frame of camera movement. Exported
 * for tests.
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
 * `normalize(cameraPosition - position)`, exact under perspective. `position` defaults to
 * `PARTICLE_POSITION`, read at build time (not as a socket default) so a node on a target without
 * it, such as a VFX mesh, stays legal unless it resolves to "point". Pass it when the particle is
 * drawn away from its simulated position.
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
 * Axis orthogonal to unit `fixedAxis`, as close to `targetDirection` as possible. `derived =
 * cross(fixedAxis, targetDirection)`, result `normalize(cross(derived, fixedAxis))`.
 * `length(derived)` is `sin(theta)`. It `smoothstep`-blends toward `stableHelperAxis` x
 * `fixedAxis`, so nearby frames agree near the singularity (target parallel to the axis, where no
 * unique answer exists).
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
