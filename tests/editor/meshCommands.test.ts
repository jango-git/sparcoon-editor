import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { isSink } from "../../src/domain/sinks";
import { readRenderSinkConfig, RENDER_SINK_ID } from "../../src/domain/nodePalette";
import {
  addVfxMesh,
  moveTrackKeyframes,
  removeVfxMesh,
  removeKeyframe,
  renameVfxMesh,
  selectVfxMesh,
  setEntityBaseChannel,
  setKeyframe,
  updateNodeParam,
} from "../../src/model/commands";
import { selectActiveMesh, selectActiveMeshId, selectMeshes } from "../../src/model/selectors";
import { vfxMeshEntity } from "../../src/model/entity";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

/** The authored (non-sink) node ids across a mesh's render graph. */
function authoredNodeIds(store: Store, id: string): string[] {
  const mesh = selectMeshes(store).find((candidate) => candidate.id === id)!;
  return Object.values(mesh.renderGraph.nodes)
    .filter((node) => !isSink(node))
    .map((node) => node.id);
}

describe("VFX mesh commands", () => {
  it("starts with no meshes and no active mesh", () => {
    const store = freshStore();
    expect(selectMeshes(store)).toHaveLength(0);
    expect(selectActiveMeshId(store)).toBeUndefined();
  });

  it("addVfxMesh appends a fresh mesh and makes it active", () => {
    const store = freshStore();
    const id = addVfxMesh(store);

    const meshes = selectMeshes(store);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].id).toBe(id);
    expect(meshes[0].name).toBe("Mesh");
    // Geometry lives on the surface sink now (unified with emitters), defaulting to "plane".
    expect(readRenderSinkConfig(meshes[0].renderGraph).geometry).toEqual({
      kind: "primitive",
      primitive: "plane",
    });
    expect(selectActiveMeshId(store)).toBe(id);
    // A render graph with its sink, no behavior graph field.
    expect(meshes[0].renderGraph.outputBindings.length).toBeGreaterThan(0);
  });

  it("names successive meshes Mesh, Mesh 2, ... and gives each fresh node ids", () => {
    const store = freshStore();
    const first = addVfxMesh(store);
    const second = addVfxMesh(store);
    expect(selectMeshes(store)[1].name).toBe("Mesh 2");

    const firstAuthored = authoredNodeIds(store, first);
    const secondAuthored = authoredNodeIds(store, second);
    expect(secondAuthored.length).toBeGreaterThan(0);
    for (const id of secondAuthored) {
      expect(firstAuthored).not.toContain(id);
    }
  });

  it("removeVfxMesh can empty the scene and clears the active mesh", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    removeVfxMesh(store, id);
    expect(selectMeshes(store)).toHaveLength(0);
    expect(selectActiveMeshId(store)).toBeUndefined();
  });

  it("removeVfxMesh moves focus to the neighbour when the active mesh is removed", () => {
    const store = freshStore();
    const first = addVfxMesh(store);
    const second = addVfxMesh(store);
    expect(selectActiveMeshId(store)).toBe(second);
    removeVfxMesh(store, second);
    expect(selectMeshes(store)).toHaveLength(1);
    expect(selectActiveMeshId(store)).toBe(first);
  });

  it("selectVfxMesh targets an existing mesh and ignores unknown ids", () => {
    const store = freshStore();
    const first = addVfxMesh(store);
    const second = addVfxMesh(store);
    selectVfxMesh(store, first);
    expect(selectActiveMeshId(store)).toBe(first);
    selectVfxMesh(store, "nope");
    expect(selectActiveMeshId(store)).toBe(first);
    expect(second).not.toBe(first);
  });

  it("renameVfxMesh renames and rejects a blank name", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    renameVfxMesh(store, id, "Shield");
    expect(selectMeshes(store)[0].name).toBe("Shield");
    renameVfxMesh(store, id, "   ");
    expect(selectMeshes(store)[0].name).toBe("Shield");
  });

  it("the surface sink's geometry param drives the rendered primitive", () => {
    const store = freshStore();
    addVfxMesh(store);
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, "geometry", "sphere");
    expect(readRenderSinkConfig(selectMeshes(store)[0].renderGraph).geometry).toEqual({
      kind: "primitive",
      primitive: "sphere",
    });
  });

  it("transform commands pose a mesh via its entity", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    setEntityBaseChannel(store, vfxMeshEntity(id), "position", [1, 2, 3]);
    expect(selectActiveMesh(store)!.transform.position).toEqual([1, 2, 3]);
  });

  it("Timeline Value keyframe commands target the mesh's own tracks", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    const entity = vfxMeshEntity(id);

    setKeyframe(store, entity, "tint", 1, [1, 0, 0, 1]);
    let tracks = selectMeshes(store)[0].tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe("tint");
    const keyId = tracks[0].keys[0].id;

    moveTrackKeyframes(store, entity, [{ id: keyId, time: 3 }]);
    expect(selectMeshes(store)[0].tracks[0].keys[0].time).toBe(3);

    removeKeyframe(store, entity, keyId);
    tracks = selectMeshes(store)[0].tracks;
    expect(tracks).toHaveLength(0);
  });
});
