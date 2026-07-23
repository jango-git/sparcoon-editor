import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import {
  addBurstEvent,
  addPlayEvent,
  moveEvents,
  moveTrackKeyframes,
  removeEvent,
  removeKeyframe,
  setKeyframe,
  setKeyframeValue,
  setTimelineDuration,
  setTimelineFps,
  updateEvent,
} from "../../src/model/commands";
import { emitterEntity } from "../../src/model/entity";
import type { PlayEvent } from "../../src/model/editorState";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());
const emitterId = (store: Store): string => store.getSource().scene.emitters[0].id;
const ent = (id: string) => emitterEntity(id);
const tracks = (store: Store) => store.getSource().scene.emitters[0].tracks;
const events = (store: Store) => store.getSource().scene.emitters[0].events;

// A fresh document's timeline is { duration: 5, fps: 30 }, so times snap to a 1/30 s grid and
// clamp to [0, 5]. The default emitter already carries one burst event, `event_1` at t = 0.

describe("setKeyframe", () => {
  it("creates a track on the first key, keyed by param name", () => {
    const store = freshStore();
    setKeyframe(store, ent(emitterId(store)), "size", 1, 4);
    expect(tracks(store)).toHaveLength(1);
    expect(tracks(store)[0].name).toBe("size");
    expect(tracks(store)[0].keys).toEqual([expect.objectContaining({ time: 1, value: 4 })]);
  });

  it("keeps keys sorted by time and replaces a key baked at the same time", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "size", 2, 20);
    setKeyframe(store, ent(id), "size", 1, 10);
    setKeyframe(store, ent(id), "size", 2, 99); // overwrites the t=2 key, not a duplicate
    const keys = tracks(store)[0].keys;
    expect(keys.map((k) => k.time)).toEqual([1, 2]);
    expect(keys[1].value).toBe(99);
  });

  it("snaps the time to the frame grid and clamps into [0, duration]", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "a", 0.01, 1); // 0.01s -> under half a frame -> snaps to 0
    setKeyframe(store, ent(id), "b", 100, 1); // past the end -> clamped to duration (5)
    expect(tracks(store).find((t) => t.name === "a")!.keys[0].time).toBe(0);
    expect(tracks(store).find((t) => t.name === "b")!.keys[0].time).toBe(5);
  });

  it("stores a copy of an array value, never aliasing the caller's array", () => {
    const store = freshStore();
    const live = [1, 2, 3];
    setKeyframe(store, ent(emitterId(store)), "color", 1, live);
    live[0] = 99;
    expect(tracks(store)[0].keys[0].value).toEqual([1, 2, 3]);
  });
});

describe("removeKeyframe / setKeyframeValue", () => {
  it("removes a key by id and drops a track left empty", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "size", 1, 1);
    const keyId = tracks(store)[0].keys[0].id;
    removeKeyframe(store, ent(id), keyId);
    expect(tracks(store)).toHaveLength(0);
  });

  it("sets a key's value in place", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "size", 1, 1);
    const keyId = tracks(store)[0].keys[0].id;
    setKeyframeValue(store, ent(id), keyId, 7);
    expect(tracks(store)[0].keys[0].value).toBe(7);
  });
});

