/**
 * Timeline copy/paste: a copied item is a plain value snapshot (entity + time + payload), not a
 * reference, so paste re-mints ids and never aliases the originals - the same "detached fragment"
 * shape as the graph's node-paste command, just keyed by time instead of graph position.
 */

import type { EmitterDoc, Keyframe, TimelineEvent, VfxDoc, VfxMeshDoc } from "../editorState";
import type { SceneEntity } from "../entity";
import { cloneValue, snapTime } from "../keyframeTrackOps";
import type { Store } from "../store";
import { withTrackKey } from "./transformCommands";
import type { TransformChannel } from "../transform";
import { nextIdentifier } from "./identifier";
import { sortedByTime, withNamedTrackKey } from "./timelineCommands";

/** A copied Timeline Value keyframe, transform keyframe, or spawn event. */
export type ClipboardTimelineItem =
  | {
      readonly type: "transformKey";
      readonly entity: SceneEntity;
      readonly channel: TransformChannel;
      readonly time: number;
      readonly value: number | readonly number[];
    }
  | {
      readonly type: "key";
      readonly entity: SceneEntity;
      readonly name: string;
      readonly time: number;
      readonly value: number | readonly number[];
    }
  | {
      readonly type: "event";
      /** Always an emitter - the VFX group and meshes have no spawn events. */
      readonly entity: SceneEntity;
      readonly event: TimelineEvent;
    };

/** `item`'s time, whatever its kind - the common ordinate paste shifts by an offset. */
export function clipboardItemTime(item: ClipboardTimelineItem): number {
  return item.type === "event" ? item.event.time : item.time;
}

/** One item as freshly pasted, enough to select it (mirrors {@link ItemRef} without importing it -
 *  model/commands stays UI-agnostic; the shapes are structurally compatible). */
export interface PastedTimelineItem {
  readonly entity: SceneEntity;
  readonly kind: "transformKey" | "key" | "event";
  readonly channel?: TransformChannel;
  readonly id: string;
}

/** The in-progress scene slice being rewritten across a batch of pasted items. */
interface PasteScene {
  vfx: VfxDoc;
  emitters: readonly EmitterDoc[];
  meshes: readonly VfxMeshDoc[];
}

/**
 * Pastes `items` (from {@link ClipboardTimelineItem}) shifted by `timeOffset`, each re-minting its
 * own id so a paste is a structural clone, never a reference to the originals. One commit for the
 * whole batch, so undo removes everything a single Ctrl+V added. An item whose entity no longer
 * exists (deleted since copy) is silently dropped.
 */
export function pasteTimelineItems(
  store: Store,
  items: readonly ClipboardTimelineItem[],
  timeOffset: number,
): readonly PastedTimelineItem[] {
  if (items.length === 0) {
    return [];
  }
  const source = store.getSource();
  const scene: PasteScene = { ...source.scene };
  const pasted: PastedTimelineItem[] = [];

  for (const item of items) {
    const time = snapTime(source, clipboardItemTime(item) + timeOffset);
    const entity = item.entity;
    if (item.type === "transformKey") {
      const key: Keyframe = { id: nextIdentifier("key"), time, value: cloneValue(item.value) };
      if (entity.kind === "vfx") {
        scene.vfx = {
          ...scene.vfx,
          transformTracks: withTrackKey(scene.vfx.transformTracks, item.channel, key),
        };
      } else if (entity.kind === "emitter") {
        const emitterId = entity.id;
        if (!scene.emitters.some((emitter) => emitter.id === emitterId)) {
          continue;
        }
        scene.emitters = scene.emitters.map((emitter): EmitterDoc =>
          emitter.id === emitterId
            ? {
                ...emitter,
                transformTracks: withTrackKey(emitter.transformTracks, item.channel, key),
              }
            : emitter,
        );
      } else {
        const meshId = entity.id;
        if (!scene.meshes.some((mesh) => mesh.id === meshId)) {
          continue;
        }
        scene.meshes = scene.meshes.map((mesh): VfxMeshDoc =>
          mesh.id === meshId
            ? { ...mesh, transformTracks: withTrackKey(mesh.transformTracks, item.channel, key) }
            : mesh,
        );
      }
      pasted.push({ entity, kind: "transformKey", channel: item.channel, id: key.id });
      continue;
    }
    if (item.type === "key") {
      const key: Keyframe = { id: nextIdentifier("key"), time, value: cloneValue(item.value) };
      if (entity.kind === "emitter") {
        const emitterId = entity.id;
        if (!scene.emitters.some((emitter) => emitter.id === emitterId)) {
          continue;
        }
        scene.emitters = scene.emitters.map((emitter): EmitterDoc =>
          emitter.id === emitterId
            ? { ...emitter, tracks: withNamedTrackKey(emitter.tracks, item.name, key) }
            : emitter,
        );
      } else if (entity.kind === "vfxMesh") {
        const meshId = entity.id;
        if (!scene.meshes.some((mesh) => mesh.id === meshId)) {
          continue;
        }
        scene.meshes = scene.meshes.map((mesh): VfxMeshDoc =>
          mesh.id === meshId
            ? { ...mesh, tracks: withNamedTrackKey(mesh.tracks, item.name, key) }
            : mesh,
        );
      } else {
        continue; // the VFX group has no Timeline Value tracks
      }
      pasted.push({ entity, kind: "key", id: key.id });
      continue;
    }
    if (entity.kind !== "emitter") {
      continue;
    }
    const emitterId = entity.id;
    if (!scene.emitters.some((emitter) => emitter.id === emitterId)) {
      continue;
    }
    const id = nextIdentifier("event");
    const event: TimelineEvent = { ...item.event, id, time };
    scene.emitters = scene.emitters.map((emitter): EmitterDoc =>
      emitter.id === emitterId
        ? { ...emitter, events: sortedByTime([...emitter.events, event]) }
        : emitter,
    );
    pasted.push({ entity, kind: "event", id });
  }

  store.commit({ ...source, scene: { ...source.scene, ...scene } }, "view");
  return pasted;
}
