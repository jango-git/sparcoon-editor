/**
 * A scene entity the transform tools address: the VFX group, or one emitter/mesh by id. Selecting
 * an emitter/mesh also drives the graph editor (`activeEmitterId`/`activeMeshId`); the group has no id.
 */

export type SceneEntity =
  | { readonly kind: "vfx" }
  | { readonly kind: "emitter"; readonly id: string }
  | { readonly kind: "vfxMesh"; readonly id: string };

/** The VFX entity singleton (its id is fixed - there is exactly one group per scene). */
export const VFX_ENTITY: SceneEntity = { kind: "vfx" };

/** An emitter entity for `id`. */
export function emitterEntity(id: string): SceneEntity {
  return { kind: "emitter", id };
}

/** A VFX-mesh entity for `id`. */
export function vfxMeshEntity(id: string): SceneEntity {
  return { kind: "vfxMesh", id };
}

/** A stable string key for an entity (for Set/Map membership and selection compare). */
export function entityKey(entity: SceneEntity): string {
  switch (entity.kind) {
    case "vfx":
      return "vfx";
    case "emitter":
      return `emitter:${entity.id}`;
    case "vfxMesh":
      return `mesh:${entity.id}`;
  }
}

/** True when two entities refer to the same target. */
export function sameEntity(first: SceneEntity, second: SceneEntity): boolean {
  return entityKey(first) === entityKey(second);
}
