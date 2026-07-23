/**
 * The one place the transform editor's quaternion<->Euler policy lives: rotation is stored as a
 * quaternion but shown/edited everywhere (tooltips, inspector, N-panel) as Euler degrees, so the
 * policy can't drift between them.
 */

import type { ChannelValue } from "../../model/commands";
import {
  asQuat,
  asVec3,
  eulerToQuat,
  quatToEuler,
  type TransformChannel,
  type Vec3,
} from "../../model/transform";

/** A channel's value in its edited form: rotation as Euler degrees (X, Y, Z), position/scale raw. */
export function channelToDisplay(
  channel: TransformChannel,
  value: number | readonly number[],
): Vec3 {
  return channel === "rotation" ? quatToEuler(asQuat(value)) : asVec3(value);
}

/** Recomposes a channel value from its edited vector (Euler degrees -> quaternion for rotation). */
export function channelFromDisplay(
  channel: TransformChannel,
  values: readonly number[],
): ChannelValue {
  const [x, y, z] = values;
  if (x === undefined || y === undefined || z === undefined) {
    throw new Error("Expected exactly three vector components (x, y, z)");
  }
  const vector: Vec3 = [x, y, z];
  return channel === "rotation" ? eulerToQuat(vector) : vector;
}
