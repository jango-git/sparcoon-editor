/**
 * Keyframe-track math shared by the timeline (value tracks, keyed by param `name`) and transform
 * commands (channel tracks, keyed by `channel`) - the pure key ops (snap/insert/retime/remove/set) live here once.
 */

import type { Keyframe, SourceState } from "./editorState";
import { snapTimeToFrame } from "./frames";

/** Two keyframe times within this many seconds are the same key (a re-bake replaces it). */
export const KEY_EPSILON = 1e-3;

/** A playhead time snapped to the frame grid and clamped into the timeline `[0, duration]`. */
export function snapTime(source: SourceState, time: number): number {
  const { fps, duration } = source.timeline;
  return Math.min(Math.max(0, snapTimeToFrame(time, fps)), duration);
}

/** A copy of a keyframe value, so a stored key never aliases the caller's live array. */
export function cloneValue(value: number | readonly number[]): number | readonly number[] {
  return typeof value === "number" ? value : value.slice();
}

/** Inserts `key` into `keys` sorted by time, replacing any existing key at the same time. */
export function withKey(keys: readonly Keyframe[], key: Keyframe): readonly Keyframe[] {
  const kept = keys.filter((existing) => Math.abs(existing.time - key.time) > KEY_EPSILON);
  return [...kept, key].sort((a, b) => a.time - b.time);
}

/** A track of keyframes tagged by some discriminator (a param name or a transform channel). */
interface KeyedTrack {
  readonly keys: readonly Keyframe[];
}

/** Rebuilds a track with new keys, carrying its discriminator through verbatim. */
function withKeys<T extends KeyedTrack>(track: T, keys: readonly Keyframe[]): T {
  // The spread copies the discriminator; TS can't prove the result still fits an open `T`.
  return { ...track, keys };
}

/** Removes key `keyId` from every track, dropping any track left with no keys. */
export function removeKeyById<T extends KeyedTrack>(
  tracks: readonly T[],
  keyId: string,
): readonly T[] {
  return tracks
    .map((track) =>
      withKeys(
        track,
        track.keys.filter((key) => key.id !== keyId),
      ),
    )
    .filter((track) => track.keys.length > 0);
}

/** Sets key `keyId`'s value in place across all tracks (the value should already be cloned). */
export function setKeyValueById<T extends KeyedTrack>(
  tracks: readonly T[],
  keyId: string,
  value: number | readonly number[],
): readonly T[] {
  return tracks.map((track) =>
    withKeys(
      track,
      track.keys.map((key) => (key.id === keyId ? { ...key, value } : key)),
    ),
  );
}

/** Retimes keys by id (from `times`), re-sorting only the tracks actually touched. */
export function retimeKeys<T extends KeyedTrack>(
  tracks: readonly T[],
  times: ReadonlyMap<string, number>,
): readonly T[] {
  return tracks.map((track) => {
    const keys = track.keys.map((key) => {
      const next = times.get(key.id);
      return next === undefined ? key : { ...key, time: next };
    });
    const touched = keys.some((key, index) => key !== track.keys[index]);
    return touched
      ? withKeys(
          track,
          [...keys].sort((a, b) => a.time - b.time),
        )
      : track;
  });
}
