import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../src/domain/graphModel";
import {
  addNode,
  replaceNodeParams,
  setKeyframe,
  setLiveParam,
  updateNodeParam,
} from "../../src/model/commands";
import { createInitialState } from "../../src/model/editorState";
import { emitterEntity } from "../../src/model/entity";
import { Store } from "../../src/model/store";

const freshStore = (): Store => new Store(createInitialState());
const emitterId = (store: Store): string => store.getSource().scene.emitters[0].id;
const tracks = (store: Store) => store.getSource().scene.emitters[0].tracks;
const trackNames = (store: Store): string[] => tracks(store).map((track) => track.name);
const keyValues = (store: Store, name: string): (number | readonly number[])[] =>
  tracks(store)
    .find((track) => track.name === name)!
    .keys.map((key) => key.value);

const timelineValue = (id: string, name: string): GraphNode => ({
  id,
  type: "timeline-value",
  parameters: { name, value: 1 },
  position: { x: 0, y: 0 },
});

describe("renaming a timeline-value node migrates its animation track", () => {
  it("carries the track (with its keyframes) to the new name via updateNodeParam", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    setKeyframe(store, emitterEntity(id), "size", 1, 9);

    updateNodeParam(store, "renderGraph", "tv1", "name", "scale");

    expect(trackNames(store)).toEqual(["scale"]);
    expect(keyValues(store, "scale")).toEqual([5, 9]);
  });

  it("also migrates when the rename goes through replaceNodeParams", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 3);

    const newId = replaceNodeParams(store, "renderGraph", "tv1", { name: "scale" });

    expect(newId).toBeDefined();
    expect(trackNames(store)).toEqual(["scale"]);
    expect(keyValues(store, "scale")).toEqual([3]);
  });

  it("is a no-op when the name is unchanged", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    updateNodeParam(store, "renderGraph", "tv1", "name", "size");
    expect(trackNames(store)).toEqual(["size"]);
  });

  it("never touches tracks when a non-timeline-value node carries a `name` (e.g. texture)", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    addNode(store, "renderGraph", {
      id: "tex1",
      type: "texture",
      parameters: { name: "size" }, // same string, but a texture ref - drives no track
      position: { x: 0, y: 0 },
    });
    updateNodeParam(store, "renderGraph", "tex1", "name", "spark");
    expect(trackNames(store)).toEqual(["size"]);
  });

  it("joins a name another node declares, keeping that name's keyframes", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    addNode(store, "behaviorGraph", timelineValue("tv2", "glow"));
    setKeyframe(store, emitterEntity(id), "size", 0, 1);
    setKeyframe(store, emitterEntity(id), "glow", 0, 7);
    updateNodeParam(store, "renderGraph", "tv1", "name", "glow");
    expect(trackNames(store)).toEqual(["glow"]);
    expect(keyValues(store, "glow")).toEqual([7]);
  });

  it("leaves the keyframes and live flag with a name another node still reads", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    addNode(store, "behaviorGraph", timelineValue("tv2", "size"));
    setKeyframe(store, emitterEntity(id), "size", 0, 5);
    setLiveParam(store, emitterEntity(id), "size", true);
    updateNodeParam(store, "renderGraph", "tv1", "name", "scale");
    expect(trackNames(store)).toEqual(["size"]);
    expect(store.getSource().scene.emitters[0].liveParams).toEqual(["size"]);
  });

  it("carries the live flag with the name", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size"));
    setLiveParam(store, emitterEntity(id), "size", true);
    updateNodeParam(store, "renderGraph", "tv1", "name", "scale");
    expect(store.getSource().scene.emitters[0].liveParams).toEqual(["scale"]);
  });

  it("leaves an existing destination track alone when the renamed node had no track", () => {
    const store = freshStore();
    const id = emitterId(store);
    addNode(store, "renderGraph", timelineValue("tv1", "size")); // never keyframed
    setKeyframe(store, emitterEntity(id), "glow", 0, 7);
    updateNodeParam(store, "renderGraph", "tv1", "name", "glow");
    expect(keyValues(store, "glow")).toEqual([7]);
  });
});
