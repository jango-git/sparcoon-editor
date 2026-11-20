/**
 * Coalesces autosave: a burst of edits schedules one write after a short idle gap, because
 * re-serializing the source on every mouse move would stall the UI. `flush` writes a pending edit
 * at once. Call it on page hide so closing the tab does not lose the last edit.
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
