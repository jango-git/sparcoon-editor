/**
 * The preview's right-click menu: a bare right-click (no drag - a drag is an orbit pan) in the
 * preview opens a menu to insert a keyframe for the selected object's position, rotation or scale
 * separately, or all three at once. The keys are baked at the current playhead from the object's
 * effective transform (same path as the `I` shortcut).
 */

import { t } from "../../i18n";
import { insertTransformKeyframes, TRANSFORM_CHANNELS } from "../../model/commands";
import type { SelectionStore } from "../../model/selectionStore";
import type { Store } from "../../model/store";
import type { TransportStore } from "../../model/transport";
import { openContextMenu } from "../components/contextMenu";

/** Pointer travel (px) past which a right-press is treated as an orbit pan, not a menu click. */
const DRAG_THRESHOLD = 4;

export function installPreviewContextMenu(
  element: HTMLElement,
  store: Store,
  selection: SelectionStore,
  transport: TransportStore,
  isToolActive: () => boolean,
): void {
  let downX = 0;
  let downY = 0;
  let tracking = false;

  element.addEventListener("pointerdown", (event) => {
    // Ignore presses begun on a bubbling overlay (the viewport tab strip) - those pan, not menu.
    const onOverlay =
      event.target instanceof Element && Boolean(event.target.closest(".viewport-transform"));
    tracking = event.button === 2 && !isToolActive() && !onOverlay;
    downX = event.clientX;
    downY = event.clientY;
  });

  element.addEventListener("pointerup", (event) => {
    if (event.button !== 2 || !tracking) {
      return;
    }
    tracking = false;
    // A right-drag panned the camera - don't pop the menu on it; and a modal op owns right-click.
    if (isToolActive()) {
      return;
    }
    if (
      Math.abs(event.clientX - downX) > DRAG_THRESHOLD ||
      Math.abs(event.clientY - downY) > DRAG_THRESHOLD
    ) {
      return;
    }
    const entity = selection.get();
    const time = transport.getTime();
    openContextMenu(event.clientX, event.clientY, [
      {
        label: t("preview.insertPositionKey"),
        run: (): void => insertTransformKeyframes(store, entity, time, ["position"]),
      },
      {
        label: t("preview.insertRotationKey"),
        run: (): void => insertTransformKeyframes(store, entity, time, ["rotation"]),
      },
      {
        label: t("preview.insertScaleKey"),
        run: (): void => insertTransformKeyframes(store, entity, time, ["scale"]),
      },
      {
        label: t("preview.insertAll"),
        run: (): void => insertTransformKeyframes(store, entity, time, TRANSFORM_CHANNELS),
      },
    ]);
  });
}
