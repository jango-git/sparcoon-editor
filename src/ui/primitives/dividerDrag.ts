/**
 * A draggable divider between two panes: the workspace's own splits (panelLayout.ts) and the
 * timeline's label column. The size it drives lives wherever the caller keeps it; this only turns
 * a drag into absolute sizes and holds the resize cursor while it runs.
 */

import { beginPointerDrag } from "./drag";

/**
 * Wires a divider so dragging it along `axis` feeds the moved distance back as an absolute size.
 * `readStart` samples the live size at press; `apply` receives `start + direction * delta` -
 * `direction` flips which way along the axis growth reads as positive, so two dividers can drive
 * the same size from opposite sides.
 */
export function attachDividerDrag(
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