describe("timeline events", () => {
  it("adds a burst sorted by time, clamps count, and returns its id", () => {
    const store = freshStore();
    const newId = addBurstEvent(store, emitterId(store), 3, 5.7);
    const list = events(store);
    expect(list.map((e) => e.time)).toEqual([0, 3]); // sorted after the default burst at t=0
    const added = list.find((e) => e.id === newId)!;
    expect(added.kind).toBe("burst");
    expect((added as { count: number }).count).toBe(6); // rounded and floored at 0
  });

  it("adds a play event with snapped duration and clamped rate", () => {
    const store = freshStore();
    const newId = addPlayEvent(store, emitterId(store), 1, -5, 2);
    const added = events(store).find((e) => e.id === newId) as PlayEvent;
    expect(added.kind).toBe("play");
    expect(added.rate).toBe(0); // negative rate clamped
    expect(added.duration).toBe(2);
  });

  it("patches only the fields valid for the event kind and re-sorts", () => {
    const store = freshStore();
    const id = emitterId(store);
    const burstId = addBurstEvent(store, id, 1, 10);
    // A play-only field (rate) is ignored on a burst; count/time apply.
    updateEvent(store, id, burstId, { time: 4, count: 3, rate: 99 });
    const burst = events(store).find((e) => e.id === burstId) as { time: number; count: number };
    expect(burst.time).toBe(4);
    expect(burst.count).toBe(3);
    expect(events(store).map((e) => e.time)).toEqual([0, 4]); // re-sorted
    expect((burst as Record<string, unknown>)["rate"]).toBeUndefined();
  });

  it("removes an event by id", () => {
    const store = freshStore();
    const id = emitterId(store);
    const evId = addBurstEvent(store, id, 2, 1);
    removeEvent(store, id, evId);
    expect(events(store).some((e) => e.id === evId)).toBe(false);
  });
});

describe("moveTrackKeyframes / moveEvents", () => {
  it("retimes keys and events, snapping and re-sorting", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "size", 1, 1);
    setKeyframe(store, ent(id), "size", 3, 3);
    const keyA = tracks(store)[0].keys.find((k) => k.time === 1)!.id;
    const defaultBurst = events(store)[0].id; // event_1 at t=0

    moveTrackKeyframes(store, ent(id), [{ id: keyA, time: 4 }]); // move the t=1 key past the t=3 key
    moveEvents(store, id, [{ id: defaultBurst, time: 2 }]);

    expect(tracks(store)[0].keys.map((k) => k.time)).toEqual([3, 4]); // re-sorted
    expect(events(store).find((e) => e.id === defaultBurst)!.time).toBe(2);
  });

  it("is a strict no-op when given no moves, and ignores unknown ids", () => {
    const store = freshStore();
    const id = emitterId(store);
    setKeyframe(store, ent(id), "size", 1, 1);
    // No moves -> commits nothing, so the source object is untouched.
    const before = store.getSource();
    moveTrackKeyframes(store, ent(id), []);
    moveEvents(store, id, []);
    expect(store.getSource()).toBe(before);
    // A move naming only unknown ids leaves every existing time as it was.
    moveTrackKeyframes(store, ent(id), [{ id: "missing", time: 2 }]);
    expect(store.getSource().scene.emitters[0].tracks[0].keys[0].time).toBe(1);
  });
});

describe("setTimelineDuration / setTimelineFps", () => {
  it("floors the duration and ignores a non-finite value", () => {
    const store = freshStore();
    setTimelineDuration(store, 0.01); // below the 0.1 minimum
    expect(store.getSource().timeline.duration).toBe(0.1);
    const snapshot = store.getSource();
    setTimelineDuration(store, Number.NaN);
    expect(store.getSource()).toBe(snapshot); // still a true no-op

    // An unchanged value is NOT special-cased as a no-op (unlike a `live` call - see the next
    // test): a non-live call always commits, since it may be the final commit of a live gesture
    // whose value already matches what live steps applied, and that commit must never be dropped.
    setTimelineDuration(store, 0.1);
    expect(store.getSource().timeline.duration).toBe(0.1);
    expect(store.getSource()).not.toBe(snapshot);
  });

  it("rounds fps to a whole number and floors it at 1", () => {
    const store = freshStore();
    setTimelineFps(store, 23.6);
    expect(store.getSource().timeline.fps).toBe(24);
    setTimelineFps(store, 0);
    expect(store.getSource().timeline.fps).toBe(1);
  });

  it("live=true applies the value without recording history; a final non-live call commits once", () => {
    const store = freshStore();
    setTimelineDuration(store, 2, true);
    setTimelineDuration(store, 3, true);
    setTimelineDuration(store, 4, true);
    setTimelineDuration(store, 4);

    expect(store.getSource().timeline.duration).toBe(4);
    store.undo();
    // One step back to the duration from before the whole drag (5, the fresh document's default).
    expect(store.getSource().timeline.duration).toBe(5);
  });
});
