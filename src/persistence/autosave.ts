/**
 * Coalesces document autosave. A burst of edits (dragging a node, holding a slider, an
 * undo/redo run) schedules one write after a short idle gap instead of a synchronous
 * `localStorage.setItem` per event - a full re-serialize of the source (textures included)
 * on every mouse-move would jank the UI thread. `flush` writes any pending edit immediately;
 * wire it to page-hide so closing the tab mid-gap does not lose the last edit.
 */

export interface Autosave {
  /** Mark the document dirty and (re)arm the idle-gap timer. */
  schedule(): void;
  /** Write immediately if an edit is pending, cancelling the pending timer. */
  flush(): void;
}

export function createAutosave(save: () => void, delayMs = 400): Autosave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) {
      pending = false;
      save();
    }
  };

  const schedule = (): void => {
    pending = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, delayMs);
  };

  return { schedule, flush };
}
