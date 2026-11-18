/**
 * What an emitter or a mesh keeps per Timeline Value name - its keyframes (`tracks`) and whether it is
 * live (`liveParams`) - exists only while some `timeline-value` node of the entity's graphs declares
 * that name. Every edit that can take a name out of the graphs ends with {@link withPrunedTimelineValues}.
 */

import type { EditorGraph } from "../domain/graphModel";
import { timelineValueNames } from "../domain/nodePalette";
import { type AnimationTrack, emitterGraphs, meshGraphs, type SourceState } from "./editorState";

interface TimelineValueOwner {
  readonly tracks: readonly AnimationTrack[];
  readonly liveParams: readonly string[];
}

/** `entity` with keyframes and live flags only for the names some node of `graphs` declares. */
export function withDeclaredTimelineValues<T extends TimelineValueOwner>(
  entity: T,
  graphs: readonly EditorGraph[],
): T {
  const declared = timelineValueNames(graphs);
  const tracks = entity.tracks.filter((track) => declared.has(track.name));
  const liveParams = entity.liveParams.filter((name) => declared.has(name));
  return tracks.length === entity.tracks.length && liveParams.length === entity.liveParams.length
    ? entity
    : { ...entity, tracks, liveParams };
}

/** {@link withDeclaredTimelineValues} on every emitter and mesh of the scene. */
export function withPrunedTimelineValues(source: SourceState): SourceState {
  const { scene } = source;
  const emitters = scene.emitters.map((emitter) =>
    withDeclaredTimelineValues(emitter, emitterGraphs(emitter)),
  );
  const meshes = scene.meshes.map((mesh) => withDeclaredTimelineValues(mesh, meshGraphs(mesh)));
  const changed =
    emitters.some((emitter, index) => emitter !== scene.emitters[index]) ||
    meshes.some((mesh, index) => mesh !== scene.meshes[index]);
  return changed ? { ...source, scene: { ...scene, emitters, meshes } } : source;
}

/**
 * `entity` after one of its nodes was renamed from `oldName` to `newName` (its graphs already
 * renamed): the keyframes and the live flag go with the node, unless another node still reads
 * `oldName` or `newName` already has its own.
 */
export function withRenamedTimelineValue<T extends TimelineValueOwner>(
  entity: T,
  graphs: readonly EditorGraph[],
  oldName: string,
  newName: string,
): T {
  const taken =
    entity.tracks.some((track) => track.name === newName) || entity.liveParams.includes(newName);
  if (oldName === newName || taken || timelineValueNames(graphs).has(oldName)) {
    return entity;
  }
  return {
    ...entity,
    tracks: entity.tracks.map((track) =>
      track.name === oldName ? { ...track, name: newName } : track,
    ),
    liveParams: entity.liveParams.map((name) => (name === oldName ? newName : name)),
  };
}
