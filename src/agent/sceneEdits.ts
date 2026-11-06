/**
 * Scene-level agent edits: emitters and VFX meshes as objects (add, remove, rename, hide) and the
 * base transform of any entity, the VFX group's included.
 */

import {
  addEmitter,
  addVfxMesh,
  removeEmitter,
  removeVfxMesh,
  renameEmitter,
  renameVfxMesh,
  setEntityBaseChannel,
  toggleEmitterHidden,
  toggleVfxMeshHidden,
} from "../model/commands";
import { canRemoveObject } from "../model/editorState";
import { eulerToQuat } from "../model/transform";
import { requireKnownKeys, requireVector3 } from "./arguments.Internal";
import { resolveEntity, resolveOwner } from "./address.Internal";
import { AgentError } from "./errors";
import type { EditSession } from "./transaction.Internal";
import { sceneView, type SceneView } from "./views";

export interface TransformPatch {
  readonly position?: readonly number[];
  /** Euler angles in degrees, XYZ order. */
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}

export interface SceneEdits {
  get(): SceneView;
  /** Adds an emitter with the editor's starter graphs and one burst; it becomes active. */
  addEmitter(): string;
  /** Adds a VFX mesh (a plane with a flat material); it becomes active. */
  addMesh(): string;
  /**
   * Removes an emitter or mesh. An effect of meshes only (or emitters only) is fine; the scene's
   * last object cannot be removed.
   */
  remove(ownerId: string): void;
  /** Renames an emitter or mesh. The project (the VFX group's name) is `project.setName`. */
  rename(ownerId: string, name: string): void;
  setHidden(ownerId: string, hidden: boolean): void;
  /** Sets the base (un-keyframed) transform channels given; the others stay as they are. */
  setTransform(entityId: string, patch: TransformPatch): void;
}

export function createSceneEdits(session: EditSession): SceneEdits {
  return {
    get: () => sceneView(session.source()),

    addEmitter: () => session.mutate((store) => addEmitter(store)),

    addMesh: () => session.mutate((store) => addVfxMesh(store)),

    remove: (ownerId) =>
      session.mutate((store) => {
        const source = store.getSource();
        const owner = resolveOwner(source, ownerId);
        if (!canRemoveObject(source.scene)) {
          throw new AgentError("rejected", "The scene's last object cannot be removed.");
        }
        if (owner.kind === "vfxMesh") {
          removeVfxMesh(store, owner.id);
        } else {
          removeEmitter(store, owner.id);
        }
      }),

    rename: (ownerId, name) =>
      session.mutate((store) => {
        const source = store.getSource();
        if (ownerId === source.scene.vfx.id) {
          throw new AgentError(
            "invalid_argument",
            "The VFX group carries the project's name; set it with project.setName.",
          );
        }
        const owner = resolveOwner(source, ownerId);
        if (name.trim() === "") {
          throw new AgentError("invalid_argument", "A name cannot be blank.");
        }
        if (owner.kind === "emitter") {
          renameEmitter(store, owner.id, name);
        } else {
          renameVfxMesh(store, owner.id, name);
        }
      }),

    setHidden: (ownerId, hidden) =>
      session.mutate((store) => {
        const scene = store.getSource().scene;
        const owner = resolveOwner(store.getSource(), ownerId);
        const current = [...scene.emitters, ...scene.meshes].find((entry) => entry.id === owner.id);
        if ((current?.hidden === true) === hidden) {
          return;
        }
        if (owner.kind === "emitter") {
          toggleEmitterHidden(store, owner.id);
        } else {
          toggleVfxMeshHidden(store, owner.id);
        }
      }),

    setTransform: (entityId, patch) =>
      session.mutate((store) => {
        requireKnownKeys("patch", patch, ["position", "rotation", "scale"]);
        const entity = resolveEntity(store.getSource(), entityId);
        if (patch.position !== undefined) {
          setEntityBaseChannel(
            store,
            entity,
            "position",
            requireVector3("position", patch.position),
          );
        }
        if (patch.rotation !== undefined) {
          const degrees = requireVector3("rotation", patch.rotation);
          setEntityBaseChannel(store, entity, "rotation", eulerToQuat(degrees));
        }
        if (patch.scale !== undefined) {
          setEntityBaseChannel(store, entity, "scale", requireVector3("scale", patch.scale));
        }
      }),
  };
}
