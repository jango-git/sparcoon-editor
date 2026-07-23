import { describe, expect, it } from "vitest";
import type { Mesh } from "three";
import { BufferGeometry, PerspectiveCamera, Scene, Texture, type WebGLRenderer } from "three";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { createTestState } from "../helpers/testDocument";
import {
  addVfxMesh,
  removeVfxMesh,
  setEntityBaseChannel,
  setTransformKeyframe,
  updateNodeParam,
} from "../../src/model/commands";
import { vfxMeshEntity } from "../../src/model/entity";
import { RENDER_SINK_ID } from "../../src/domain/nodePalette";
import { SceneEmitters } from "../../src/render/sceneEmitters";

// A VFX mesh is render-only (no behavior graph, no GPU simulation), so a shape stub covering
// the only property ever read (capabilities.isWebGL2) is enough - matches this headless suite's
// no-real-WebGL policy (tests/setup.ts).
const STUB_RENDERER = { capabilities: { isWebGL2: false } } as unknown as WebGLRenderer;

function harness(): { store: Store; emitters: SceneEmitters } {
  const store = new Store(createTestState(), new SignalBus());
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const emitters = new SceneEmitters(
    scene,
    () => new Texture(),
    camera,
    STUB_RENDERER,
    "baseline",
    () => 0,
  );
  return { store, emitters };
}

/** Like {@link harness}, but with a caller-controlled mesh-geometry resolver (mutate `geometries`
 *  between `sync()` calls to simulate the content library changing). */
function harnessWithMeshGeometries(): {
  store: Store;
  emitters: SceneEmitters;
  geometries: Record<string, BufferGeometry>;
} {
  const store = new Store(createTestState(), new SignalBus());
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const geometries: Record<string, BufferGeometry> = {};
  const emitters = new SceneEmitters(
    scene,
    () => new Texture(),
    camera,
    STUB_RENDERER,
    "baseline",
    () => 0,
    () => geometries,
  );
  return { store, emitters, geometries };
}

describe("SceneEmitters: VFX mesh views", () => {
  it("builds a Mesh Object3D for a mesh doc, resolvable by its entity", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);

    emitters.sync(store.getSource().scene);

    const object = emitters.entityObject(vfxMeshEntity(id));
    // `.isMesh`, not `instanceof Mesh`: sparcoon resolves its own `three` copy (a separate
    // node_modules install), so a class-identity check across the package boundary is unreliable -
    // the same reason the geometry checks below use `.type` instead of `instanceof PlaneGeometry`.
    expect((object as { isMesh?: boolean } | undefined)?.isMesh).toBe(true);
    // The mesh is parented under the VFX group (its marker rides it as a child).
    expect(object!.parent?.name).toBe("VFX");
  });

  it("poses the mesh from its base transform", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);
    setEntityBaseChannel(store, vfxMeshEntity(id), "position", [2, -1, 4]);

    emitters.sync(store.getSource().scene);

    const object = emitters.entityObject(vfxMeshEntity(id))!;
    expect([object.position.x, object.position.y, object.position.z]).toEqual([2, -1, 4]);
  });

  it("samples an animated transform track at the caret time", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);
    // A keyframe at frame 0 moving the mesh to x=5; the harness caret sits at t=0.
    setTransformKeyframe(store, vfxMeshEntity(id), "position", 0, [5, 0, 0]);

    emitters.sync(store.getSource().scene);

    const object = emitters.entityObject(vfxMeshEntity(id))!;
    expect([object.position.x, object.position.y, object.position.z]).toEqual([5, 0, 0]);
  });

  it("holds a manually posed entity at its base until the pose is cleared", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);
    // Animate the position so the timeline sample (x=5) differs from any later base edit.
    setTransformKeyframe(store, vfxMeshEntity(id), "position", 0, [5, 0, 0]);
    emitters.sync(store.getSource().scene);
    const object = emitters.entityObject(vfxMeshEntity(id))!;
    expect(object.position.x).toBe(5);

    // A parked manual pose (gizmo base commit) must stick, not snap back to the timeline sample.
    emitters.markManualPose(vfxMeshEntity(id));
    setEntityBaseChannel(store, vfxMeshEntity(id), "position", [1, 2, 3]);
    emitters.applySceneTransforms(store.getSource().scene, 0);
    expect([object.position.x, object.position.y, object.position.z]).toEqual([1, 2, 3]);

    // A frame entry clears the manual pose and the timeline reasserts.
    emitters.clearManualPoses();
    emitters.applySceneTransforms(store.getSource().scene, 0);
    expect(object.position.x).toBe(5);
  });

  it("reports a rebuild on first sync and a rebind on an unchanged re-sync", () => {
    const { store, emitters } = harness();
    // First sync builds the emitter view from nothing - a genuine recompile.
    expect(emitters.sync(store.getSource().scene).recompiled).toBe(true);
    // Re-syncing the identical scene only rebinds - it must not read as a rebuild (no restart).
    expect(emitters.sync(store.getSource().scene).recompiled).toBe(false);
  });

  it("prunes the mesh Object3D when the mesh is removed", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);
    emitters.sync(store.getSource().scene);
    const built = emitters.entityObject(vfxMeshEntity(id)) as { isMesh?: boolean } | undefined;
    expect(built?.isMesh).toBe(true);

    removeVfxMesh(store, id);
    emitters.sync(store.getSource().scene);

    expect(emitters.entityObject(vfxMeshEntity(id))).toBeUndefined();
  });

  it("selecting a mesh entity highlights only its marker (no throw, kind routed)", () => {
    const { store, emitters } = harness();
    const id = addVfxMesh(store);
    emitters.sync(store.getSource().scene);
    expect(() => emitters.setSelected(vfxMeshEntity(id))).not.toThrow();
  });
});

