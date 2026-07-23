/**
 * Seeds the id counter above every stable id in an adopted document (startup restore / file
 * import), so freshly minted ids can't collide with and overwrite an existing node/connection/comment.
 */

import type { EditorGraph } from "../../domain/graphModel";
import type { SourceState } from "../editorState";
import type { TransformTrack } from "../transform";
import { isRecord } from "../../util/guards";
import { seedIdentifierCounter } from "./identifier";

export function seedIdentifierCounterFromSource(source: SourceState): void {
  seedIdentifierCounter(collectSourceIds(source));
}

/**
 * Seeds from the RAW (pre-normalization) document: normalizing can itself mint a replacement id
 * (e.g. a missing keyframe `id`), so seeding only afterward would already be too late to prevent a collision.
 */
export function seedIdentifierCounterFromRawSource(raw: unknown): void {
  seedIdentifierCounter(collectStringsDeep(raw));
}

function collectStringsDeep(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStringsDeep);
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...collectStringsDeep(entry)]);
  }
  return [];
}

/** Every node, connection and comment id in the document - ids {@link seedIdentifierCounter} must clear. */
function collectSourceIds(source: SourceState): readonly string[] {
  const ids: string[] = [];
  ids.push(source.scene.vfx.id);
  ids.push(...transformTrackKeyIds(source.scene.vfx.transformTracks));
  for (const emitter of source.scene.emitters) {
    ids.push(emitter.id);
    ids.push(...emitter.events.map((event) => event.id));
    ids.push(...emitter.tracks.flatMap((track) => track.keys.map((key) => key.id)));
    ids.push(...transformTrackKeyIds(emitter.transformTracks));
    for (const graph of [emitter.renderGraph, emitter.behaviorGraph]) {
      ids.push(...graphIds(graph));
    }
  }
  for (const mesh of source.scene.meshes) {
    ids.push(mesh.id);
    ids.push(...mesh.tracks.flatMap((track) => track.keys.map((key) => key.id)));
    ids.push(...transformTrackKeyIds(mesh.transformTracks));
    ids.push(...graphIds(mesh.renderGraph));
  }
  return ids;
}

/** The node, connection and comment ids of one graph. */
function graphIds(graph: EditorGraph): readonly string[] {
  return [
    ...Object.keys(graph.nodes),
    ...graph.connections.map((connection) => connection.id),
    ...graph.comments.map((comment) => comment.id),
  ];
}

/** Every keyframe id across an entity's transform tracks. */
function transformTrackKeyIds(tracks: readonly TransformTrack[]): readonly string[] {
  return tracks.flatMap((track) => track.keys.map((key) => key.id));
}
