/**
 * The timeline item delta-drag: pressing a marker selects it (shift adds; a selected item keeps the
 * set so the whole selection drags together), then moving the pointer shifts every dragged item by a
 * shared time delta, snapped to frames and clamped so nothing crosses the timeline edges. On release
 * the moves commit, batched per owner. Pure over its {@link ItemDragContext}.
 */

import {
  moveEvents,
  moveTrackKeyframes,
  moveTransformKeyframes,
  type TimelineMove,
  type TransformKeyMove,
} from "../../model/commands";
import { entityKey, type SceneEntity } from "../../model/entity";
import { snapTimeToFrame } from "../../model/frames";
import type { Store } from "../../model/store";
import { beginPointerDrag } from "../primitives/drag";
import { clamp } from "../primitives/math";
import { fraction, rangeSpan, spanFraction } from "./timelineFormat";
import { emitterIdOf, findEvent, itemTime } from "./timelineQueries";
import { DRAG_THRESHOLD, selectionKey, type ItemRef, type Marker } from "./timelineTypes";

export interface ItemDragContext {
  readonly element: HTMLElement;
  readonly store: Store;
  readonly duration: () => number;
  readonly fps: () => number;
  readonly markers: () => readonly Marker[];
  readonly selection: Set<string>;
  /** Repaints marker selection styling + the inspector after the selection set changes. */
  readonly refresh: () => void;
}

/** Begins a delta-drag (or a plain select-click) of the item `ref` from the press `down`. */
export function beginItemDrag(down: PointerEvent, ref: ItemRef, ctx: ItemDragContext): void {
  if (down.button !== 0) {
    return;
  }
  down.preventDefault();
  down.stopPropagation();
  ctx.element.focus({ preventScroll: true });

  const key = selectionKey(ref);
  if (down.shiftKey) {
    if (ctx.selection.has(key)) {
      ctx.selection.delete(key);
    } else {
      ctx.selection.add(key);
    }
  } else if (!ctx.selection.has(key)) {
    ctx.selection.clear();
    ctx.selection.add(key);
  }
  ctx.refresh();

  const lane = ctx.markers().find((marker) => selectionKey(marker.ref) === key)
    ?.element.parentElement;
  const width = lane?.getBoundingClientRect().width ?? 0;
  const total = ctx.duration();
  const dragged = collectDrag(ctx);
  if (dragged.length === 0 || width === 0 || total === 0) {
    return;
  }
  const startTimes = dragged.map((item) => item.startTime);
  const minStart = Math.min(...startTimes);
  const maxStart = Math.max(...startTimes);
  let moved = false;

  const deltaAt = (clientX: number): number => {
    // The lane spans the padded window, so a pixel is rangeSpan/width seconds; the clamp keeps every
    // dragged item inside the authored [0, duration].
    const raw = ((clientX - down.clientX) / width) * rangeSpan(total);
    return clamp(raw, -minStart, total - maxStart);
  };
  // Own the drag flag: an item drag is horizontal, so only X travel past the threshold counts as a
  // move (beginPointerDrag's own threshold is Chebyshev, which a pure-vertical wobble would trip).
  beginPointerDrag(ctx.element, down, {
    capture: false,
    onMove: (move) => {
      if (Math.abs(move.clientX - down.clientX) > DRAG_THRESHOLD) {
        moved = true;
      }
      const delta = deltaAt(move.clientX);
      const windowEnd = fraction(total, total);
      for (const item of dragged) {
        const time = snapTimeToFrame(item.startTime + delta, ctx.fps());
        const timeFraction = fraction(time, total);
        item.element.style.left = `${timeFraction * 100}%`;
        // A dragged finite play stays clipped to the timeline end; an infinite one runs
        // past it, out to the lane edge.
        if (item.playSeconds !== undefined) {
          const span =
            item.playSeconds <= 0
              ? 1 - timeFraction
              : clamp(spanFraction(item.playSeconds, total), 0, windowEnd - timeFraction);
          item.element.style.width = `${span * 100}%`;
        }
      }
    },
    onEnd: (up) => {
      if (!moved) {
        return; // a plain click - selection already applied
      }
      commitDrag(dragged, deltaAt(up.clientX), ctx.store);
    },
  });
}

interface DraggedItem {
  readonly ref: ItemRef;
  readonly element: HTMLElement;
  readonly startTime: number;
  /** For a play event: its emission length (seconds), so the bar can be re-clipped as it moves. */
  readonly playSeconds: number | undefined;
}

/** The selected items to drag, each with its element and starting time (snapshot at grab). */
function collectDrag(ctx: ItemDragContext): DraggedItem[] {
  const output: DraggedItem[] = [];
  for (const marker of ctx.markers()) {
    if (!ctx.selection.has(selectionKey(marker.ref))) {
      continue;
    }
    const startTime = itemTime(ctx.store, marker.ref);
    if (startTime !== undefined) {
      output.push({
        ref: marker.ref,
        element: marker.element,
        startTime,
        playSeconds: playSecondsOf(ctx, marker.ref),
      });
    }
  }
  return output;
}

/** The emission length of a play-event ref (0 = infinite), or undefined for any other item. */
function playSecondsOf(ctx: ItemDragContext, ref: ItemRef): number | undefined {
  if (ref.kind !== "event") {
    return undefined;
  }
  const emitterId = emitterIdOf(ref);
  const event = emitterId === undefined ? undefined : findEvent(ctx.store, emitterId, ref.id);
  return event?.kind === "play" ? event.duration : undefined;
}

/**
 * Commits a finished drag, batched per owner: transform keys via {@link moveTransformKeyframes} and
 * Timeline Value keys via {@link moveTrackKeyframes} (both keyed by entity), spawn events via
 * {@link moveEvents} (keyed by emitter id).
 */
function commitDrag(
  dragged: { ref: ItemRef; startTime: number }[],
  delta: number,
  store: Store,
): void {
  // Transform keys can belong to any entity kind (incl. the VFX group); Timeline Value keys are
  // emitter/mesh only (the VFX group carries no tracks); spawn events are emitter-only.
  const transformKeys = new Map<string, { entity: SceneEntity; moves: TransformKeyMove[] }>();
  const trackKeys = new Map<string, { entity: SceneEntity; moves: TimelineMove[] }>();
  const events = new Map<string, TimelineMove[]>();
  for (const item of dragged) {
    const time = item.startTime + delta;
    if (item.ref.kind === "transformKey") {
      const bucket = transformKeys.get(entityKey(item.ref.entity)) ?? {
        entity: item.ref.entity,
        moves: [],
      };
      bucket.moves.push({ id: item.ref.id, time });
      transformKeys.set(entityKey(item.ref.entity), bucket);
    } else if (item.ref.kind === "key") {
      const bucket = trackKeys.get(entityKey(item.ref.entity)) ?? {
        entity: item.ref.entity,
        moves: [],
      };
      bucket.moves.push({ id: item.ref.id, time });
      trackKeys.set(entityKey(item.ref.entity), bucket);
    } else if (item.ref.entity.kind === "emitter") {
      const moves = events.get(item.ref.entity.id) ?? [];
      moves.push({ id: item.ref.id, time });
      events.set(item.ref.entity.id, moves);
    }
  }
  for (const { entity, moves } of transformKeys.values()) {
    moveTransformKeyframes(store, entity, moves);
  }
  for (const { entity, moves } of trackKeys.values()) {
    moveTrackKeyframes(store, entity, moves);
  }
  for (const [emitterId, moves] of events) {
    moveEvents(store, emitterId, moves);
  }
}
