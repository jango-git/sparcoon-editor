/**
 * Scene-level agent edits: emitters and VFX meshes as objects (add, remove, rename, hide), base
 * transforms of any entity, and the project name, which the editor shows as the VFX root's name.
 */

import {
  addEmitter,
  addVfxMesh,
  removeEmitter,
  removeVfxMesh,
  renameEmitter,
  renameVfxMesh,
  setEntityBaseChannel,
  setProjectName,
  toggleEmitterHidden,
  toggleVfxMeshHidden,
} from "../model/commands";
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
  /** Removes an emitter or mesh. The last emitter cannot be removed. */
  remove(ownerId: string): void;
  /** Renames an emitter or mesh; the VFX group's id renames the project. */
  rename(entityId: string, name: string): void;
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
        if (owner.kind === "vfxMesh") {
          removeVfxMesh(store, owner.id);
          return;
        }
        if (source.scene.emitters.length <= 1) {
          throw new AgentError("rejected", "The last emitter cannot be removed.");
        }
        removeEmitter(store, owner.id);
      }),

    rename: (entityId, name) =>
      session.mutate((store) => {
        const entity = resolveEntity(store.getSource(), entityId);
        if (entity.kind === "vfx") {
          setProjectName(store, name);
          return;
        }
        if (name.trim() === "") {
          throw new AgentError("invalid_argument", "A name cannot be blank.");
        }
        if (entity.kind === "emitter") {
          renameEmitter(store, entity.id, name);
        } else {
          renameVfxMesh(store, entity.id, name);
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
