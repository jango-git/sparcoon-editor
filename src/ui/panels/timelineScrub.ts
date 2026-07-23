/**
 * Playhead scrubbing: pressing the caret seeks the transport by mapping pointer-X through a lane's
 * geometry. Self-contained - touches only the transport and lane geometry, never selection/markers.
 */

import { snapTimeToFrame } from "../../model/frames";
import type { TransportStore } from "../../model/transport";
import { beginPointerDrag } from "../primitives/drag";
import { fractionAcross } from "../primitives/geometry";
import { timeAtFraction } from "./timelineFormat";

export interface ScrubContext {
  /** The rows container; a lane is found under it to map pointer-X to time. */
  readonly rows: HTMLElement;
  readonly transport: TransportStore;
  readonly duration: () => number;
  readonly fps: () => number;
}

/** Begins a playhead scrub from the caret press `down`, seeking as the pointer moves. */
export function beginPlayheadScrub(down: PointerEvent, context: ScrubContext): void {
  if (down.button !== 0) {
    return;
  }
  down.preventDefault();
  down.stopPropagation();
  const lane = context.rows.querySelector<HTMLElement>(".timeline-row__lane");
  if (!lane) {
    return;
  }
  const rectangle = lane.getBoundingClientRect();
  const total = context.duration();
  const seekAt = (clientX: number): void => {
    const time = timeAtFraction(fractionAcross(clientX, rectangle), total);
    context.transport.seek(snapTimeToFrame(time, context.fps()));
  };
  seekAt(down.clientX);
  // No pointer capture: the caret is re-rendered on every seek, so capturing it would bind the
  // gesture to an element that is about to be replaced. Window listeners follow the pointer anyway.
  beginPointerDrag(context.rows, down, { capture: false, onMove: (move) => seekAt(move.clientX) });
}
