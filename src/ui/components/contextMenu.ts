/**
 * A small floating context menu: a list of labelled actions positioned at a screen point,
 * dismissed by an outside click or Escape. Shared by the timeline (right-click a lane) and the
 * preview (right-click to insert a transform keyframe). Reuses the `.timeline-menu` styling.
 */

import { createElement } from "../dom";
import { openPopover } from "../primitives/popover";

export interface ContextMenuItem {
  readonly label: string;
  readonly run: () => void;
}

/** Opens a context menu of `items` at `(x, y)` in client coordinates. */
export function openContextMenu(x: number, y: number, items: readonly ContextMenuItem[]): void {
  let close = (): void => {};
  const menu = createElement(
    "div",
    { className: "timeline-menu" },
    items.map((entry) =>
      createElement("button", {
        className: "timeline-menu__item",
        textContent: entry.label,
        type: "button",
        on: {
          click: () => {
            close();
            entry.run();
          },
        },
      }),
    ),
  );
  // `.timeline-menu` is display:none until shown; the popover measures it to clamp on screen.
  menu.style.display = "block";
  // Anchored to a point (not an element), clamped on screen, and - unlike a dropdown - not
  // dismissed by scroll/resize, matching the old registerDismiss behaviour.
  close = openPopover(menu, { anchor: { x, y }, dismissOnScroll: false }).close;
}
