/**
 * Rubber-band (marquee) selection on the timeline: dragging on empty lane draws a screen-space box
 * and selects every marker whose centre falls inside it (shift adds to the current selection); a
 * plain click on empty lane clears it. Pure over its {@link MarqueeContext}.
 */

import { createElement } from "../dom";
import { beginPointerDrag } from "../primitives/drag";
import { pointInBounds } from "../primitives/geometry";
import { DRAG_THRESHOLD, selectionKey, type Marker } from "./timelineTypes";

export interface MarqueeContext {
  readonly element: HTMLElement;
  readonly markers: () => readonly Marker[];
  readonly selection: Set<string>;
  /** Repaints marker selection styling + the inspector after the selection set changes. */
  readonly refresh: () => void;
  /** A plain click on empty lane (no drag): after clearing the selection, seek the caret here. */
  readonly onEmptyClick?: (clientX: number) => void;
}

/** Begins a marquee selection from the empty-lane press `down`. */
export function beginMarquee(down: PointerEvent, ctx: MarqueeContext): void {
  if (down.button !== 0) {
    return;
  }
  down.preventDefault();
  ctx.element.focus({ preventScroll: true });
  const box = createElement("div", { className: "timeline-marquee" });
  document.body.append(box);

  const draw = (move: PointerEvent): void => {
    box.style.left = `${Math.min(down.clientX, move.clientX)}px`;
    box.style.top = `${Math.min(down.clientY, move.clientY)}px`;
    box.style.width = `${Math.abs(move.clientX - down.clientX)}px`;
    box.style.height = `${Math.abs(move.clientY - down.clientY)}px`;
  };

  // No pointer capture: the box lives on the body and the window listeners follow the pointer.
  beginPointerDrag(ctx.element, down, {
    threshold: DRAG_THRESHOLD,
    capture: false,
    onMove: (move) => draw(move),
    onEnd: (up, dragged) => {
      box.remove();
      if (!dragged) {
        // A click on empty lane clears the selection and seeks the caret to that frame.
        ctx.selection.clear();
        ctx.refresh();
        ctx.onEmptyClick?.(up.clientX);
        return;
      }
      if (!up.shiftKey) {
        ctx.selection.clear();
      }
      const bounds = {
        left: Math.min(down.clientX, up.clientX),
        right: Math.max(down.clientX, up.clientX),
        top: Math.min(down.clientY, up.clientY),
        bottom: Math.max(down.clientY, up.clientY),
      };
      for (const marker of ctx.markers()) {
        const rectangle = marker.element.getBoundingClientRect();
        const center = {
          x: rectangle.left + rectangle.width / 2,
          y: rectangle.top + rectangle.height / 2,
        };
        if (pointInBounds(center, bounds)) {
          ctx.selection.add(selectionKey(marker.ref));
        }
      }
      ctx.refresh();
    },
  });
}
