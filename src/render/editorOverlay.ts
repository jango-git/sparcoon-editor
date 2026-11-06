/**
 * The editor's own scene furniture - ground, grid, player figure, object gizmos, transform guides -
 * lives on a dedicated three.js layer, apart from the effect itself. The viewport camera renders
 * both layers; a clean capture renders the effect layer alone. Each piece of furniture marks
 * itself where it is created, so nothing has to keep a list of them.
 */

import type { Object3D } from "three";

/** The layer editor-only objects render on (the effect stays on three's default layer 0). */
export const EDITOR_OVERLAY_LAYER = 1;

/** Moves `object` and everything under it onto the editor overlay layer. */
export function markEditorOverlay(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_OVERLAY_LAYER));
}
