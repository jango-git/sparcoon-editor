/**
 * Layers of the preview scene. Layer 0 is the effect. Editor furniture (grid, player figure,
 * transform guides), the gizmos and the scene around the effect (the studio ground or an uploaded
 * scene) each have their own layer, so the viewport and clean captures can show or hide them
 * separately. Each object marks itself where it is created.
 */

import type { Object3D } from "three";

export const EDITOR_OVERLAY_LAYER = 1;

/** The layer the scene around the effect renders on. */
export const EDITOR_SCENE_LAYER = 2;

/** The layer the object and sun gizmos render on. */
export const EDITOR_GIZMO_LAYER = 3;

export function markEditorOverlay(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_OVERLAY_LAYER));
}

export function markEditorScene(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_SCENE_LAYER));
}

export function markEditorGizmo(object: Object3D): void {
  object.traverse((child) => child.layers.set(EDITOR_GIZMO_LAYER));
}
