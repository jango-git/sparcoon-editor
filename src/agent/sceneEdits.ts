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
  setEmitterStrip,
  setEntityBaseChannel,
  toggleEmitterHidden,
  toggleVfxMeshHidden,
} from "../model/commands";
import { canRemoveObject } from "../model/editorState";
import type { StripName } from "../model/graphSlots";
import type { Store } from "../model/store";
import { eulerToQuat } from "../model/transform";
import { resolveEntity, resolveOwner } from "./address.Internal";
import { requireKnownKeys, requireVector3 } from "./arguments.Internal";
import { AgentError } from "./errors";
import type { EditSession } from "./transaction.Internal";
import { type SceneView, sceneView } from "./views";

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
  /**
   * Hides an emitter or mesh from the viewport, or shows it again: the timeline's eye. A project
   * edit, saved and undoable like the others.
   */
  setHidden(ownerId: string, hidden: boolean): void;
  /**
   * Turns an emitter's trail on (a band behind every particle, authored in its `"trail"` graph,
   * seeded with a flat color) or off (the trail graph is dropped). A trail cannot be combined with
   * depth sorting.
   */
  setTrail(emitterId: string, enabled: boolean): void;
  /**
   * Turns an emitter's ribbon on (a band through its particles in the order they were born,
   * authored in its `"ribbon"` graph, seeded with a flat color) or off (the ribbon graph is
   * dropped). A ribbon cannot be combined with depth sorting, and follows one stream of births:
   * bursts of several particles and reactions weave it between them. Its UV, and whether the
   * particles themselves are drawn (`drawParticles` on the render graph's surface sink), are sink
   * parameters.
   */
  setRibbon(emitterId: string, enabled: boolean): void;
  /** Sets the base (un-keyframed) transform channels given; the others stay as they are. */
  setTransform(entityId: string, patch: TransformPatch): void;
}

/** Turns `emitterId`'s `strip` on or off. */
function setStrip(store: Store, emitterId: string, strip: StripName, enabled: boolean): void {
  const owner = resolveOwner(store.getSource(), emitterId);
  if (owner.kind !== "emitter") {
    throw new AgentError("invalid_argument", `"${emitterId}" is not an emitter.`);
  }
  setEmitterStrip(store, owner.id, strip, enabled);
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

    setTrail: (emitterId, enabled) =>
      session.mutate((store) => {
        setStrip(store, emitterId, "trail", enabled);
      }),

    setRibbon: (emitterId, enabled) =>
      session.mutate((store) => {
        setStrip(store, emitterId, "ribbon", enabled);
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
