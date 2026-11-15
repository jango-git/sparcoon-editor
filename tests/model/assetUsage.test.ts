import { describe, expect, it } from "vitest";

import { RENDER_SINK_ID } from "../../src/domain/sinkMeta";
import {
  addCatalogNode,
  addVolumeAsset,
  updateNodeParam,
  updateNodeParams,
} from "../../src/model/commands";
import type { VolumeAsset } from "../../src/model/editorState";
import { selectAssetUsage } from "../../src/model/selectors";
import { Store } from "../../src/model/store";
import { createTestState } from "../helpers/testDocument";

const ROCK: VolumeAsset = {
  name: "Rock SDF",
  label: "Rock SDF",
  dataUrl: "",
  size: [4, 4, 4],
  boxMin: [-2, -1, -1],
  boxMax: [2, 1, 1],
  scale: 0.5,
  bias: -0.25,
};

function storeWithRock(): Store {
  const store = new Store(createTestState());
  addVolumeAsset(store, ROCK);
  return store;
}

function sdfNode(store: Store): string {
  const id = addCatalogNode(store, "behaviorGraph", "sdf-sample", { x: 0, y: 0 });
  expect(id).toBeDefined();
  return id as string;
}

const parametersOf = (store: Store, id: string): Readonly<Record<string, unknown>> =>
  store.getSource().scene.emitters[0]?.behaviorGraph.nodes[id]?.parameters ?? {};

describe("picking a volume", () => {
  it("sets the inputs its bake describes, in the same undo step", () => {
    const store = storeWithRock();
    const id = sdfNode(store);
    updateNodeParam(store, "behaviorGraph", id, "volume", "Rock SDF");
    expect(parametersOf(store, id)).toMatchObject({
      volume: "Rock SDF",
      boxMin: [-2, -1, -1],
      boxMax: [2, 1, 1],
      scale: 0.5,
      bias: -0.25,
    });
    store.undo();
    expect(parametersOf(store, id)["volume"]).toBeUndefined();
    expect(parametersOf(store, id)["boxMin"]).toBeUndefined();
  });

  it("keeps what the same edit sets, and sets nothing for a volume the library lacks", () => {
    const store = storeWithRock();
    const id = sdfNode(store);
    updateNodeParams(store, "behaviorGraph", id, { volume: "Rock SDF", scale: 3 });
    expect(parametersOf(store, id)).toMatchObject({ scale: 3, bias: -0.25 });
    const other = sdfNode(store);
    updateNodeParam(store, "behaviorGraph", other, "volume", "Missing");
    expect(parametersOf(store, other)["boxMin"]).toBeUndefined();
  });
});

describe("selectAssetUsage", () => {
  it("counts the nodes picking each asset, and a mesh drawn as the particles' geometry", () => {
    const store = storeWithRock();
    updateNodeParam(store, "behaviorGraph", sdfNode(store), "volume", "Rock SDF");
    updateNodeParam(store, "behaviorGraph", sdfNode(store), "volume", "Rock SDF");
    const point = addCatalogNode(store, "behaviorGraph", "random-mesh-point", { x: 0, y: 0 });
    updateNodeParam(store, "behaviorGraph", point as string, "mesh", "Rock");
    updateNodeParam(store, "renderGraph", RENDER_SINK_ID, "geometry", "mesh:Rock");
    expect(selectAssetUsage(store, "volume")).toEqual(new Map([["Rock SDF", 2]]));
    expect(selectAssetUsage(store, "mesh")).toEqual(new Map([["Rock", 2]]));
  });
});
