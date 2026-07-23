/**
 * Timeline edits (keyframes on Timeline Value tracks, timeline length). All commit `"view"` -
 * authoring data that never reaches the compiler, so it's saved/undoable but never recompiles.
 */

import type {
  AnimationTrack,
  EmitterDoc,
  Keyframe,
  SourceState,
  TimelineEvent,
} from "../editorState";
import type { SceneEntity } from "../entity";
import { snapTimeToFrame } from "../frames";
import {
  cloneValue,
  removeKeyById,
  retimeKeys,
  setKeyValueById,
  snapTime,
  withKey,
} from "../keyframeTrackOps";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";

/** Defaults a new event carries until the author edits it. */
const DEFAULT_BURST_COUNT = 32;
const DEFAULT_PLAY_RATE = 20;
/** Also the duration a play event's infinite toggle restores when switched back off. */
export const DEFAULT_PLAY_DURATION = 1;

/** The shortest a timeline may be, so the playhead always has a range to run over. */
const MIN_DURATION = 0.1;
/** The slowest frame rate the timeline may run at. */
const MIN_FPS = 1;

/** A duration (seconds) snapped to a whole number of frames, floored at 0. */
function snapDuration(source: SourceState, seconds: number): number {
  return Math.max(0, snapTimeToFrame(seconds, source.timeline.fps));
}

/** Commits `next`, live (no history entry - an intermediate drag step) or not. */
function commitSource(store: Store, next: SourceState, live: boolean): void {
  if (live) {
    store.commitLive(next, "view");
  } else {
    store.commit(next, "view");
  }
}

/** Commits `emitters` as the scene's new emitter list, leaving the rest of the document intact. */
function commitEmitters(store: Store, emitters: readonly EmitterDoc[], live = false): void {
  const source = store.getSource();
  commitSource(store, { ...source, scene: { ...source.scene, emitters } }, live);
}

/**
 * Replaces `entity`'s Timeline Value tracks via `update`, committing the result. `entity` is an
 * emitter or VFX mesh (the VFX group has no tracks, so it's a no-op); also a no-op for an unknown id.
 * `live: true` (an intermediate step of a scrub/drag control) commits through `Store.commitLive`
 * instead, so a whole drag gesture costs undo history exactly one entry, not one per step.
 */
function updateTracks(
  store: Store,
  entity: SceneEntity,
  update: (tracks: readonly AnimationTrack[]) => readonly AnimationTrack[],
  live = false,
): void {
  const source = store.getSource();
  const scene = source.scene;
  if (entity.kind === "emitter") {
    if (!scene.emitters.some((emitter) => emitter.id === entity.id)) {
      return;
    }
    const emitters = scene.emitters.map((emitter) =>
      emitter.id === entity.id ? { ...emitter, tracks: update(emitter.tracks) } : emitter,
    );
    commitSource(store, { ...source, scene: { ...scene, emitters } }, live);
    return;
  }
  if (entity.kind === "vfxMesh") {
    if (!scene.meshes.some((mesh) => mesh.id === entity.id)) {
      return;
    }
    const meshes = scene.meshes.map((mesh) =>
      mesh.id === entity.id ? { ...mesh, tracks: update(mesh.tracks) } : mesh,
    );
    commitSource(store, { ...source, scene: { ...scene, meshes } }, live);
  }
}

/**
 * Bakes Timeline Value `name` = `value` at time `time` on `entity`'s track (creating it on first
 * key, overwriting any key already at `time`). The `I`-key action; `value` is the node's
 * snapshotted default.
 */
export function setKeyframe(
  store: Store,
  entity: SceneEntity,
  name: string,
  time: number,
  value: number | readonly number[],
): void {
  const key: Keyframe = {
    id: nextIdentifier("key"),
    time: snapTime(store.getSource(), time),
    value: cloneValue(value),
  };
  updateTracks(store, entity, (tracks) => {
    const existing = tracks.find((track) => track.name === name);
    if (existing === undefined) {
      return [...tracks, { name, keys: [key] }];
    }
    return tracks.map((track) =>
      track.name === name ? { ...track, keys: withKey(track.keys, key) } : track,
    );
  });
}

/**
 * Removes keyframe `keyId` from `entity`'s tracks. A track left with no keys is dropped (and its
 * orphaned uniform reverts). No-op if nothing matches.
 */
export function removeKeyframe(store: Store, entity: SceneEntity, keyId: string): void {
  updateTracks(store, entity, (tracks) => removeKeyById(tracks, keyId));
}

