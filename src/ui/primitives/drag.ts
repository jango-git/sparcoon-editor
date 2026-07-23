/**
 * One pointer-drag helper for the whole editor. The `pointerdown -> window move/up -> teardown`
 * dance (with a movement threshold that separates a click from a drag) was hand-rolled 13+ times
 * across graphCanvas, timelinePanel, colorPicker, colorRamp, curveEditor and numberControl - some
 * on `pointer*`, one on `mouse*`. This is the single pointer-based implementation they share.
 */

export interface PointerDragDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface PointerDragOptions {
  /**
   * Chebyshev pixels of movement before it counts as a drag; below it moves are ignored and
   * `onEnd`'s `dragged` is false (a click). Default 0 - the first move already drags.
   */
  readonly threshold?: number;
  /** Capture the pointer so moves that leave `target` still report. Default true. */
  readonly capture?: boolean;
  /** Fired once, when movement first crosses `threshold`. */
  readonly onDragStart?: (event: PointerEvent) => void;
  readonly onMove?: (event: PointerEvent, delta: PointerDragDelta) => void;
  /** Fired on pointerup / pointercancel; `dragged` says whether `threshold` was ever crossed. */
  readonly onEnd?: (event: PointerEvent, dragged: boolean) => void;
}

/**
 * Starts tracking a drag from the `down` event. Returns a disposer that ends it early (without
 * firing `onEnd`) - store it if the owner may be torn down mid-drag.
 */
export function beginPointerDrag(
  target: Element,
  down: PointerEvent,
  options: PointerDragOptions = {},
): () => void {
  const threshold = options.threshold ?? 0;
  const startX = down.clientX;
  const startY = down.clientY;
  let dragging = threshold === 0;

  if (options.capture !== false) {
    try {
      target.setPointerCapture(down.pointerId);
    } catch {
      // Best-effort: the pointer may already be released.
    }
  }

  const stop = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
  };

  const onMove = (event: PointerEvent): void => {
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (!dragging && Math.max(Math.abs(deltaX), Math.abs(deltaY)) > threshold) {
      dragging = true;
      options.onDragStart?.(event);
    }
    if (dragging) {
      options.onMove?.(event, { deltaX, deltaY });
    }
  };

  const onEnd = (event: PointerEvent): void => {
    stop();
    options.onEnd?.(event, dragging);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  return stop;
}
