/** VFX mesh edits. A mesh has only a render graph, and a scene may hold zero meshes. */

import {
  canRemoveObject,
  createDefaultVfxMesh,
  type SceneModel,
  type VfxMeshDoc,
} from "../editorState";
import type { Store } from "../store";
import { withFreshIds } from "./emitterCommands";
import { nextIdentifier } from "./identifier";

function commitScene(store: Store, scene: SceneModel, kind: "structural" | "view"): void {
  store.commit({ ...store.getSource(), scene }, kind);
}

/**
 * Adds a fresh VFX mesh (a plane with a minimal visible material, its own freshly-minted node ids)
 * to the end of the scene and makes it the active mesh. Returns the new mesh's id.
 */
export function addVfxMesh(store: Store): string {
  const scene = store.getSource().scene;
  const id = nextIdentifier("mesh");
  const seed = createDefaultVfxMesh(id, uniqueName(scene.meshes));
  const mesh: VfxMeshDoc = { ...seed, renderGraph: withFreshIds(seed.renderGraph) };
  commitScene(
    store,
    { ...scene, meshes: [...scene.meshes, mesh], activeMeshId: id, activeGraphKind: "vfxMesh" },
    "structural",
  );
  return id;
}

/**
 * Removes VFX mesh `id`. Removing an unknown id is a no-op. The scene may end with no meshes; if the
 * removed mesh was active, focus falls to its neighbour (the previous mesh, the new head, or none).
 */
export function removeVfxMesh(store: Store, id: string): void {
  const scene = store.getSource().scene;
  if (!canRemoveObject(scene)) {
    return;
  }
  const index = scene.meshes.findIndex((mesh) => mesh.id === id);
  if (index === -1) {
    return;
  }
  const meshes = scene.meshes.filter((mesh) => mesh.id !== id);
  const activeMeshId =
    scene.activeMeshId === id ? (meshes[index - 1] ?? meshes[0])?.id : scene.activeMeshId;
  // If the graph editor was on this mesh and no mesh remains active, hand graph focus back to the
  // active emitter so the canvas has a valid owner.
  const activeGraphKind =
    scene.activeGraphKind === "vfxMesh" && activeMeshId === undefined
      ? "emitter"
      : scene.activeGraphKind;
  commitScene(store, { ...scene, meshes, activeMeshId, activeGraphKind }, "structural");
}

/** Toggles mesh `id`'s preview visibility. Editor-only, so a view edit. */
export function toggleVfxMeshHidden(store: Store, id: string): void {
  const scene = store.getSource().scene;
  if (!scene.meshes.some((mesh) => mesh.id === id)) {
    return;
  }
  commitScene(
    store,
    {
      ...scene,
      meshes: scene.meshes.map((mesh) =>
        mesh.id === id ? { ...mesh, hidden: mesh.hidden !== true } : mesh,
      ),
    },
    "view",
  );
}

/**
 * Targets mesh `id` for graph editing and preview focus (also makes the mesh the active graph
 * owner). No-op if it is already the active mesh owner or the id is unknown.
 */
export function selectVfxMesh(store: Store, id: string): void {
  const scene = store.getSource().scene;
  const alreadyActive = scene.activeMeshId === id && scene.activeGraphKind === "vfxMesh";
  if (alreadyActive || !scene.meshes.some((mesh) => mesh.id === id)) {
    return;
  }
  commitScene(store, { ...scene, activeMeshId: id, activeGraphKind: "vfxMesh" }, "structural");
}

/** Renames mesh `id`. A blank name is a no-op. */
export function renameVfxMesh(store: Store, id: string, name: string): void {
  const trimmed = name.trim();
  const scene = store.getSource().scene;
  if (trimmed === "" || !scene.meshes.some((mesh) => mesh.id === id)) {
    return;
  }
  commitScene(
    store,
    {
      ...scene,
      meshes: scene.meshes.map((mesh) => (mesh.id === id ? { ...mesh, name: trimmed } : mesh)),
    },
    "view",
  );
}

function uniqueName(meshes: readonly VfxMeshDoc[]): string {
  const taken = new Set(meshes.map((mesh) => mesh.name));
  if (!taken.has("Mesh")) {
    return "Mesh";
  }
  let suffix = 2;
  while (taken.has(`Mesh ${suffix}`)) {
    suffix += 1;
  }
  return `Mesh ${suffix}`;
}
