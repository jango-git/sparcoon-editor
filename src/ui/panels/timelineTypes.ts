/**
 * Shared item identity for the timeline: which model object a rendered marker stands for. Both the
 * panel (selection, drag) and its source-lookup queries key off an {@link ItemRef}.
 */

import { entityKey, type SceneEntity } from "../../model/entity";
import type { TransformChannel } from "../../model/transform";

/** Pointer travel (px) past which a press becomes a drag (move / marquee) rather than a click. */
export const DRAG_THRESHOLD = 3;

/**
 * A timeline item: a Timeline Value keyframe (`key`) or spawn event (`event`) on an emitter, or a
 * transform keyframe (`transformKey`) on any entity (an emitter or the VFX group).
 */
export type ItemKind = "key" | "event" | "transformKey";

/** One timeline item, carrying the {@link SceneEntity} that owns it so commands route correctly. */
export interface ItemRef {
  readonly entity: SceneEntity;
  readonly kind: ItemKind;
  /** The transform channel - only set for `transformKey` items. */
  readonly channel?: TransformChannel;
  readonly id: string;
}

/** One rendered marker: its element and the item it stands for (for selection + hit-testing). */
export interface Marker {
  readonly element: HTMLElement;
  readonly ref: ItemRef;
}

/** Starts a delta-drag of a timeline item (the panel owns the gesture; markers just trigger it). */
export type ItemPointerHandler = (down: PointerEvent, ref: ItemRef) => void;

/** The stable string key identifying an item in the selection set. */
export function selectionKey(ref: ItemRef): string {
  return `${entityKey(ref.entity)}:${ref.kind}:${ref.channel ?? ""}:${ref.id}`;
}
