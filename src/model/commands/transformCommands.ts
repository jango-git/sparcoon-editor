/**
 * Transform edits for a scene entity: base transform + channel keyframes. All commit `"view"` (never
 * recompiled). {@link setEntityBaseChannel} (gizmo/panel) never keyframes - only explicit actions do.
 */

import type {
  EmitterDoc,
  Keyframe,
  SceneModel,
  SourceState,
  VfxDoc,
  VfxMeshDoc,
} from "../editorState";
import type { SceneEntity } from "../entity";
import {
  cloneValue,
  removeKeyById,
  retimeKeys,
  setKeyValueById,
  snapTime,
  withKey,
} from "../keyframeTrackOps";
import type { Store } from "../store";
import {
  IDENTITY_QUAT,
  sampleTransform,
  type Quat,
  type Transform,
  type TransformChannel,
  type TransformTrack,
  type Vec3,
} from "../transform";
import { nextIdentifier } from "./identifier";

/** A channel value: a vec3 for position/scale, a quaternion for rotation. */
export type ChannelValue = Vec3 | Quat;

/** The transform + tracks of one entity - the slice a transform command reads and rewrites. */
interface EntityTransform {
  readonly transform: Transform;
  readonly transformTracks: readonly TransformTrack[];
}

/**
 * Applies `update` to whichever entity `entity` names, committing the result as a view edit.
 * `live: true` (an intermediate step of a scrub/drag control) commits through `Store.commitLive`
 * instead, so a whole drag gesture costs undo history exactly one entry, not one per step.
 */
function updateEntity(
  store: Store,
  entity: SceneEntity,
  update: (current: EntityTransform) => EntityTransform,
  live = false,
): void {
  const source = store.getSource();
  const scene = source.scene;
  if (entity.kind === "vfx") {
    const vfx: VfxDoc = { ...scene.vfx, ...update(scene.vfx) };
    commit(store, source, { ...scene, vfx }, live);
    return;
  }
  if (entity.kind === "vfxMesh") {
    if (!scene.meshes.some((mesh) => mesh.id === entity.id)) {
      return;
    }
    const meshes = scene.meshes.map((mesh): VfxMeshDoc =>
      mesh.id === entity.id ? { ...mesh, ...update(mesh) } : mesh,
    );
    commit(store, source, { ...scene, meshes }, live);
    return;
  }
  if (!scene.emitters.some((emitter) => emitter.id === entity.id)) {
    return;
  }
  const emitters = scene.emitters.map((emitter): EmitterDoc =>
    emitter.id === entity.id ? { ...emitter, ...update(emitter) } : emitter,
  );
  commit(store, source, { ...scene, emitters }, live);
}

function commit(store: Store, source: SourceState, scene: SceneModel, live = false): void {
  if (live) {
    store.commitLive({ ...source, scene }, "view");
  } else {
    store.commit({ ...source, scene }, "view");
  }
}

/** Writes one channel of a base transform. */
function withBaseChannel(
  transform: Transform,
  channel: TransformChannel,
  value: ChannelValue,
): Transform {
  switch (channel) {
    case "position":
      return { ...transform, position: [value[0], value[1], value[2]] };
    case "scale":
      return { ...transform, scale: [value[0], value[1], value[2]] };
    case "rotation":
      return { ...transform, rotation: (value.length >= 4 ? [...value] : IDENTITY_QUAT) as Quat };
  }
}

/** Bakes `value` at time `t` on `entity`'s `channel` track (creating the track on first key). */
export function withTrackKey(
  tracks: readonly TransformTrack[],
  channel: TransformChannel,
  key: Keyframe,
): readonly TransformTrack[] {
  const existing = tracks.find((track) => track.channel === channel);
  if (existing === undefined) {
    return [...tracks, { channel, keys: [key] }];
  }
  return tracks.map((track) =>
    track.channel === channel ? { ...track, keys: withKey(track.keys, key) } : track,
  );
}

/**
 * Poses `entity`'s `channel` base transform to `value` (the gizmo / viewport panel edit). Never
 * keyframes - keys are added only explicitly (`I` shortcut / right-click menu).
 */
export function setEntityBaseChannel(
  store: Store,
  entity: SceneEntity,
  channel: TransformChannel,
  value: ChannelValue,
  live = false,
): void {
  updateEntity(
    store,
    entity,
    (current) => ({
      ...current,
      transform: withBaseChannel(current.transform, channel, value),
    }),
    live,
  );
}

/** The current effective value of `channel` for a sampled transform. */
function channelValue(transform: Transform, channel: TransformChannel): ChannelValue {
  switch (channel) {
    case "position":
      return transform.position;
    case "scale":
      return transform.scale;
    case "rotation":
      return transform.rotation;
  }
}