describe("SceneEmitters: custom mesh-asset geometry", () => {
  it("renders the resolved custom geometry, and falls back to the plane primitive when the referenced mesh asset is deleted - even with no other structural edit", () => {
    const { store, emitters, geometries } = harnessWithMeshGeometries();
    const id = addVfxMesh(store);
    const wheel = new BufferGeometry();
    geometries["wheel"] = wheel;

    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, "geometry", "mesh:wheel");
    emitters.sync(store.getSource().scene);
    expect((emitters.entityObject(vfxMeshEntity(id)) as Mesh).geometry).toBe(wheel);

    // Delete the asset from the resolver (mirrors MeshGeometryRegistry.sync dropping it on
    // removeMeshAsset) - the graph's own `geometry` param string is untouched, so only the
    // resolved-reference tracking (not the encoded key) can catch this.
    delete geometries["wheel"];
    emitters.sync(store.getSource().scene);
    // `.type`, not `instanceof PlaneGeometry`: sparcoon resolves its own `three` copy (a separate
    // node_modules install), so a class-identity check across the package boundary is unreliable -
    // the same reason the runtime itself duck-types via `isTexture`/`isBufferGeometry`.
    expect((emitters.entityObject(vfxMeshEntity(id)) as Mesh).geometry.type).toBe("PlaneGeometry");
  });

  it("rebuilds when the same-named mesh asset is replaced with different baked geometry", () => {
    const { store, emitters, geometries } = harnessWithMeshGeometries();
    const id = addVfxMesh(store);
    const first = new BufferGeometry();
    geometries["wheel"] = first;
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, "geometry", "mesh:wheel");
    emitters.sync(store.getSource().scene);
    expect((emitters.entityObject(vfxMeshEntity(id)) as Mesh).geometry).toBe(first);

    // A re-upload replaces the cached object at the same name (MeshGeometryRegistry.sync builds a
    // fresh BufferGeometry whenever the baked source changed).
    const second = new BufferGeometry();
    geometries["wheel"] = second;
    emitters.sync(store.getSource().scene);
    expect((emitters.entityObject(vfxMeshEntity(id)) as Mesh).geometry).toBe(second);
  });
});
