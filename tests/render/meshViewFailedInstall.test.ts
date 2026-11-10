import { afterEach, describe, expect, it, vi } from "vitest";
import { FXMesh } from "sparcoon/editor";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { createTestState } from "../helpers/testDocument";
import {
  addCatalogNode,
  addVfxMesh,
  connectSockets,
  disconnectInput,
  toggleVfxMeshHidden,
  updateNodeParam,
} from "../../src/model/commands";
import { RENDER_SINK_ID } from "../../src/domain/nodePalette";
import { createPreview, destroyPreviews } from "../helpers/previewScene";

afterEach(() => {
  vi.restoreAllMocks();
  destroyPreviews();
});

describe("SceneEmitters: what the scene depth pre-pass is asked", () => {
  it("follows a mute toggle, which reaches the views without a sync", () => {
    const store = new Store(createTestState(), new SignalBus());
    const emitters = createPreview();
    const id = addVfxMesh(store);
    wireDepthFade(store);
    emitters.sync(store.getSource().scene);
    expect(emitters.readsSceneDepth()).toBe(true);

    toggleVfxMeshHidden(store, id);
    emitters.applySceneTransforms(store.getSource().scene, 0);
    expect(emitters.readsSceneDepth()).toBe(false);
    toggleVfxMeshHidden(store, id);
    emitters.applySceneTransforms(store.getSource().scene, 0);
    expect(emitters.readsSceneDepth()).toBe(true);
  });
});

/** albedo = vec4(0, 0, 0, Depth Fade) in the active render graph; returns the combine node. */
function wireDepthFade(store: Store): string {
  const fade = addCatalogNode(store, "renderGraph", "depth-fade", { x: 0, y: 0 })!;
  const rgba = addCatalogNode(store, "renderGraph", "combine", { x: 0, y: 100 })!;
  updateNodeParam(store, "renderGraph", rgba, "type", "vec4");
  connectSockets(
    store,
    "renderGraph",
    { nodeId: fade, socketKey: "fade" },
    { nodeId: rgba, socketKey: "w" },
  );
  connectSockets(
    store,
    "renderGraph",
    { nodeId: rgba, socketKey: "out" },
    { nodeId: RENDER_SINK_ID, socketKey: "albedo" },
  );
  return rgba;
}

describe("MeshView: a rebuild the runtime refuses", () => {
  it("keeps describing the mesh still running, not the artifact it refused", () => {
    const store = new Store(createTestState(), new SignalBus());
    const emitters = createPreview();
    addVfxMesh(store);
    const rgba = wireDepthFade(store);
    emitters.sync(store.getSource().scene);
    expect(emitters.readsSceneDepth()).toBe(true);

    // The next build fails, so the faded mesh stays up - and is what the depth pre-pass serves.
    vi.spyOn(FXMesh, "fromArtifact").mockImplementation(() => {
      throw new Error("refused");
    });
    disconnectInput(store, "renderGraph", { nodeId: rgba, socketKey: "w" });
    emitters.sync(store.getSource().scene);
    expect(emitters.readsSceneDepth()).toBe(true);
  });
});
