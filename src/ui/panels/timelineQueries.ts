/**
 * Source lookups for the timeline: resolve an item's model record and time by id, from the store.
 * Pure reads, so selection/drag/inspector code can map a marker's {@link ItemRef} back to model data.
 */

import type { EditorGraph } from "../../domain/graphModel";
import { timelineValueNames } from "../../domain/nodePalette";
import type { ChannelValue } from "../../model/commands";
import type { AnimationTrack, EmitterDoc, Keyframe, TimelineEvent } from "../../model/editorState";
import type { SceneEntity } from "../../model/entity";
import { selectEntityDoc } from "../../model/selectors";
import type { Store } from "../../model/store";
import { sampleTransform, type TransformChannel, type TransformTrack } from "../../model/transform";
import type { ItemRef } from "./timelineTypes";

export function emitterOf(store: Store, emitterId: string): EmitterDoc | undefined {
  return store.getSource().scene.emitters.find((emitter) => emitter.id === emitterId);
}

/** The emitter id an emitter-owned item (`key` / `event`) refers to, or `undefined` for VFX. */
export function emitterIdOf(ref: ItemRef): string | undefined {
  return ref.entity.kind === "emitter" ? ref.entity.id : undefined;
}

export function findEvent(
  store: Store,
  emitterId: string,
  eventId: string,
): TimelineEvent | undefined {
  return emitterOf(store, emitterId)?.events.find((event) => event.id === eventId);
}

/** The Timeline Value tracks owned by `entity` (an emitter or a VFX mesh; the VFX group has none). */
function tracksOf(store: Store, entity: SceneEntity): readonly AnimationTrack[] {
  const doc = selectEntityDoc(store, entity);
  return doc !== undefined && "tracks" in doc ? doc.tracks : [];
}

/** Locates a Timeline Value keyframe by id across `entity`'s tracks (emitter or mesh). */
export function findKeyframe(
  store: Store,
  entity: SceneEntity,
  keyId: string,
): { track: string; key: Keyframe } | undefined {
  for (const track of tracksOf(store, entity)) {
    const key = track.keys.find((candidate) => candidate.id === keyId);
    if (key !== undefined) {
      return { track: track.name, key };
    }
  }
  return undefined;
}

/** Locates a transform keyframe by id across an entity's channel tracks. */
export function findTransformKey(
  store: Store,
  entity: SceneEntity,
  keyId: string,
): { channel: TransformChannel; key: Keyframe } | undefined {
  const tracks = selectEntityDoc(store, entity)?.transformTracks ?? [];
  for (const track of tracks) {
    const key = track.keys.find((candidate) => candidate.id === keyId);
    if (key !== undefined) {
      return { channel: track.channel, key };
    }
  }
  return undefined;
}

export function itemTime(store: Store, ref: ItemRef): number | undefined {
  if (ref.kind === "transformKey") {
    return findTransformKey(store, ref.entity, ref.id)?.key.time;
  }
  if (ref.kind === "key") {
    return findKeyframe(store, ref.entity, ref.id)?.key.time;
  }
  const emitterId = emitterIdOf(ref);
  return emitterId === undefined ? undefined : findEvent(store, emitterId, ref.id)?.time;
}

/** The effective value of `channel` under the caret (base or sampled), for an add-key action. */
export function channelValueAt(
  base: EmitterDoc["transform"],
  tracks: readonly TransformTrack[],
  channel: TransformChannel,
  time: number,
): ChannelValue {
  const sampled = sampleTransform(base, tracks, time);
  if (channel === "position") {
    return sampled.position;
  }
  if (channel === "scale") {
    return sampled.scale;
  }
  return sampled.rotation;
}

/**
 * One Timeline Value row: `name` comes from a declared `timeline-value` node, or an orphaned track
 * (a deleted/renamed node's leftover keyframes, kept visible). `track` is undefined until keyframed.
 */
export interface TimelineValueRow {
  readonly name: string;
  readonly track: AnimationTrack | undefined;
}

/** Every Timeline Value row an entity should show: declared node names (graph order) first, then any orphaned track names. */
export function timelineValueRows(
  graphs: readonly EditorGraph[],
  tracks: readonly AnimationTrack[],
): readonly TimelineValueRow[] {
  const declared = timelineValueNames(graphs);
  const rows: TimelineValueRow[] = [...declared].map((name) => ({
    name,
    track: tracks.find((track) => track.name === name),
  }));
  for (const track of tracks) {
    if (!declared.has(track.name)) {
      rows.push({ name: track.name, track });
    }
  }
  return rows;
}
