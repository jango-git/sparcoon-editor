import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { SelectionStore } from "../../src/model/selectionStore";
import {
  addAttribute,
  addCatalogNode,
  addVfxMesh,
  removeVfxMesh,
  selectEmitter,
} from "../../src/model/commands";
import {
  selectActiveEmitter,
  selectActiveGraphOwner,
  selectMeshes,
} from "../../src/model/selectors";
import { commitEntitySelection } from "../../src/ui/selection";
import { vfxMeshEntity } from "../../src/model/entity";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

/** Authored (non-sink) render-graph node count for the active emitter. */
function emitterRenderNodeCount(store: Store): number {
  return Object.keys(selectActiveEmitter(store).renderGraph.nodes).length;
}

describe("active graph owner (emitter vs mesh)", () => {
  it("adding a mesh makes it the active graph owner (render-only)", () => {
    const store = freshStore();
    expect(selectActiveGraphOwner(store).kind).toBe("emitter");

    const id = addVfxMesh(store);
    const owner = selectActiveGraphOwner(store);
    expect(owner.kind).toBe("vfxMesh");
    expect(owner.id).toBe(id);
    expect(owner.renderGraph).toBe(selectMeshes(store)[0].renderGraph);
  });

  it("routes graph edits to the active mesh's render graph, not an emitter", () => {
    const store = freshStore();
    const emitterNodesBefore = emitterRenderNodeCount(store);
    const meshId = addVfxMesh(store);
    const meshNodesBefore = Object.keys(selectMeshes(store)[0].renderGraph.nodes).length;

    addCatalogNode(store, "renderGraph", "constant", { x: 0, y: 0 });

    // The mesh graph grew; no emitter graph was touched.
    expect(Object.keys(selectMeshes(store)[0].renderGraph.nodes).length).toBe(meshNodesBefore + 1);
    expect(emitterRenderNodeCount(store)).toBe(emitterNodesBefore);
    expect(selectMeshes(store)[0].id).toBe(meshId);
  });

  it("routes graph edits back to the emitter once an emitter is reselected", () => {
    const store = freshStore();
    addVfxMesh(store);
    const emitterId = selectActiveEmitter(store).id;
    selectEmitter(store, emitterId);
    expect(selectActiveGraphOwner(store).kind).toBe("emitter");

    const before = emitterRenderNodeCount(store);
    addCatalogNode(store, "renderGraph", "constant", { x: 0, y: 0 });
    expect(emitterRenderNodeCount(store)).toBe(before + 1);
  });

  it("behavior-slot commands are inert while a VFX mesh owns the graph (render-only boundary)", () => {
    const store = freshStore();
    addVfxMesh(store);
    expect(selectActiveGraphOwner(store).kind).toBe("vfxMesh");
    const emitterBehaviorNodes = Object.keys(selectActiveEmitter(store).behaviorGraph.nodes).length;

    // A mesh is render-only: an attribute (a simulation->render channel it has no runtime for) is
    // rejected honestly, and a behavior-slot node add is a no-op - both target a graph the mesh lacks.
    expect(addAttribute(store, "behaviorGraph", "velocity", "vec3")).toBe(false);
    addCatalogNode(store, "behaviorGraph", "constant", { x: 0, y: 0 });

    expect(selectMeshes(store)[0].renderGraph.attributes).toEqual([]);
    // Neither the mesh nor the active emitter's behavior graph gained anything.
    expect(Object.keys(selectActiveEmitter(store).behaviorGraph.nodes).length).toBe(
      emitterBehaviorNodes,
    );
    expect(selectActiveEmitter(store).behaviorGraph.attributes).toEqual([]);
  });

  it("falls back to the emitter owner when the active mesh is removed", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    expect(selectActiveGraphOwner(store).kind).toBe("vfxMesh");
    removeVfxMesh(store, id);
    expect(selectActiveGraphOwner(store).kind).toBe("emitter");
    expect(store.getSource().scene.activeGraphKind).toBe("emitter");
  });

  it("commitEntitySelection on a mesh sets the persisted + transient selection", () => {
    const store = freshStore();
    const selection = new SelectionStore();
    const id = addVfxMesh(store);
    // Move focus to an emitter first, then commit a mesh selection.
    selectEmitter(store, selectActiveEmitter(store).id);
    expect(selectActiveGraphOwner(store).kind).toBe("emitter");

    commitEntitySelection(store, selection, vfxMeshEntity(id));

    expect(store.getSource().scene.activeGraphKind).toBe("vfxMesh");
    expect(store.getSource().scene.activeMeshId).toBe(id);
    expect(selection.get()).toEqual({ kind: "vfxMesh", id });
  });
});
