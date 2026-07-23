/**
 * Transform primitives shared by timeline/scene/gizmo (three-free, so this unit-tests as plain
 * math). Rotation is a quaternion (three's native form) edited as Euler degrees via {@link quatToEuler}/{@link eulerToQuat}, the sole conversion point.
 */

import type { Keyframe } from "./editorState";
import {
  normalizeQuaternion,
  quaternionFromValue,
  sampleTransform as sharedSampleTransform,
  slerpQuaternion,
  vectorFromValue,
} from "sparcoon/editor";

export type Vec3 = readonly [number, number, number];
/** A rotation quaternion in `[x, y, z, w]` order (three's component order). */
export type Quat = readonly [number, number, number, number];

/** One rigid transform: local position, rotation (quaternion) and per-axis scale. */
export interface Transform {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** The three animatable transform channels. `rotation` keyframes carry a quaternion. */
export type TransformChannel = "position" | "rotation" | "scale";

/** The transform channels in edit order - the canonical list keyframing and migration iterate. */
export const TRANSFORM_CHANNELS: readonly TransformChannel[] = ["position", "rotation", "scale"];

/**
 * The keyframes for one transform channel of an entity. Sparse - no keys means no track, falling
 * back to the entity's base {@link Transform}. "Live" (see `EmitterDoc.liveChannels`) is separate entity-level metadata, independent of track existence.
 */
export interface TransformTrack {
  readonly channel: TransformChannel;
  readonly keys: readonly Keyframe[];
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** The neutral transform: origin, no rotation, unit scale. */
export const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  rotation: IDENTITY_QUAT,
  scale: [1, 1, 1],
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Renormalizes a quaternion (a componentwise-lerped or hand-edited one drifts off the unit sphere). */
export function normalizeQuat(quat: Quat): Quat {
  return normalizeQuaternion(quat);
}

/** Euler angles in **degrees** (XYZ order) => a unit quaternion (matches three's `Euler`/`Quaternion`). */
export function eulerToQuat(degrees: Vec3): Quat {
  const x = degrees[0] * DEG2RAD * 0.5;
  const y = degrees[1] * DEG2RAD * 0.5;
  const z = degrees[2] * DEG2RAD * 0.5;
  const cosHalfX = Math.cos(x);
  const cosHalfY = Math.cos(y);
  const cosHalfZ = Math.cos(z);
  const sinHalfX = Math.sin(x);
  const sinHalfY = Math.sin(y);
  const sinHalfZ = Math.sin(z);
  return [
    sinHalfX * cosHalfY * cosHalfZ + cosHalfX * sinHalfY * sinHalfZ,
    cosHalfX * sinHalfY * cosHalfZ - sinHalfX * cosHalfY * sinHalfZ,
    cosHalfX * cosHalfY * sinHalfZ + sinHalfX * sinHalfY * cosHalfZ,
    cosHalfX * cosHalfY * cosHalfZ - sinHalfX * sinHalfY * sinHalfZ,
  ];
}

/** A unit quaternion => Euler angles in **degrees** (XYZ order), inverse of {@link eulerToQuat}. */
export function quatToEuler(quat: Quat): Vec3 {
  const [x, y, z, w] = normalizeQuat(quat);
  // Rotation-matrix elements (row-major, `p' = R.p`) needed for the XYZ decomposition.
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const clampedM13 = Math.min(1, Math.max(-1, m13));
  const eulerY = Math.asin(clampedM13);
  let eulerX: number;
  let eulerZ: number;
  if (Math.abs(m13) < 0.9999999) {
    eulerX = Math.atan2(-m23, m33);
    eulerZ = Math.atan2(-m12, m11);
  } else {
    // Near a pole (|m13| ~ 1): fold the free axis into X and pin Z, exactly as three does.
    eulerX = Math.atan2(m32, m22);
    eulerZ = 0;
  }
  return [eulerX * RAD2DEG, eulerY * RAD2DEG, eulerZ * RAD2DEG];
}

/** Spherical-linear blend of two quaternions at `factor in [0, 1]` (shortest arc). */
export function slerpQuat(quatA: Quat, quatB: Quat, factor: number): Quat {
  return slerpQuaternion(quatA, quatB, factor);
}

/** A keyframe value read as a vec3 (missing components default to 0). */
export function asVec3(value: number | readonly number[]): Vec3 {
  return vectorFromValue(value);
}

/** A keyframe value read as a quaternion, falling back to identity for a malformed value. */
export function asQuat(value: number | readonly number[]): Quat {
  return quaternionFromValue(value);
}

/**
 * The effective transform at `time`: a channel with keyframes samples its track, one without holds
 * `base`. So an un-animated transform is exactly `base`; animating one channel leaves others static.
 */
export function sampleTransform(
  base: Transform,
  tracks: readonly TransformTrack[],
  time: number,
): Transform {
  return sharedSampleTransform(base, tracks, time);
}