/**
 * Inserts keyframes for `channels` on `entity` at `time`, each from its current effective transform
 * under the caret (the `I` shortcut / right-click "insert key" menu). One history entry.
 */
export function insertTransformKeyframes(
  store: Store,
  entity: SceneEntity,
  time: number,
  channels: readonly TransformChannel[],
): void {
  if (channels.length === 0) {
    return;
  }
  const source = store.getSource();
  const snappedTime = snapTime(source, time);
  updateEntity(store, entity, (current) => {
    const effective = sampleTransform(current.transform, current.transformTracks, snappedTime);
    let tracks = current.transformTracks;
    for (const channel of channels) {
      const key: Keyframe = {
        id: nextIdentifier("key"),
        time: snappedTime,
        value: cloneValue(channelValue(effective, channel)),
      };
      tracks = withTrackKey(tracks, channel, key);
    }
    return { ...current, transformTracks: tracks };
  });
}

/** Explicitly bakes a keyframe on `entity`'s `channel` at time `time` (the timeline's add-key action). */
export function setTransformKeyframe(
  store: Store,
  entity: SceneEntity,
  channel: TransformChannel,
  time: number,
  value: ChannelValue,
): void {
  const source = store.getSource();
  const key: Keyframe = {
    id: nextIdentifier("key"),
    time: snapTime(source, time),
    value: cloneValue(value),
  };
  updateEntity(store, entity, (current) => ({
    ...current,
    transformTracks: withTrackKey(current.transformTracks, channel, key),
  }));
}

/** Removes transform keyframe `keyId` from `entity` (dropping a channel track left with no keys). */
export function removeTransformKeyframe(store: Store, entity: SceneEntity, keyId: string): void {
  updateEntity(store, entity, (current) => ({
    ...current,
    transformTracks: removeKeyById(current.transformTracks, keyId),
  }));
}

/** Sets transform keyframe `keyId`'s value in place (the inspector's value editor). */
export function setTransformKeyframeValue(
  store: Store,
  entity: SceneEntity,
  keyId: string,
  value: ChannelValue,
  live = false,
): void {
  updateEntity(
    store,
    entity,
    (current) => ({
      ...current,
      transformTracks: setKeyValueById(current.transformTracks, keyId, cloneValue(value)),
    }),
    live,
  );
}

/** A retime of one transform keyframe. */
export interface TransformKeyMove {
  readonly id: string;
  readonly time: number;
}

/** Retimes a batch of transform keyframes on `entity` in one commit (the timeline drag-move). */
export function moveTransformKeyframes(
  store: Store,
  entity: SceneEntity,
  moves: readonly TransformKeyMove[],
  live = false,
): void {
  if (moves.length === 0) {
    return;
  }
  const source = store.getSource();
  const times = new Map(moves.map((move) => [move.id, snapTime(source, move.time)]));
  updateEntity(
    store,
    entity,
    (current) => ({
      ...current,
      transformTracks: retimeKeys(current.transformTracks, times),
    }),
    live,
  );
}

/** Adds/removes `channel` from a live-channels list, keeping it deduped. */
function withLiveChannel(
  channels: readonly TransformChannel[],
  channel: TransformChannel,
  live: boolean,
): readonly TransformChannel[] {
  const without = channels.filter((candidate) => candidate !== channel);
  return live ? [...without, channel] : without;
}

/**
 * Marks `entity`'s `channel` "live" (excluded from the TS export, see `EmitterDoc.liveChannels`) or
 * not - independent of keyframes. No-op for the VFX group (unconditionally live, see `VfxDoc`).
 */
export function setLiveChannel(
  store: Store,
  entity: SceneEntity,
  channel: TransformChannel,
  live: boolean,
): void {
  const source = store.getSource();
  const scene = source.scene;
  if (entity.kind === "vfxMesh") {
    if (!scene.meshes.some((mesh) => mesh.id === entity.id)) {
      return;
    }
    const meshes = scene.meshes.map((mesh) =>
      mesh.id === entity.id
        ? { ...mesh, liveChannels: withLiveChannel(mesh.liveChannels, channel, live) }
        : mesh,
    );
    store.commit({ ...source, scene: { ...scene, meshes } }, "view");
    return;
  }
  if (entity.kind !== "emitter" || !scene.emitters.some((emitter) => emitter.id === entity.id)) {
    return;
  }
  const emitters = scene.emitters.map((emitter) =>
    emitter.id === entity.id
      ? { ...emitter, liveChannels: withLiveChannel(emitter.liveChannels, channel, live) }
      : emitter,
  );
  store.commit({ ...source, scene: { ...scene, emitters } }, "view");
}
