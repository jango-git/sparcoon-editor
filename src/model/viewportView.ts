/**
 * The viewport camera as a project stores it: where it is, the point it orbits and looks at, and
 * its vertical field of view in degrees. It is kept outside the document and its undo history.
 */

import { isFiniteNumber, isRecord } from "../util/guards";

export interface ViewportView {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fov: number;
}

/** The camera a project without a stored one opens with. */
export const DEFAULT_VIEWPORT_VIEW: ViewportView = {
  position: [0, 2, 7],
  target: [0, 0, 0],
  fov: 50,
};

/** `raw` as a view, or `undefined` when any part of it is missing or invalid. */
export function readViewportView(raw: unknown): ViewportView | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const position = readVector(raw["position"]);
  const target = readVector(raw["target"]);
  const fov = raw["fov"];
  if (position === undefined || target === undefined || !isViewportFov(fov)) {
    return undefined;
  }
  return { position, target, fov };
}

/** Whether `fov` is a vertical field of view a perspective camera can take: within (0, 180) degrees. */
export function isViewportFov(fov: unknown): fov is number {
  return isFiniteNumber(fov) && fov > 0 && fov < 180;
}

function readVector(raw: unknown): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(isFiniteNumber)) {
    return undefined;
  }
  return [raw[0] as number, raw[1] as number, raw[2] as number];
}
