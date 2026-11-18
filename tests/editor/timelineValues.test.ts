import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../src/domain/graphModel";
import {
  addNode,
  addVfxMesh,
  removeNode,
  setEmitterStrip,
  setKeyframe,
  setLiveParam,
} from "../../src/model/commands";
import { createInitialState } from "../../src/model/editorState";
import { emitterEntity, vfxMeshEntity } from "../../src/model/entity";
import { Store } from "../../src/model/store";
import { normalizeSource } from "../../src/persistence/loadState";

const freshStore = (): Store => new Store(createInitialState());
const emitter = (store: Store) => store.getSource().scene.emitters[0];

const timelineValue = (id: string, name: string): GraphNode => ({
  id,
  type: "timeline-value",
  parameters: { name, value: 1 },
  position: { x: 0, y: 0 },
});

describe("a Timeline Value's keyframes and live flag", () => {
  it("go with the last node declaring the name", () => {
    const store = freshStore();
    const id = emitter(store).id;
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    addNode(store, "behaviorGraph", timelineValue("tv2", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    setLiveParam(store, emitterEntity(id), "size", true);

    removeNode(store, "renderGraph", "tv1");
    expect(emitter(store).liveParams).toEqual(["size"]);
    removeNode(store, "behaviorGraph", "tv2");
    expect(emitter(store).tracks).toEqual([]);
    expect(emitter(store).liveParams).toEqual([]);
  });

  it("go with a mesh's node", () => {
    const store = freshStore();
    const id = addVfxMesh(store);
    addNode(store, "renderGraph", timelineValue("tv1", "glow"));
    setKeyframe(store, vfxMeshEntity(id), "glow", 0, 2);
    setLiveParam(store, vfxMeshEntity(id), "glow", true);

    removeNode(store, "renderGraph", "tv1");
    const mesh = store.getSource().scene.meshes.find((candidate) => candidate.id === id)!;
    expect(mesh.tracks).toEqual([]);
    expect(mesh.liveParams).toEqual([]);
  });

  it("go with a strip that is turned off", () => {
    const store = freshStore();
    const id = emitter(store).id;
    setEmitterStrip(store, id, "trail", true);
    addNode(store, "trailGraph", timelineValue("tv1", "width"));
    setLiveParam(store, emitterEntity(id), "width", true);

    setEmitterStrip(store, id, "trail", false);
    expect(emitter(store).liveParams).toEqual([]);
  });

  it("are dropped on load where no node declares the name", () => {
    const store = freshStore();
    const id = emitter(store).id;
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    setLiveParam(store, emitterEntity(id), "size", true);
    const raw = JSON.parse(JSON.stringify(store.getSource()));
    raw.scene.emitters[0].liveParams.push("gone");
    raw.scene.emitters[0].tracks.push({
      name: "gone",
      keys: [{ id: "key_gone", time: 0, value: 1 }],
    });

    const loaded = normalizeSource(raw)!.scene.emitters[0];
    expect(loaded.liveParams).toEqual(["size"]);
    expect(loaded.tracks.map((track) => track.name)).toEqual(["size"]);
  });
});
