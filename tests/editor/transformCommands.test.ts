import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { emitterEntity, VFX_ENTITY } from "../../src/model/entity";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  insertTransformKeyframes,
  moveTransformKeyframes,
  removeTransformKeyframe,
  setEntityBaseChannel,
  setTransformKeyframe,
  setTransformKeyframeValue,
} from "../../src/model/commands";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

const emitterId = (store: Store): string => store.getSource().scene.emitters[0].id;

describe("setEntityBaseChannel", () => {
  it("sets the base transform and never keyframes, even when the channel is animated", () => {
    const store = freshStore();
    setEntityBaseChannel(store, VFX_ENTITY, "position", [1, 2, 3]);
    expect(store.getSource().scene.vfx.transform.position).toEqual([1, 2, 3]);
    expect(store.getSource().scene.vfx.transformTracks).toHaveLength(0);

    // Even with an existing key on the channel, a base edit must not add a keyframe.
    const entity = emitterEntity(emitterId(store));
    setTransformKeyframe(store, entity, "position", 0, [0, 0, 0]);
    setEntityBaseChannel(store, entity, "position", [5, 0, 0]);
    const emitter = store.getSource().scene.emitters[0];
    expect(emitter.transformTracks.find((t) => t.channel === "position")!.keys).toHaveLength(1);
    expect(emitter.transform.position).toEqual([5, 0, 0]);
  });

  it("targets the addressed emitter only", () => {
    const store = freshStore();
    const entity = emitterEntity(emitterId(store));
    setEntityBaseChannel(store, entity, "scale", [2, 2, 2]);
    expect(store.getSource().scene.emitters[0].transform.scale).toEqual([2, 2, 2]);
    expect(store.getSource().scene.vfx.transform.scale).toEqual([1, 1, 1]);
  });

  it("a live=true call applies the value but records no history entry", () => {
    const store = freshStore();
    setEntityBaseChannel(store, VFX_ENTITY, "position", [1, 0, 0], true);
    expect(store.getSource().scene.vfx.transform.position).toEqual([1, 0, 0]);
    expect(store.canUndo).toBe(false);
  });

  it("several live steps plus a final non-live commit record exactly one undo step", () => {
    const store = freshStore();
    setEntityBaseChannel(store, VFX_ENTITY, "position", [1, 0, 0], true);
    setEntityBaseChannel(store, VFX_ENTITY, "position", [2, 0, 0], true);
    setEntityBaseChannel(store, VFX_ENTITY, "position", [3, 0, 0], true);
    setEntityBaseChannel(store, VFX_ENTITY, "position", [3, 0, 0]);

    expect(store.getSource().scene.vfx.transform.position).toEqual([3, 0, 0]);
    store.undo();
    // One step back to the value from before the whole gesture, not to [2,0,0] or [1,0,0].
    expect(store.getSource().scene.vfx.transform.position).toEqual([0, 0, 0]);
    expect(store.canUndo).toBe(false);
  });
});

describe("insertTransformKeyframes", () => {
  it("bakes a key on each requested channel at the caret from the base transform", () => {
    const store = freshStore();
    setEntityBaseChannel(store, VFX_ENTITY, "position", [3, 0, 0]);
    setEntityBaseChannel(store, VFX_ENTITY, "scale", [2, 2, 2]);

    insertTransformKeyframes(store, VFX_ENTITY, 1, ["position", "rotation", "scale"]);

    const tracks = store.getSource().scene.vfx.transformTracks;
    const position = tracks.find((t) => t.channel === "position")!;
    const rotation = tracks.find((t) => t.channel === "rotation")!;
    const scale = tracks.find((t) => t.channel === "scale")!;
    expect(position.keys[0].value).toEqual([3, 0, 0]);
    expect(rotation.keys[0].value).toEqual([0, 0, 0, 1]);
    expect(scale.keys[0].value).toEqual([2, 2, 2]);
    expect(position.keys[0].time).toBe(1);
  });

  it("inserts only the requested channels", () => {
    const store = freshStore();
    insertTransformKeyframes(store, emitterEntity(emitterId(store)), 0, ["rotation"]);
    const tracks = store.getSource().scene.emitters[0].transformTracks;
    expect(tracks.map((t) => t.channel)).toEqual(["rotation"]);
  });

  it("overwrites (does not duplicate) a key inserted twice at the same frame", () => {
    const store = freshStore();
    setEntityBaseChannel(store, VFX_ENTITY, "position", [1, 0, 0]);
    insertTransformKeyframes(store, VFX_ENTITY, 2, ["position"]);
    insertTransformKeyframes(store, VFX_ENTITY, 2, ["position"]);

    const track = store
      .getSource()
      .scene.vfx.transformTracks.find((t) => t.channel === "position")!;
    expect(track.keys).toHaveLength(1);
    expect(track.keys[0].value).toEqual([1, 0, 0]);
  });
});

describe("transform keyframes", () => {
  it("replaces a key baked at the same time", () => {
    const store = freshStore();
    setTransformKeyframe(store, VFX_ENTITY, "position", 1, [0, 0, 0]);
    setTransformKeyframe(store, VFX_ENTITY, "position", 1, [9, 9, 9]);
    const track = store
      .getSource()
      .scene.vfx.transformTracks.find((t) => t.channel === "position")!;
    expect(track.keys).toHaveLength(1);
    expect(track.keys[0].value).toEqual([9, 9, 9]);
  });

  it("moves, edits and removes keys, dropping an empty channel track", () => {
    const store = freshStore();
    setTransformKeyframe(store, VFX_ENTITY, "position", 0, [0, 0, 0]);
    const keyId = store.getSource().scene.vfx.transformTracks[0].keys[0].id;

    setTransformKeyframeValue(store, VFX_ENTITY, keyId, [1, 1, 1]);
    expect(store.getSource().scene.vfx.transformTracks[0].keys[0].value).toEqual([1, 1, 1]);

    moveTransformKeyframes(store, VFX_ENTITY, [{ id: keyId, time: 2 }]);
    expect(store.getSource().scene.vfx.transformTracks[0].keys[0].time).toBe(2);

    removeTransformKeyframe(store, VFX_ENTITY, keyId);
    expect(store.getSource().scene.vfx.transformTracks).toHaveLength(0);
  });
});