/** Sets keyframe `keyId`'s value in place (the inspector's value editor). No-op if unknown. */
export function setKeyframeValue(
  store: Store,
  entity: SceneEntity,
  keyId: string,
  value: number | readonly number[],
  live = false,
): void {
  updateTracks(store, entity, (tracks) => setKeyValueById(tracks, keyId, cloneValue(value)), live);
}

/** Adds/removes `name` from a live-params list, keeping it deduped. */
function withLiveParam(names: readonly string[], name: string, live: boolean): readonly string[] {
  const without = names.filter((candidate) => candidate !== name);
  return live ? [...without, name] : without;
}

/**
 * Marks Timeline Value `name` "live" (excluded from the TS export, see `EmitterDoc.liveParams`) or
 * not, on `entity` - independent of whether it has any keyframes. No-op for the VFX group (no tracks).
 */
export function setLiveParam(store: Store, entity: SceneEntity, name: string, live: boolean): void {
  const source = store.getSource();
  const scene = source.scene;
  if (entity.kind === "emitter") {
    if (!scene.emitters.some((emitter) => emitter.id === entity.id)) {
      return;
    }
    const emitters = scene.emitters.map((emitter) =>
      emitter.id === entity.id
        ? { ...emitter, liveParams: withLiveParam(emitter.liveParams, name, live) }
        : emitter,
    );
    store.commit({ ...source, scene: { ...scene, emitters } }, "view");
    return;
  }
  if (entity.kind !== "vfxMesh" || !scene.meshes.some((mesh) => mesh.id === entity.id)) {
    return;
  }
  const meshes = scene.meshes.map((mesh) =>
    mesh.id === entity.id
      ? { ...mesh, liveParams: withLiveParam(mesh.liveParams, name, live) }
      : mesh,
  );
  store.commit({ ...source, scene: { ...scene, meshes } }, "view");
}

/** Replaces emitter `id`'s events via `update`, committing the result. No-op for an unknown id. */
function updateEvents(
  store: Store,
  id: string,
  update: (events: readonly TimelineEvent[]) => readonly TimelineEvent[],
  live = false,
): void {
  const { emitters } = store.getSource().scene;
  if (!emitters.some((emitter) => emitter.id === id)) {
    return;
  }
  commitEmitters(
    store,
    emitters.map((emitter) =>
      emitter.id === id ? { ...emitter, events: update(emitter.events) } : emitter,
    ),
    live,
  );
}

/** Keeps the events list ordered by time, so the dispatcher and lane read them left-to-right. */
function sortedByTime(events: readonly TimelineEvent[]): readonly TimelineEvent[] {
  return [...events].sort((a, b) => a.time - b.time);
}

/** Adds a burst event (`count` particles at once) at time `time` on emitter `id`. Returns its id. */
export function addBurstEvent(
  store: Store,
  id: string,
  time: number,
  count: number = DEFAULT_BURST_COUNT,
): string {
  const event: TimelineEvent = {
    id: nextIdentifier("event"),
    kind: "burst",
    time: snapTime(store.getSource(), time),
    count: Math.max(0, Math.round(count)),
  };
  updateEvents(store, id, (events) => sortedByTime([...events, event]));
  return event.id;
}

/** Adds a play event (emit at `rate`/s for `duration`s) at time `time` on emitter `id`. Returns its id. */
export function addPlayEvent(
  store: Store,
  id: string,
  time: number,
  rate: number = DEFAULT_PLAY_RATE,
  duration: number = DEFAULT_PLAY_DURATION,
): string {
  const event: TimelineEvent = {
    id: nextIdentifier("event"),
    kind: "play",
    time: snapTime(store.getSource(), time),
    rate: Math.max(0, rate),
    duration: snapDuration(store.getSource(), duration),
  };
  updateEvents(store, id, (events) => sortedByTime([...events, event]));
  return event.id;
}

/** A partial edit of an event's numeric fields; only those valid for its kind are applied. */
interface EventPatch {
  readonly time?: number;
  readonly count?: number;
  readonly rate?: number;
  readonly duration?: number;
}

/** Applies `patch` to event `eventId` on emitter `id`, re-sorting by time. No-op if unknown. */
export function updateEvent(
  store: Store,
  id: string,
  eventId: string,
  patch: EventPatch,
  live = false,
): void {
  const source = store.getSource();
  // Time and duration snap to the frame grid; count/rate pass through to the clamp in patchEvent.
  const snapped: EventPatch = {
    ...patch,
    ...(patch.time !== undefined ? { time: snapTime(source, patch.time) } : {}),
    ...(patch.duration !== undefined ? { duration: snapDuration(source, patch.duration) } : {}),
  };
  updateEvents(
    store,
    id,
    (events) =>
      sortedByTime(
        events.map((event) => (event.id === eventId ? patchEvent(event, snapped) : event)),
      ),
    live,
  );
}

