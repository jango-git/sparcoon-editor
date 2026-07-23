/**
 * Assembles the workspace and its draggable dividers. Layout: a top region (preview and graph,
 * split by a vertical resizer), then the middlebar, then a bottom band (the timeline) split from
 * the middlebar by horizontal resizers that set the bottom band's height - one on each of the
 * middlebar's seams, so either can be grabbed. The middlebar itself is never resized (flex: none,
 * no inline height is ever set on it) - both resizers only ever move the boundary between the top
 * region and the bottom band. The bottom band is a single panel (the timeline, also the object
 * outline, one row per object) so it has no vertical divider of its own.
 *
 * Every drag is clamped so a pane can shrink but never collapse, and never grow so far that the
 * opposite pane disappears. Sizes live as inline styles on the panes; CSS holds the defaults.
 */

import { createElement } from "../dom";
import { beginPointerDrag } from "../primitives/drag";
import { clamp } from "../primitives/math";

/** Smallest a dragged pane may become. */
const MIN_PANE = 140;
/** Smallest the pane on the other side of a divider may be squeezed to. */
const MIN_OPPOSITE = 200;

export function createWorkspace(
  preview: HTMLElement,
  graph: HTMLElement,
  timeline: HTMLElement,
  middlebar: HTMLElement,
): HTMLElement {
  const topResizer = createElement("div", { className: "resizer resizer--v" });
  const rowResizerAbove = createElement("div", { className: "resizer resizer--h" });
  const rowResizerBelow = createElement("div", { className: "resizer resizer--h" });

  const top = createElement("div", { className: "region region--top" }, [
    preview,
    topResizer,
    graph,
  ]);
  const bottom = createElement("div", { className: "region region--bottom" }, [timeline]);
  const workspace = createElement("div", { className: "workspace" }, [
    top,
    rowResizerAbove,
    middlebar,
    rowResizerBelow,
    bottom,
  ]);

  // Vertical split: drag sets the preview's width; the graph (flex: 1) takes the rest.
  attachDrag(
    topResizer,
    "x",
    () => preview.getBoundingClientRect().width,
    (width) => {
      // A viewport narrower than MIN_PANE + MIN_OPPOSITE would push max below min; floor it.
      const max = Math.max(MIN_PANE, top.clientWidth - MIN_OPPOSITE);
      preview.style.width = `${clamp(width, MIN_PANE, max)}px`;
    },
    1,
  );

  // Horizontal split: both resizers move the same boundary (the bottom band's height, with the
  // top region absorbing the complement via flex: 1). Dragging down always grows the top region
  // and shrinks the bottom band, regardless of which of the middlebar's two seams is grabbed.
  const applyBottomHeight = (height: number): void => {
    const max = Math.max(MIN_PANE, workspace.clientHeight - MIN_OPPOSITE);
    bottom.style.height = `${clamp(height, MIN_PANE, max)}px`;
  };
  attachDrag(
    rowResizerBelow,
    "y",
    () => bottom.getBoundingClientRect().height,
    applyBottomHeight,
    -1,
  );
  attachDrag(
    rowResizerAbove,
    "y",
    () => bottom.getBoundingClientRect().height,
    applyBottomHeight,
    -1,
  );

  return workspace;
}

/**
 * Wires a divider so dragging it along `axis` feeds the moved distance back as an absolute size.
 * `readStart` samples the live size at press; `apply` receives `start + direction * delta` -
 * `direction` flips which way along the axis growth reads as positive, so two dividers can drive
 * the same size from opposite sides.
 */
function attachDrag(
  handle: HTMLElement,
  axis: "x" | "y",
  readStart: () => number,
  apply: (size: number) => void,
  direction: 1 | -1,
): void {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startSize = readStart();
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    beginPointerDrag(handle, event, {
      onMove: (_move, { deltaX, deltaY }) => {
        const delta = axis === "x" ? deltaX : deltaY;
        apply(startSize + direction * delta);
      },
      onEnd: () => document.body.classList.remove("resizing-x", "resizing-y"),
    });
  });
}
