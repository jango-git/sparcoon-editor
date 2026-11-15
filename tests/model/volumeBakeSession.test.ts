import { BoxGeometry, PlaneGeometry } from "three";
import { describe, expect, it } from "vitest";

import { createInitialState, type MeshAsset } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { VolumeBakeSession } from "../../src/model/volumeBakeSession";
import { bakeGeometryArrays } from "../../src/render/meshGeometryBaking";

const mesh = (name: string, geometry: BoxGeometry | PlaneGeometry): MeshAsset => ({
  name,
  label: name,
  geometry: bakeGeometryArrays(geometry),
  byteSize: 0,
});

function session(): { store: Store; bake: VolumeBakeSession; changes: () => number } {
  const store = new Store(createInitialState());
  const bake = new VolumeBakeSession(store);
  let changes = 0;
  bake.subscribe(() => changes++);
  return { store, bake, changes: () => changes };
}

describe("VolumeBakeSession", () => {
  it("starts from the mesh's defaults, solid for a closed mesh and a shell for an open one", () => {
    const { bake } = session();
    bake.start(mesh("Box", new BoxGeometry(1, 1, 1)));
    expect(bake.get()).toMatchObject({ closed: true, settings: { mode: "solid" }, level: 0 });
    bake.start(mesh("Plane", new PlaneGeometry(1, 1)));
    expect(bake.get()).toMatchObject({ closed: false, settings: { mode: "shell" } });
  });

  it("takes only sound settings, and drops a bake they no longer match", async () => {
    const { bake } = session();
    bake.start(mesh("Box", new BoxGeometry(1, 1, 1)));
    bake.setSettings({ resolution: 8 });
    await bake.runBake();
    expect(bake.get()?.baked?.size).toEqual([8, 8, 8]);
    bake.setSettings({ band: 0 });
    expect(bake.get()?.settings.band).toBeCloseTo(0.1, 6);
    expect(bake.get()?.baked).toBeDefined();
    bake.setSettings({ boxMax: [2, 2, 2] });
    expect(bake.get()?.baked).toBeUndefined();
    bake.fitBox();
    expect(bake.get()?.settings.boxMax[0]).toBeCloseTo(0.6, 6);
  });

  it("adds the bake to the library, which ends it", async () => {
    const { store, bake } = session();
    bake.start(mesh("Box", new BoxGeometry(1, 1, 1)));
    bake.setSettings({ resolution: 8 });
    await bake.runBake();
    await bake.addToLibrary();
    expect(store.getSource().volumeAssets.map((asset) => asset.name)).toEqual(["Box SDF"]);
    expect(bake.get()).toBeUndefined();
  });

  it("stops a bake under way when closed, and keeps nothing", async () => {
    const { store, bake, changes } = session();
    bake.start(mesh("Box", new BoxGeometry(1, 1, 1)));
    const running = bake.runBake();
    bake.close();
    await running;
    expect(bake.get()).toBeUndefined();
    expect(store.getSource().volumeAssets).toEqual([]);
    expect(changes()).toBeGreaterThan(0);
  });
});