/** Removes event `eventId` from emitter `id`. No-op if nothing matches. */
export function removeEvent(store: Store, id: string, eventId: string): void {
  updateEvents(store, id, (events) => events.filter((event) => event.id !== eventId));
}

/** Merges `patch` onto `event`, clamping and keeping only the fields its kind carries. */
function patchEvent(event: TimelineEvent, patch: EventPatch): TimelineEvent {
  const time = patch.time !== undefined ? Math.max(0, patch.time) : event.time;
  if (event.kind === "burst") {
    return {
      ...event,
      time,
      count: patch.count !== undefined ? Math.max(0, Math.round(patch.count)) : event.count,
    };
  }
  return {
    ...event,
    time,
    rate: patch.rate !== undefined ? Math.max(0, patch.rate) : event.rate,
    duration: patch.duration !== undefined ? Math.max(0, patch.duration) : event.duration,
  };
}

/** A retime of one timeline item (keyframe or event) to a new time `time`. */
export interface TimelineMove {
  readonly id: string;
  readonly time: number;
}

/**
 * Retimes a batch of Timeline Value keyframes on `entity` in a single commit (drag-move / inspector
 * frame edit of a multi-item selection); tracks re-sort. Ids with no match are ignored.
 */
export function moveTrackKeyframes(
  store: Store,
  entity: SceneEntity,
  moves: readonly TimelineMove[],
  live = false,
): void {
  if (moves.length === 0) {
    return;
  }
  const times = new Map(moves.map((move) => [move.id, snapTime(store.getSource(), move.time)]));
  updateTracks(store, entity, (tracks) => retimeKeys(tracks, times), live);
}

/**
 * Retimes a batch of spawn events on emitter `id` in a single commit; events re-sort. Ids with no
 * match are ignored. Emitter-only - a VFX mesh has no spawn events.
 */
export function moveEvents(store: Store, id: string, moves: readonly TimelineMove[]): void {
  if (moves.length === 0) {
    return;
  }
  const source = store.getSource();
  const total = source.timeline.duration;
  const times = new Map(moves.map((move) => [move.id, snapTime(source, move.time)]));
  updateEvents(store, id, (events) =>
    [...events]
      .map((event) => {
        const next = times.get(event.id);
        if (next === undefined) {
          return event;
        }
        // A finite play moved past the timeline end loses its real overflow, not just the visual.
        // Never clip to 0 (that reads as infinite), so skip when the remainder collapses.
        if (event.kind === "play" && event.duration > 0) {
          const clipped = snapDuration(source, total - next);
          if (clipped > 0 && clipped < event.duration) {
            return { ...event, time: next, duration: clipped };
          }
        }
        return { ...event, time: next };
      })
      .sort((a, b) => a.time - b.time),
  );
}

/** Sets the scene timeline length (seconds), floored at {@link MIN_DURATION}. */
export function setTimelineDuration(store: Store, duration: number, live = false): void {
  if (!Number.isFinite(duration)) {
    return;
  }
  const source: SourceState = store.getSource();
  const next = Math.max(MIN_DURATION, duration);
  // Skipping a no-op is only safe for a live (intermediate) call - a final, non-live call must
  // always commit even when `next` already matches the live-applied `source`, or the gesture's
  // one real commit (which promotes history's stale pre-gesture `present`) would be silently
  // dropped, leaving the whole drag with no undo entry at all.
  if (live && next === source.timeline.duration) {
    return;
  }
  commitSource(store, { ...source, timeline: { ...source.timeline, duration: next } }, live);
}

/** Sets the timeline frame rate (whole frames/second), floored at {@link MIN_FPS}. */
export function setTimelineFps(store: Store, fps: number, live = false): void {
  if (!Number.isFinite(fps)) {
    return;
  }
  const source: SourceState = store.getSource();
  const next = Math.max(MIN_FPS, Math.round(fps));
  // See setTimelineDuration's identical guard for why this only short-circuits a live call.
  if (live && next === source.timeline.fps) {
    return;
  }
  commitSource(store, { ...source, timeline: { ...source.timeline, fps: next } }, live);
}
