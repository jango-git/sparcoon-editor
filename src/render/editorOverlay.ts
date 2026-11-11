/**
 * The editor's own scene furniture - grid, player figure, object gizmos, transform guides - lives on
 * a dedicated three.js layer, apart from the effect itself; the studio ground on a layer of its
 * own, as it is also what shadows fall on and a Depth Fade fades against. The viewport camera
 * renders every layer; a clean capture renders the effect layer, and the ground's when asked to.
 * Each piece of furniture marks itself where it is created, so nothing has to keep a list of them.
 */

import type { Object3D } from "three";

/** The layer editor-only objects render on (the effect stays on three's default layer 0). */
export const EDITOR_OVERLAY_LAYER = 1;

/** The layer the studio ground renders on. */
export const EDITOR_GROUND_LAYER = 2;

/** Moves `object` and everything under it onto the editor overlay layer. */
export function markEditorOverlay(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_OVERLAY_LAYER));
}

/** Moves `object` and everything under it onto the ground layer. */
export function markEditorGround(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_GROUND_LAYER));
}
