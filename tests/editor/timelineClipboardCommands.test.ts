import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addBurstEvent,
  addPlayEvent,
  addVfxMesh,
  clipboardItemTime,
  pasteTimelineItems,
  setKeyframe,
  setTransformKeyframe,
  type ClipboardTimelineItem,
} from "../../src/model/commands";
import { emitterEntity, vfxMeshEntity, VFX_ENTITY } from "../../src/model/entity";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());
const emitterId = (store: Store): string => store.getSource().scene.emitters[0].id;
const tracks = (store: Store) => store.getSource().scene.emitters[0].tracks;
const events = (store: Store) => store.getSource().scene.emitters[0].events;
const transformTracks = (store: Store) => store.getSource().scene.emitters[0].transformTracks;

// A fresh document's timeline is { duration: 5, fps: 30 }; the default emitter carries one burst
// event (`event_1` at t = 0).

describe("clipboardItemTime", () => {
  it("reads the common ordinate regardless of item kind", () => {
    const keyItem: ClipboardTimelineItem = {
      type: "key",
      entity: VFX_ENTITY,
      name: "size",
      time: 2,
      value: 1,
    };
    const eventItem: ClipboardTimelineItem = {
      type: "event",
      entity: emitterEntity("e1"),
      event: { id: "event_1", kind: "burst", time: 3, count: 1 },
    };
    expect(clipboardItemTime(keyItem)).toBe(2);
    expect(clipboardItemTime(eventItem)).toBe(3);
  });
});

describe("pasteTimelineItems", () => {
  it("is a strict no-op for an empty list", () => {
    const store = freshStore();
    const before = store.getSource();
    expect(pasteTimelineItems(store, [], 1)).toEqual([]);
    expect(store.getSource()).toBe(before);
  });

  it("pastes a Timeline Value key onto its named track, shifted and re-minted", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, emitterEntity(id), "size", 1, 4);
    const original = tracks(store)[0].keys[0];

    const pasted = pasteTimelineItems(
      store,
      [{ type: "key", entity: emitterEntity(id), name: "size", time: 1, value: 4 }],
      2, // offset: lands at time 3
    );

    expect(pasted).toEqual([{ entity: emitterEntity(id), kind: "key", id: pasted[0].id }]);
    expect(pasted[0].id).not.toBe(original.id);
    const keys = tracks(store)[0].keys;
    expect(keys.map((k) => k.time)).toEqual([1, 3]);
    expect(keys.find((k) => k.id === pasted[0].id)!.value).toBe(4);
  });

  it("pastes a transform key onto the VFX group, an emitter, and a mesh", () => {
    const store = freshStore();
    const emitter = emitterEntity(emitterId(store));
    const meshId = addVfxMesh(store);
    const mesh = vfxMeshEntity(meshId);

    const items: ClipboardTimelineItem[] = [
      { type: "transformKey", entity: VFX_ENTITY, channel: "position", time: 1, value: [1, 2, 3] },
      { type: "transformKey", entity: emitter, channel: "scale", time: 1, value: [2, 2, 2] },
      { type: "transformKey", entity: mesh, channel: "rotation", time: 1, value: [0, 0, 0, 1] },
    ];
    const pasted = pasteTimelineItems(store, items, 1); // lands at time 2

    expect(pasted.map((p) => p.channel)).toEqual(["position", "scale", "rotation"]);
    expect(store.getSource().scene.vfx.transformTracks[0].keys[0]).toMatchObject({
      time: 2,
      value: [1, 2, 3],
    });
    expect(transformTracks(store)[0]).toMatchObject({ channel: "scale" });
    expect(transformTracks(store)[0].keys[0]).toMatchObject({ time: 2, value: [2, 2, 2] });
    const pastedMesh = store.getSource().scene.meshes.find((m) => m.id === meshId)!;
    expect(pastedMesh.transformTracks[0]).toMatchObject({ channel: "rotation" });
  });

  it("pastes a spawn event onto its emitter, re-sorted and re-minted", () => {
    const store = freshStore();
    const id = emitterId(store);
    const burstId = addBurstEvent(store, id, 3, 5);
    const original = events(store).find((event) => event.id === burstId)!;

    const pasted = pasteTimelineItems(
      store,
      [{ type: "event", entity: emitterEntity(id), event: original }],
      -1, // lands at time 2
    );

    expect(pasted).toEqual([{ entity: emitterEntity(id), kind: "event", id: pasted[0].id }]);
    const list = events(store);
    expect(list.map((event) => event.time)).toEqual([0, 2, 3]); // re-sorted, original untouched
    const copy = list.find((event) => event.id === pasted[0].id)!;
    expect(copy).toMatchObject({ kind: "burst", count: 5 });
  });

  it("pastes a play event's rate/duration through unchanged, only the time shifts", () => {
    const store = freshStore();
    const id = emitterId(store);
    const playId = addPlayEvent(store, id, 1, 10, 2);
    const original = events(store).find((event) => event.id === playId)!;

    const pasted = pasteTimelineItems(
      store,
      [{ type: "event", entity: emitterEntity(id), event: original }],
      1,
    );

    const copy = events(store).find((event) => event.id === pasted[0].id)!;
    expect(copy).toMatchObject({ kind: "play", rate: 10, duration: 2, time: 2 });
  });

  it("keeps a whole batch as one commit, so undo removes everything it pasted", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, emitterEntity(id), "size", 1, 1);
    setTransformKeyframe(store, emitterEntity(id), "position", 1, [1, 1, 1]);
    const before = store.getSource();

    pasteTimelineItems(
      store,
      [
        { type: "key", entity: emitterEntity(id), name: "size", time: 1, value: 1 },
        {
          type: "transformKey",
          entity: emitterEntity(id),
          channel: "position",
          time: 1,
          value: [1, 1, 1],
        },
      ],
      1,
    );
    expect(tracks(store)[0].keys).toHaveLength(2);
    expect(transformTracks(store)[0].keys).toHaveLength(2);

    store.undo();
    expect(store.getSource()).toEqual(before);
  });

  it("drops an item whose entity was removed since it was copied", () => {
    const store = freshStore();
    const meshId = addVfxMesh(store);
    const mesh = vfxMeshEntity(meshId);
    setKeyframe(store, mesh, "opacity", 1, 1);
    const item: ClipboardTimelineItem = {
      type: "key",
      entity: mesh,
      name: "opacity",
      time: 1,
      value: 1,
    };
    // Remove the mesh entirely (simulating "copied, then the object was deleted").
    const source = store.getSource();
    store.commit({ ...source, scene: { ...source.scene, meshes: [] } }, "structural");

    expect(pasteTimelineItems(store, [item], 1)).toEqual([]);
    expect(store.getSource().scene.meshes).toEqual([]);
  });
});
