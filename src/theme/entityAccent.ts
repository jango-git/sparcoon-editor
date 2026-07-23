/** Per-entity-kind accent hue - the one source of the "each object type has its own color" data.
 *  Mirrored by hand into the CSS `--hue-emitter/group/mesh` tokens (tokens.css); the 3D selection
 *  gizmo reads it directly (see emitterMarker). */
export type EntityAccentKind = "vfx" | "emitter" | "vfxMesh";

// emitter shares the base accent hue (28); the VFX group is green, a mesh is blue - matching the
// timeline row accents.
export const ENTITY_ACCENT_HUE: Record<EntityAccentKind, number> = {
  emitter: 28,
  vfx: 150,
  vfxMesh: 212,
};

export const ENTITY_ACCENT_SATURATION = 0.9;
export const ENTITY_ACCENT_LIGHTNESS = 0.58;
